import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.js"],
    // Pinned, because several tests assert DST behaviour and a zone without DST
    // makes them assert the opposite. A CI runner is UTC and this machine is not,
    // so without this the same suite means two different things in two places.
    env: { TZ: "Africa/Cairo" },
    coverage: {
      provider: "v8",
      include: ["src/domain/**", "src/storage/**"],
      exclude: ["src/domain/index.js"],
      thresholds: { lines: 85, functions: 85, branches: 80, statements: 85 },
    },
  },
});
