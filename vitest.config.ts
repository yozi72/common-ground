import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      // Next's marker package throws outside Next; tests run the server modules directly.
      "server-only": path.resolve(__dirname, "tests/server-only-shim.ts"),
    },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    // Delivery isolation: strips provider credentials, fakes nodemailer/web-push,
    // blocks non-local fetch, refuses a non-local database. See tests/setup.ts.
    setupFiles: ["tests/setup.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: false,
    env: { AI_PROVIDER: "mock" },
  },
});
