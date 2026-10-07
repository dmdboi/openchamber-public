import { defineConfig } from "oxlint";

// General-purpose lint, replacing the former ESLint config for the TS/TSX
// packages. Coverage is intentionally matched to what ESLint enforced so the
// switch introduces no new findings:
//
// - ESLint/TypeScript correctness rules stay on (including no-unused-vars).
// - `react-hooks/rules-of-hooks` and `react-hooks/exhaustive-deps` are the two
//   react-hooks checks ESLint ran, so they are enabled explicitly.
// - `no-unused-expressions` and `no-unsafe-optional-chaining` were not part of
//   the ESLint recommended sets (typescript-eslint disables the latter for TS),
//   so they stay off rather than turning a linter swap into a mass fix.
// - The react plugin's compiler-era rules (refs, set-state-in-effect, …) were
//   never enabled here and are off.
//
// The vendored anti-slop plugin is a separate oxlint run (`bun run
// lint:anti-slop`) because it carries a pre-existing, deliberately-incremental
// backlog; see oxlint.config.ts.
export default defineConfig({
  categories: {
    correctness: "error",
  },
  plugins: ["react", "typescript"],
  ignorePatterns: [
    "**/node_modules/**",
    "**/dist/**",
    "**/build/**",
    "**/out/**",
    "**/ios/**",
    "**/android/**",
    ".agents/**",
    ".claude/**",
    ".opencode/**",
    ".openchamber/**",
    ".tmp/**",
    "patches/**",
    "bun-patches/**",
    "tools/oxlint/anti-slop/**",
    "packages/sdk/examples/**",
    // JavaScript runtimes (api/cli/electron) keep their `node --check` syntax
    // gate instead; they were never covered by ESLint.
    "**/*.js",
    "**/*.mjs",
    "**/*.cjs",
  ],
  rules: {
    "no-unused-expressions": "off",
    "no-unsafe-optional-chaining": "off",
    "react/refs": "off",
    "react/set-state-in-effect": "off",
    "react/preserve-manual-memoization": "off",
    "react/immutability": "off",
    "react/globals": "off",
    "react/purity": "off",
    "react/incompatible-library": "off",
    "react/static-components": "off",
    "react/set-state-in-render": "off",
    "react/no-did-update-set-state": "off",
    "react/jsx-key": "off",
    "react-hooks/rules-of-hooks": "error",
    "react-hooks/exhaustive-deps": "error",
  },
});
