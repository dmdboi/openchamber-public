# Shared contracts

## Purpose

This package holds type declarations that more than one OpenChamber runtime
consumes. The UI and the server must agree on the source-control shapes, and the
UI and the VS Code extension host must agree on the Git read shapes, so those
declarations live here instead of one runtime file reaching into another.

## Ownership

- `source-control.ts` owns the source-control shapes: provider identity,
  repository context, bindings, auth status, change requests, issues, CI, and
  the mutation inputs and results built from them.
- `git.ts` owns the Git wire shapes the shared UI and the VS Code extension host
  both answer: status (file, merge and rebase in progress, remote comparison),
  branch list, submodule state, worktree validation, and the worktree identity
  every runtime reports. A field only one runtime reports stays with that
  runtime's adapter.
- `index.ts` re-exports the source-control declarations for the
  `@openchamber/contracts` entry.
- `package.json` exposes `git.ts` at the `@openchamber/contracts/git` subpath,
  separate from the root entry, because the Git shapes are read by UI and VS Code
  only.

These are types only. The package has no runtime entry, no build step, and no
parsing or validation. The server keeps the strict persisted and response
parsers in `packages/api/server/lib/source-control/binding-contract.js`, the
UI keeps its binding lifecycle in
`packages/ui/src/lib/source-control/repository-binding.ts`, and each Git runtime
keeps its own command execution and payload parsing.

## Consumers

- `packages/ui/src/lib/source-control/types.ts` re-exports every source-control
  declaration so the existing `@/lib/source-control/types` import path is
  unchanged, and keeps `effectiveRepositoryBinding`, which turns a binding read
  into the binding a repository acts under. That helper is UI behavior, not a
  shared shape, so it stays with the UI.
- `packages/ui/src/lib/api/types.ts` imports the Git base shapes from
  `@openchamber/contracts/git` and extends them with the UI's optional
  `aheadBase`, `upstreamComparison`, `attentionReason`, `defaultBranches` and
  `provenance` fields. The extension host returns the narrower shared base, so
  those fields stay optional instead of being asserted present.
- `packages/vscode/src/gitService.ts` and its `gitPathDiff.ts` import the same
  Git shapes and keep only the VS Code-specific fields (`directoryCreated`,
  `bootstrapStatus`, `sourceFetchFailed`) on `GitWorktreeInfo`.
- `packages/api/server/lib/source-control/binding-contract.d.ts` imports the
  binding and repository context shapes directly from `@openchamber/contracts`.

A type here is a shape, not authority. Readiness, revision checks, and
credential resolution stay with the code that owns them.
