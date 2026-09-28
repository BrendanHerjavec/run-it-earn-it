import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "src") } },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    setupFiles: ["tests/setup.ts"],
    // Each test file gets its own in-memory PGlite; files run in separate workers.
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
