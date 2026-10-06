# Git hooks

`bun run hooks:install` points this clone's `core.hooksPath` at the committed
`.githooks/` directory. The only hook there is `pre-commit`, which runs
`scripts/hooks/pre-commit.mjs`. Installing dependencies does not enable it;
opting in is deliberate.

## What the pre-commit hook checks

It reads the staged changeset and checks only those files, so the cost tracks
the size of the commit rather than the size of the repository.

| Staged file | Check |
| --- | --- |
| `.ts`, `.tsx` inside a package lint scope | ESLint with the repository config |
| `.js`, `.mjs`, `.cjs` | `node --check` |
| `.json` | `JSON.parse` |
| `.jsonc`, `knip.json`, `tsconfig*.json`, `jsconfig*.json`, `.vscode/*.json` | the TypeScript JSONC parser, which accepts comments and trailing commas |
| `.sh`, `.bash`, and files without an extension that start with a sh or bash shebang | `sh -n` or `bash -n`, chosen from the shebang |
| `.yml`, `.yaml` | parsed with the `yaml` package |
| `.test.*`, `.spec.*`, `*.vitest.tsx` | the package's test runner, see below |

The lint scopes are the directories each package's `lint` script covers:
`packages/sdk/{src,examples,tests}`, `packages/ui/src`,
`packages/vscode/{src,webview,tests}` and `packages/web/{src,tests}`. Electron lints nothing. TypeScript outside them, such as
`tools/oxlint` or the root `vite.config.ts`, is not linted on commit, because CI
does not lint it either. Keep `LINT_SCOPES` in `pre-commit.mjs` in step with
those scripts.

Files inside `node_modules`, `dist`, `dist-bundle`, `build`, `out`, `ios` and
`android` are skipped, as are formats no check covers. A staged deletion is
skipped too: `git diff --cached --diff-filter=ACMR` leaves deletions out of the
list.

## Staged tests

A staged test file runs with the runner its package uses, and only that file.

- Web tests, including the `bun:test` files the web Vitest config maps to its
  shim, run through `packages/web` and its Vitest config.
- Every other test file runs through `scripts/run-isolated-tests.mjs --files`,
  which picks Bun or Node from the file's imports and runs it from the nearest
  `package.json` directory. Each file keeps its own process.

The UI `*.vitest.tsx` files belong to the web Vitest config, so they run there
too. A file whose imports name no runner is an error, not a silent skip.

## What it does not check

It does not run the anti-slop linter or a full package lint, and it runs only
the staged test files rather than a package's suite. Those live on
`bun run lint`, `bun run lint:anti-slop` and `bun run test`. The anti-slop
backlog is handled as its own work.

## Partially staged files

Lint and syntax checks read a partially staged file from the index, so they
check exactly what the commit contains. ESLint receives it through `--stdin`
under its real path, and `node --check` receives it through stdin with the
module type taken from the extension or the nearest `package.json`.

Tests cannot run from the index: a test file imports other files from disk. A
partially staged test file runs against its working-tree copy, and the hook
lists those files. Stage everything, or stash the unstaged part, when you want
the tests to match exactly what you commit.

## Install, force, uninstall

`bun run hooks:install` is idempotent: it sets `core.hooksPath` to `.githooks`
the first time and reports that it is already set afterwards. If
`core.hooksPath` already points somewhere else, for example at Husky, the
installer refuses to replace it and asks for `--force` when that is really what
you want.

```bash
bun run hooks:install                          # set it up
node scripts/hooks/install-hooks.mjs --force   # replace a different hooks path
git config --unset core.hooksPath              # turn it off
```

Hooks run through `node`, which the repository already requires.

## Files

- `.githooks/pre-commit`: the shell entrypoint git runs.
- `scripts/hooks/pre-commit.mjs`: staged-file selection, dispatch and checks.
- `scripts/run-isolated-tests.mjs`: runs Bun and Node test files one process at
  a time; `--files` is the explicit mode the hook uses.
- `scripts/hooks/install-hooks.mjs`: the installer.
- `scripts/run-isolated-tests.test.mjs` and `scripts/hooks/*.test.mjs`: tests
  for explicit-file mode, classification, dispatch and installation.
