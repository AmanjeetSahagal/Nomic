import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@nomic/core": path.resolve(__dirname, "packages/core/src/index.ts")
    }
  },
  test: {
    environment: "node",
    include: ["packages/**/*.test.ts"],
    exclude: ["**/dist/**", "**/node_modules/**"]
  }
});
