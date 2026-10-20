import { defineConfig } from "vitest/config";
import path from "node:path";

// Separate config so the API-calling probe never runs under `npm test`.
export default defineConfig({
  resolve: { alias: { "@": path.resolve(__dirname, "src"), "server-only": path.resolve(__dirname, "tests/server-only-shim.ts") } },
  test: { include: ["scripts/probe/**/*.probe.ts"], testTimeout: 300_000 },
});
