import os from "node:os";

export function lanAddresses(): string[] {
  const found: string[] = [];
  for (const addrs of Object.values(os.networkInterfaces())) {
    if (!addrs) continue;
    for (const addr of addrs) {
      if (addr.internal || addr.family !== "IPv4") continue;
      if (addr.address.startsWith("169.254.")) continue;
      found.push(addr.address);
    }
  }
  return found;
}

export function isLoopback(ip: string | undefined): boolean {
  if (!ip) return false;
  const cleaned = ip.replace(/^::ffff:/, "");
  return cleaned === "127.0.0.1" || cleaned === "::1" || cleaned === "localhost";
}
