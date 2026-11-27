import { defineConfig } from "vitest/config";

export default defineConfig({
  // tsconfig keeps JSX for Next.js to compile; tests need it transformed.
  esbuild: { jsx: "automatic" },
  test: {
    include: ["test/**/*.test.{ts,tsx}"],
    environment: "node",
  },
});
