# @openchamber/cli

OpenChamber's command-line interface. This workspace package is private in this
public fork; it is not currently published.

The CLI starts the API server from `@openchamber/api` and gives it the UI build
of `@openchamber/web` through `OPENCHAMBER_DIST_DIR`. Both are resolved by
package name, never by sibling path. An `OPENCHAMBER_DIST_DIR` already in the
environment wins. User-facing command
behavior and output contracts are documented in `bin/lib/DOCUMENTATION.md`.
