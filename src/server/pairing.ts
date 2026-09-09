import { randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

interface AuthStore {
  pin: string;
  tokens: string[];
}

const dir = path.join(os.homedir(), ".local-remote");
const file = path.join(dir, "auth.json");

function load(): AuthStore {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as AuthStore;
    if (raw.pin && Array.isArray(raw.tokens)) return raw;
  } catch {
    /* first run */
  }
  return { pin: String(randomInt(100000, 999999)), tokens: [] };
}

function save(store: AuthStore) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(store, null, 2), "utf8");
}

const store = load();
save(store);

export function currentPin(): string {
  return store.pin;
}

export function rotatePin(): string {
  store.pin = String(randomInt(100000, 999999));
  save(store);
  return store.pin;
}

export function pair(pin: string): string | null {
  const expected = Buffer.from(store.pin);
  const got = Buffer.from(String(pin ?? "").trim());
  if (expected.length !== got.length || !timingSafeEqual(expected, got)) {
    return null;
  }
  const token = randomBytes(24).toString("base64url");
  store.tokens.push(token);
  save(store);
  return token;
}

export function isValidToken(token: string | undefined | null): boolean {
  if (!token) return false;
  return store.tokens.includes(token);
}

export function revokeAll() {
  store.tokens = [];
  rotatePin();
}
