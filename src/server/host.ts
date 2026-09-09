import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import readline from "node:readline";
import type { HostCommand, HostState } from "../shared/types.ts";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");
const script = path.join(root, "src/host/controller.ps1");

const emptyState = (): HostState => ({
  volume: 0,
  muted: false,
  brightness: null,
  sessions: [],
  activeId: null,
});

export class HostController {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private last = emptyState();
  private restarting = false;
  private art = new Map<string, string>();
  private waiters: Array<{
    resolve: (state: HostState) => void;
    reject: (error: unknown) => void;
  }> = [];

  constructor() {
    this.start();
  }

  get busy(): boolean {
    return this.waiters.length > 0;
  }

  snapshot(): HostState {
    return this.last;
  }

  exec(command: HostCommand): Promise<HostState> {
    const run = () => this.send(command);
    const next = this.chain.then(run, run);
    this.chain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  stop() {
    this.proc?.kill();
    this.proc = null;
  }

  private start() {
    const proc = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script],
      { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
    );
    this.proc = proc;

    const rl = readline.createInterface({ input: proc.stdout });
    rl.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed.startsWith("{")) {
        if (trimmed) console.error("[host]", trimmed);
        return;
      }
      const waiter = this.waiters.shift();
      if (!waiter) return;
      try {
        const parsed = JSON.parse(trimmed) as HostState;
        const rawSessions = Array.isArray(parsed.sessions)
          ? parsed.sessions
          : parsed.sessions
            ? [parsed.sessions]
            : [];
        const sessions = rawSessions.map((session) => {
          if (session.artwork) this.art.set(session.id, session.artwork);
          const artwork = session.artwork ?? this.art.get(session.id) ?? null;
          return { ...session, artwork };
        });
        const liveIds = new Set(sessions.map((session) => session.id));
        for (const id of this.art.keys()) {
          if (!liveIds.has(id)) this.art.delete(id);
        }
        this.last = {
          volume: Number(parsed.volume) || 0,
          muted: Boolean(parsed.muted),
          brightness: parsed.brightness ?? null,
          sessions,
          activeId: parsed.activeId ?? null,
        };
        waiter.resolve(this.last);
      } catch (error) {
        waiter.reject(error);
      }
    });

    proc.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8").trim();
      if (text) console.error("[host]", text);
    });

    proc.on("exit", (code) => {
      for (const waiter of this.waiters) {
        waiter.reject(new Error(`Host process exited (${code ?? "?"})`));
      }
      this.waiters.length = 0;
      this.proc = null;
      if (this.restarting) return;
      this.restarting = true;
      setTimeout(() => {
        this.restarting = false;
        this.start();
      }, 750);
    });
  }

  private send(command: HostCommand): Promise<HostState> {
    const proc = this.proc;
    if (!proc?.stdin.writable) {
      return Promise.reject(new Error("Host is not running"));
    }
    return new Promise<HostState>((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.waiters.findIndex((w) => w.reject === fail);
        if (idx >= 0) this.waiters.splice(idx, 1);
        reject(new Error("Host timed out"));
      }, 20000);
      const ok = (state: HostState) => {
        clearTimeout(timer);
        resolve(state);
      };
      const fail = (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      };
      this.waiters.push({ resolve: ok, reject: fail });
      proc.stdin.write(`${JSON.stringify(command)}\n`, (err) => {
        if (err) fail(err);
      });
    });
  }
}
