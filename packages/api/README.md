# @openchamber/api

OpenChamber's local HTTP server and server-owned capabilities. This workspace
package is private in this public fork; it is not currently published.

The server is started by the CLI and Electron runtime. Browser UI assets and
React runtime adapters remain in `packages/web`.

## TypeScript

The server is being migrated from JavaScript to strict TypeScript one module
family at a time. A migrated family keeps its runtime path: the `.ts` file is
the source, `tsc -p tsconfig.build.json` compiles it in place to the committed
`.js` (and `.d.ts`), and every existing deep import such as
`@openchamber/api/server/lib/tracked-items/items.js` keeps resolving to that
`.js`. Nothing else has to change to consume a migrated family, and the CLI,
Electron main process and Docker image continue to load compiled JavaScript
because Node and Electron cannot execute `.ts` directly.

- `tsconfig.json` type-checks the migrated `.ts` files (`tsc --noEmit`), with
  the surrounding `.js` read for inferred types via `allowJs`.
- `tsconfig.build.json` emits the migrated family next to its source. It sets
  `allowJs: false` so importing a JavaScript module does not make the compiler
  try to re-emit it.
- `pretest` and `build` both run the emit step, so the committed `.js` and the
  tests never run stale output. `bun run --cwd packages/api build` regenerates
  it without running the suite.

The migration starts with `server/lib/tracked-items/`; the rest of the package
is still JavaScript. Do not add a new hand-written `.d.ts` beside a migrated
module: its declarations are generated from the `.ts` source.
