import js from "@eslint/js";
import tseslint from "typescript-eslint";

const noNetUrl = {
  selector: "Literal[value=/^(https?|wss?):/]",
  message: "No absolute network URLs in the viewer (local-only app).",
};

export default tseslint.config(
  { ignores: ["dist/", "node_modules/", "public/", "test-data/"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Local-only app: network I/O goes through src/net.ts (same-origin guard) only.
    files: ["src/**/*.ts"],
    ignores: ["src/**/*.test.ts"],
    rules: {
      "no-restricted-globals": ["error", "XMLHttpRequest", "WebSocket", "EventSource"],
      "no-restricted-syntax": ["error", noNetUrl],
    },
  },
  {
    files: ["src/**/*.ts"],
    ignores: ["src/net.ts", "src/**/*.test.ts"],
    rules: {
      "no-restricted-globals": ["error", "fetch", "XMLHttpRequest", "WebSocket", "EventSource"],
    },
  },
);
