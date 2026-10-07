# @openchamber/contracts

Shared type contracts for OpenChamber runtimes. This workspace package is
private and is not published.

`src/source-control.ts` holds the source-control type declarations that the UI
and the server both reason about, and `src/index.ts` re-exports them.
`src/git.ts` holds Git response shapes shared by the API server, shared UI and
VS Code extension host, exposed at the `@openchamber/contracts/git` subpath.

Every export is a type, so nothing here runs and nothing needs a build step.
The UI re-exports these declarations from
`packages/ui/src/lib/source-control/types.ts`, which keeps the existing
`@/lib/source-control/types` import path working and still owns the
`effectiveRepositoryBinding` helper. The server's
`packages/api/server/lib/source-control/binding-contract.d.ts` imports the same
declarations from `@openchamber/contracts`. The UI's
`packages/ui/src/lib/api/types.ts` and the extension host's
`packages/vscode/src/gitService.ts` extend the Git base shapes with the fields
each runtime adds. The API server is JavaScript, so its adherence to these Git
response types is documented but not checked by TypeScript. The server omits
`sshCommand` from identity responses; VS Code may return it.

Runtime parsing and validation stay with their owners: the server parses and
validates bindings in `binding-contract.js`, and the UI owns its binding reads
and mutations. A type here describes a shape; it does not grant authority.
