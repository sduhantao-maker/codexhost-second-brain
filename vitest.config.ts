import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Node 25+ has its own localStorage, which would hide jsdom's.
    execArgv: ["--no-experimental-webstorage"],
    // No test may reach a model: the model runner refuses every call while this is set. The tests
    // of the runner itself, which run stand-in tools, turn it off for themselves.
    env: { MAINLINE_NO_MODEL: "1" },
  },
});
