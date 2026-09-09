import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import QRCode from "qrcode";
import qrterminal from "qrcode-terminal";
import { WebSocketServer, type WebSocket } from "ws";
import { createServer as createViteServer } from "vite";
import type { BootstrapResponse, HostCommand, HostState } from "../shared/types.ts";
import { HostController } from "./host.ts";
import { appIconPng } from "./icons.ts";
import { isLoopback, lanAddresses } from "./network.ts";
import { currentPin, isValidToken, pair } from "./pairing.ts";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");
const port = Number(process.env.PORT) || 8787;
const host = new HostController();

const sockets = new Set<WebSocket>();
let lastState: HostState = host.snapshot();

function urls(): string[] {
  const ips = lanAddresses();
  const list = ips.map((ip) => `http://${ip}:${port}`);
  if (list.length === 0) list.push(`http://127.0.0.1:${port}`);
  return list;
}

function tokenFromReq(req: http.IncomingMessage, body?: { token?: string }): string | undefined {
  const header = req.headers.authorization;
  if (header?.startsWith("Bearer ")) return header.slice(7);
  const url = new URL(req.url ?? "/", "http://localhost");
  return url.searchParams.get("token") ?? body?.token ?? undefined;
}

function allowed(req: http.IncomingMessage, body?: { token?: string }): boolean {
  if (isLoopback(req.socket.remoteAddress)) return true;
  return isValidToken(tokenFromReq(req, body));
}

function send(res: http.ServerResponse, status: number, data: unknown, extra: Record<string, string> = {}) {
  const payload = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...extra,
  });
  res.end(payload);
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function broadcast(state: HostState) {
  lastState = state;
  const msg = JSON.stringify({ type: "state", state });
  for (const socket of sockets) {
    if (socket.readyState === socket.OPEN) socket.send(msg);
  }
}

async function runCommand(command: HostCommand): Promise<HostState> {
  const state = await host.exec(command);
  broadcast(state);
  return state;
}

function openFirewall() {
  execFile(
    "netsh",
    [
      "advfirewall",
      "firewall",
      "add",
      "rule",
      "name=Local Remote",
      "dir=in",
      "action=allow",
      "protocol=TCP",
      `localport=${port}`,
      "profile=private",
    ],
    () => {
      /* ignore if already exists or needs admin */
    },
  );
}

async function qrSvg(url: string): Promise<string> {
  return QRCode.toString(url, { type: "svg", margin: 1, color: { dark: "#12110e", light: "#0000" } });
}

const icon192 = appIconPng(192);
const icon512 = appIconPng(512);

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://localhost");

    if (url.pathname === "/icons/icon-192.png") {
      res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "public, max-age=86400" });
      res.end(icon192);
      return;
    }
    if (url.pathname === "/icons/icon-512.png") {
      res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "public, max-age=86400" });
      res.end(icon512);
      return;
    }

    if (url.pathname === "/sw.js") {
      res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-cache" });
      fs.createReadStream(path.join(root, "client/public/sw.js")).pipe(res);
      return;
    }
    if (url.pathname === "/manifest.webmanifest") {
      res.writeHead(200, { "Content-Type": "application/manifest+json; charset=utf-8" });
      fs.createReadStream(path.join(root, "client/public/manifest.webmanifest")).pipe(res);
      return;
    }

    if (url.pathname.startsWith("/api/")) {
      if (req.method === "GET" && url.pathname === "/api/bootstrap") {
        const local = isLoopback(req.socket.remoteAddress);
        const paired = local || isValidToken(tokenFromReq(req));
        const payload: BootstrapResponse = {
          paired,
          local,
          urls: urls(),
        };
        if (local) {
          payload.pin = currentPin();
          payload.qrSvg = await qrSvg(urls()[0]!);
        }
        send(res, 200, payload);
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/pair") {
        const body = JSON.parse((await readBody(req)) || "{}") as { pin?: string };
        const token = pair(String(body.pin ?? ""));
        if (!token) {
          send(res, 401, { error: "Wrong PIN" });
          return;
        }
        send(res, 200, { token });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/state") {
        if (!allowed(req)) {
          send(res, 401, { error: "Pair this phone with the PIN shown on your PC" });
          return;
        }
        send(res, 200, lastState);
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/command") {
        const body = JSON.parse((await readBody(req)) || "{}") as HostCommand & { token?: string };
        if (!allowed(req, body)) {
          send(res, 401, { error: "Not paired" });
          return;
        }
        const { token: _token, ...command } = body;
        const state = await runCommand(command as HostCommand);
        send(res, 200, state);
        return;
      }

      send(res, 404, { error: "Not found" });
      return;
    }

    await servePage(req, res);
  } catch (error) {
    console.error(error);
    if (!res.headersSent) send(res, 500, { error: "Server error" });
  }
});

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname !== "/ws") return;
  if (!isLoopback(req.socket.remoteAddress) && !isValidToken(url.searchParams.get("token"))) {
    socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    sockets.add(ws);
    ws.send(JSON.stringify({ type: "state", state: lastState }));
    ws.on("close", () => sockets.delete(ws));
  });
});

let servePage: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>;

if (fs.existsSync(path.join(root, "dist/client/index.html")) && process.env.NODE_ENV === "production") {
  const dist = path.join(root, "dist/client");
  servePage = async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    let filePath = path.join(dist, decodeURIComponent(url.pathname));
    if (url.pathname === "/" || !path.extname(filePath)) {
      filePath = path.join(dist, "index.html");
    }
    if (!filePath.startsWith(dist) || !fs.existsSync(filePath)) {
      filePath = path.join(dist, "index.html");
    }
    const ext = path.extname(filePath);
    const types: Record<string, string> = {
      ".html": "text/html; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".webmanifest": "application/manifest+json",
      ".svg": "image/svg+xml",
      ".png": "image/png",
    };
    res.writeHead(200, { "Content-Type": types[ext] ?? "application/octet-stream" });
    fs.createReadStream(filePath).pipe(res);
  };
} else {
  const vite = await createViteServer({
    configFile: path.join(root, "vite.config.ts"),
    server: { middlewareMode: true, hmr: { server } },
    appType: "spa",
  });
  servePage = async (req, res) => {
    vite.middlewares(req, res, async () => {
      try {
        const template = fs.readFileSync(path.join(root, "client/index.html"), "utf8");
        const html = await vite.transformIndexHtml(req.url ?? "/", template);
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(html);
      } catch (error) {
        vite.ssrFixStacktrace(error as Error);
        res.writeHead(500);
        res.end(String(error));
      }
    });
  };
}

setInterval(() => {
  if (host.busy) return;
  host.exec({ action: "tick" }).then(broadcast).catch(() => undefined);
}, 1000);

openFirewall();
host.exec({ action: "tick" }).then(broadcast).catch(() => undefined);

server.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EADDRINUSE") {
    console.error(`Port ${port} is already in use — Local Remote is probably already running.`);
    process.exit(0);
  }
  throw error;
});

server.listen(port, "0.0.0.0", () => {
  const links = urls();
  const pin = currentPin();
  console.log("");
  console.log("  Local Remote");
  console.log("  ------------");
  console.log(`  On this PC:  http://127.0.0.1:${port}`);
  for (const link of links) console.log(`  On your phone: ${link}`);
  console.log(`  PIN: ${pin}`);
  console.log("");
  console.log("  Scan with your phone:");
  qrterminal.generate(links[0]!, { small: true });
  console.log(`  Leave this window open. Pair once, then Add to Home Screen.`);
  console.log("");
});

process.on("SIGINT", () => {
  host.stop();
  server.close();
  process.exit(0);
});
