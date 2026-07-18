import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 30000,
    hookTimeout: 30000,
    // Each file gets a fresh process so env-based config (mock mode, temp DB) stays isolated.
    pool: "forks",
    isolate: true,
  },
});
