# @openchamber/api

OpenChamber's local HTTP server and server-owned capabilities. This workspace
package is private in this public fork; it is not currently published.

The server is started by the CLI and Electron runtime. Browser UI assets and
React runtime adapters remain in `packages/web`.

This package does not depend on `@openchamber/web`. The server serves the UI
build from `OPENCHAMBER_DIST_DIR`, which its caller sets: the CLI passes the
installed `@openchamber/web` build, Electron passes its staged assets, and the
`packages/web` dev scripts pass `packages/web/dist`. Without it the server
answers browser routes with 404 and keeps serving the API.
