import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");
const startupDir = path.join(
  process.env.APPDATA ?? path.join(os.homedir(), "AppData/Roaming"),
  "Microsoft/Windows/Start Menu/Programs/Startup",
);
const startupScript = path.join(startupDir, "Local Remote.vbs");
const remove = process.argv.includes("--remove");

function vbsQuote(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function vbsCommand(args: string[]): string {
  return vbsQuote(args.map((arg) => `"${arg}"`).join(" "));
}

if (remove) {
  if (fs.existsSync(startupScript)) fs.unlinkSync(startupScript);
  console.log("Local Remote will no longer start with Windows.");
  process.exit(0);
}

const node = process.execPath;
const tsx = path.join(root, "node_modules/tsx/dist/cli.mjs");
const entry = path.join(root, "src/server/index.ts");
if (!fs.existsSync(tsx)) {
  console.error("Run npm install first.");
  process.exit(1);
}

const script = [
  "Set sh = CreateObject(\"WScript.Shell\")",
  `sh.CurrentDirectory = ${vbsQuote(root)}`,
  `sh.Run ${vbsCommand([node, tsx, entry])}, 0, False`,
  "",
].join("\r\n");

fs.mkdirSync(startupDir, { recursive: true });
fs.writeFileSync(startupScript, script, "utf8");

console.log("Local Remote will start in the background when you sign in to Windows.");
console.log(`Startup item: ${startupScript}`);
console.log("Your phone stays paired. Open the home-screen app after the PC is on.");
console.log("To undo: npm run autostart:off");
