import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: ["./src/test-setup-shiprig.ts"],
    // Most tests run real processes (git, and the real shiprig binary), so
    // their time follows the machine's load, not the code under test. The
    // slowest takes about 1.5s on an idle machine; vitest's 5s default left
    // little room, and a busy machine tripped it. 20s still fails a hung
    // test quickly, and the whole suite stays well inside a minute.
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
