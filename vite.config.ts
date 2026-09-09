import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: path.join(root, "client"),
  plugins: [react()],
  resolve: {
    alias: {
      "@shared": path.join(root, "src/shared"),
    },
  },
  build: {
    outDir: path.join(root, "dist/client"),
    emptyOutDir: true,
  },
  server: {
    middlewareMode: true,
  },
  appType: "spa",
});
