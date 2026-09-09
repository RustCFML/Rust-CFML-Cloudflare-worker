# RustCFML Cloudflare Worker

A reference Cloudflare Workers host for **[RustCFML](https://github.com/RustCFML/RustCFML)** — the CFML interpreter written in Rust. Run CFML at the edge as WebAssembly, with sessions, application scope, and `<cfquery>` against your databases via Hyperdrive.

**[Live demo](https://rustcfml-worker.rustcfml.workers.dev)** — this repo, deployed.

> See the **[RustCFML project README](https://github.com/RustCFML/RustCFML#readme)** for the language, engine aims, performance, and full feature list. This repo is the worker-host wiring; it doesn't duplicate that material.

## What this host demonstrates

- **Lazy session storage in Workers KV** (`this.lazySessionCreation`).
- **Durable Object–backed application scope** with strong consistency across regions.
- **Outbound `<cfhttp>`** over the Workers `fetch` API, so a Worker can call a backend API — GET, POST, form posts and multipart file uploads, with the same result struct as the native binary. A file part takes its content from `value=` since there is no filesystem to read a path from. The unlisted `/http.cfm` is a test bench for all four shapes against any URL you point it at.
- **Cron-driven KV tidy-up** that deletes expired session blobs on a configurable schedule. (`onSessionEnd` is deliberately not implemented on this host — see notes below.)
- **`<cfquery>` against Postgres or MySQL via Cloudflare Hyperdrive**, using JSPI to make the underlying async driver look synchronous to CFML. Dispatched through `postgres` (postgres.js) or `mysql2/promise`, selected from the Hyperdrive binding's `connectionString` prefix.
- **An `/echo/` HTTP test server** — an always-on request mirror used by the [RustCFML engine test-suite](https://github.com/RustCFML/RustCFML) to exercise `<cfhttp>` in place of the flaky public `httpbin.org`. See [The `/echo/` HTTP test server](#the-echo-http-test-server) below.

## Layout

| Path | Purpose |
|---|---|
| `src/lib.rs` | Worker entry — `#[event(fetch)]`, `#[event(scheduled)]`, `#[durable_object] ApplicationScopeDO`. |
| `build.rs` | Walks `cfml/` at build time and emits a static `CFML_FILES` table. |
| `cfml/Application.cfc` | Sample app demonstrating `onApplicationStart`, `onSessionStart`, `onSessionEnd`. |
| `cfml/index.cfm` | Sample page reading from session + application scope. |
| `cfml/echo/` | HTTP test server (request mirror, header reflector, status endpoint) for the RustCFML `<cfhttp>` suite. |
| `wrangler.toml` | Bindings + cron trigger. Edit the `<paste-id-here>` placeholders. |

## Getting Started

1. Install `wrangler`, `worker-build`, and the npm dev deps:
   ```bash
   npm i -g wrangler
   cargo install worker-build
   npm install        # pulls in `postgres` and `mysql2` for the JSPI snippet
   ```
2. Provision KV namespaces:
   ```bash
   wrangler kv namespace create SESSIONS   # paste the returned id into wrangler.toml
   wrangler kv namespace create APP
   ```
3. (Optional) Provision Hyperdrive bindings for the databases you want `<cfquery>` to reach. Declare only the engines you actually use.

   Hyperdrive stores the connection string **encrypted on Cloudflare** and hands back an `id`. Only that `id` goes in `wrangler.toml` — the credentials never touch the repo. Let wrangler prompt for the connection string interactively so the password stays out of your shell history:
   ```bash
   wrangler hyperdrive create rustcfml-pg      # prompts for the connection string
   wrangler hyperdrive create rustcfml-mysql
   ```
   (Or pass `--connection-string="postgres://user:pass@host:5432/dbname"` non-interactively in CI, sourcing the value from a secret store rather than typing it inline.)

   Uncomment the matching `[[hyperdrive]]` blocks in `wrangler.toml` and paste the returned ids. CFML datasource names map 1:1 to the binding names (`HYPERDRIVE_PG`, `HYPERDRIVE_MYSQL`).
4. Deploy:
   ```bash
   wrangler deploy
   ```

The deployed result should look like **[rustcfml-worker.rustcfml.workers.dev](https://rustcfml-worker.rustcfml.workers.dev)**.

## How `<cfquery>` works (JSPI architecture)

`#[event(fetch)]` from `worker-macros` is async — `wasm-bindgen-futures` drives the request via a poll loop, with the original wasm fetch call returning a Promise handle to JS long before request work is done. That breaks the contiguous-wasm-stack requirement of `WebAssembly.promising`: Suspending imports invoked from inside the async-driven activation have no promising wrapper above them on the wasm stack and the request hangs.

The fix in `cfml-worker` (introduced for Hyperdrive support):

1. `handle_fetch` stays async. It does all the KV/DO worker-SDK awaits needed to prime session and application scope before the VM runs.
2. The VM execution is split off into a **separate sync wasm export** (`cfml_worker_run_sync` in `cfml_worker::sync_runner`). It pops a `RunContext` staged in a thread-local and runs the VM synchronously.
3. The async handler invokes that export via a JS import that awaits `WebAssembly.promising(wasm.cfml_worker_run_sync)`. That call site is a *fresh* contiguous wasm activation — JSPI gets a clean stack to suspend on when `<cfquery>` hits the Hyperdrive Suspending import.
4. The post-build patch (`jspi-patch.mjs`) installs the promising wrapper on `globalThis.__cfmlJspi.runSync`, bypasses the wasm-bindgen JS adapter for the Suspending import, hoists CommonJS `__require("node:*")` calls into real ESM imports (so `postgres` / `mysql2` bundle under `nodejs_compat`), and wires `setEnv` / `clearEnv` around the fetch entry.

A smoke test at `/__cfml_smoke` bypasses the entire CFML execution and calls the Hyperdrive Suspending directly from a sync wasm activation — handy for isolating JSPI plumbing from CFML semantics when debugging.

## The `/echo/` HTTP test server

The RustCFML engine's `<cfhttp>` test-suite needs a live remote HTTP server to call. It used to hit the public `httpbin.org`, which was flaky (rate limits, downtime) and produced false-red test runs. This worker hosts a purpose-built replacement under `/echo/` — generic, no engine-specific behaviour, and always-on at the edge.

| Endpoint | Behaviour |
|---|---|
| `GET\|POST\|PUT\|PATCH\|DELETE /echo/request.cfm` | Returns a JSON mirror of the request: `{method, url, path, queryString, args, form, headers, cookies, body, userAgent}`. |
| `GET /echo/response-headers.cfm?Name=Value` | Echoes each query param back as a response header of the same name; also returns the map as JSON under `reflected`. |
| `GET /echo/status.cfm?code=NNN` | Responds with the given HTTP status code (default 200) and a `{"status":NNN}` body. |
| `GET /echo/` | Human-readable docs page for the above. |

Try it:

```bash
curl -s https://rustcfml-worker.rustcfml.workers.dev/echo/request.cfm?foo=bar
curl -si https://rustcfml-worker.rustcfml.workers.dev/echo/response-headers.cfm?X-Demo=hi | grep -i x-demo
```

The corresponding test in the engine repo is `tests/stdlib/test_cfhttp.cfm`; it points at the deployed worker and has a reachability guard so it skips (rather than fails) if the endpoints aren't reachable. **After changing anything under `cfml/echo/`, redeploy (`wrangler deploy`) so the engine suite picks it up** — the test asserts against the live deployment, not your local checkout.

## Session tidy-up cadence

The `[triggers] crons` entry in `wrangler.toml` controls how often the worker sweeps expired session blobs from KV. The default is `*/30 * * * *` (every 30 minutes). Tighten or loosen it freely — the only knock-on effect is timeliness of cleanup vs. KV `list` cost.

**`onSessionEnd` is deliberately not implemented.** Firing it from the scheduled handler would require loading Application.cfc and spinning up a VM per expired session, which is heavy and rarely needed in a serverless deployment. If your app needs cleanup semantics:

- Make `onSessionStart` idempotent and recover from cold state there, or
- Write a CFML page that does the cleanup and hit it from a separate cron (e.g. via the `[triggers]` mechanism pointing at a fetch URL).

## Verifying DO-backed application scope

After deploy, hit the worker from two different regions in quick succession (e.g. `curl --resolve` against two PoPs). `application.requestCount` should stay monotonically increasing — that's strong consistency the KV-only path can't guarantee.

## Notes

- This crate is **not** a workspace member because the host is wasm32-only; `cargo build` from the repo root will not pick it up. Build it from this directory.
- The `[build] command = "worker-build --release"` line handles wasm-bindgen output, JSPI wiring (`WebAssembly.promising`), and the JSPI snippet copy from `cfml-worker/src/cfml_jspi.js`. No hand-rolled bootstrap mjs needed.
- For multi-app deployments, append every `this.name` to `config.app_names` in `src/lib.rs`. Each application gets its own DO instance via `idFromName(<app_name>)`.

## License

MIT — same as [RustCFML](https://github.com/RustCFML/RustCFML).
