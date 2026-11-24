import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // Test against the CLI's sources, so it doesn't have to be built first.
    alias: {
      "@contractpulse/cli": fileURLToPath(new URL("../cli/src/lib.ts", import.meta.url)),
    },
  },
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
