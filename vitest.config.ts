import { defineConfig } from "vitest/config";

// Pure helper tests and controller lifecycle regressions run under Node.
// Lifecycle tests stub media APIs; they do not validate real browser audio.
export default defineConfig({
  test: {
    include: ["voice/**/*.test.ts", "client/**/*.test.ts"],
    environment: "node",
  },
});
