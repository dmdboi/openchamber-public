# Shared contracts

## Purpose

This package holds type declarations that more than one OpenChamber runtime
consumes. The UI and server must agree on source-control and Git response
shapes; the VS Code extension host implements the same Git API. Those
declarations live here instead of one runtime reaching into another.

## Ownership

- `source-control.ts` owns the source-control shapes: provider identity,
  repository context, bindings, auth status, change requests, issues, CI, and
  the mutation inputs and results built from them.
- `git.ts` owns Git response shapes shared by the API server, shared UI, and
  VS Code extension host: status, branch list, commit/log/remote and
  merge/rebase results, submodule state, path-unavailable reasons, and worktree
  validation and identity. A field only one runtime reports stays with that
  runtime's adapter.
- `index.ts` re-exports the source-control declarations for the
  `@openchamber/contracts` entry.
- `package.json` exposes `git.ts` at the `@openchamber/contracts/git` subpath,
  separate from the root entry.

These are types only. The package has no runtime entry, no build step, and no
parsing or validation. The server keeps strict persisted binding parsing in
`packages/api/server/lib/source-control/binding-contract.js`; its JavaScript Git
routes produce the documented Git shapes without compile-time checking. The UI
keeps its binding lifecycle in
`packages/ui/src/lib/source-control/repository-binding.ts`, and each Git runtime
keeps its own command execution and payload parsing. The API intentionally omits
`sshCommand` from identity responses; only the VS Code adapter may report it.

## Consumers

- `packages/ui/src/lib/source-control/types.ts` re-exports every source-control
  declaration so the existing `@/lib/source-control/types` import path is
  unchanged, and keeps `effectiveRepositoryBinding`, which turns a binding read
  into the binding a repository acts under. That helper is UI behavior, not a
  shared shape, so it stays with the UI.
- `packages/ui/src/lib/api/types.ts` imports shared Git shapes from
  `@openchamber/contracts/git` and extends the Git base shapes with the UI's optional
  `aheadBase`, `upstreamComparison`, `attentionReason`, `defaultBranches` and
  `provenance` fields. The extension host returns the narrower shared base, so
  those fields stay optional instead of being asserted present.
- `packages/vscode/src/gitService.ts` and its `gitPathDiff.ts` import the same
  Git shapes and keep only the VS Code-specific fields (`directoryCreated`,
  `bootstrapStatus`, `sourceFetchFailed`) on worktree creation results. VS Code
  never reports the shared `untracked_directory` unavailable-path reason.
- Remote URL values are runtime responses, not display-safe by type alone. The
  API redacts them in its route, and the VS Code webview redacts bridge results
  before building repository context or showing them.
- `packages/api/server/lib/source-control/binding-contract.d.ts` imports the
  binding and repository context shapes directly from `@openchamber/contracts`.

A type here is a shape, not authority. Readiness, revision checks, and
credential resolution stay with the code that owns them.
