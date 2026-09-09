// Post-build patch: wrap the wasm `fetch` + `scheduled` exports in
// WebAssembly.promising so that the JSPI Suspending imports
// (cfml_jspi_hyperdrive_query, cfml_jspi_do_fetch, cfml_jspi_http_fetch) can suspend the wasm
// stack, and bypass the wasm-bindgen JS adapter that otherwise hides the
// Suspending from the wasm import object.
//
// Anchored against the worker-build 0.8.x **unminified** output shape
// (NO_MINIFY=1). The build command must set NO_MINIFY so identifiers like
// `wasm`, `addHeapObject`, `takeObject` stay literal.

import { readFileSync, writeFileSync } from "node:fs";

const path = "build/index.js";
let src = readFileSync(path, "utf8");

// ─── 1. Hoist promising wrappers right after the **top-level**
//        wasm-bindgen start call. The other occurrence inside __wbg_init
//        would put the wrappers in function scope — useless. ─────────
const initAnchor =
  "var wasm = wasmInstance.exports;\nwasm.__wbindgen_start();";
if (!src.includes(initAnchor)) {
  console.error(
    "jspi-patch: top-level `var wasm = wasmInstance.exports; wasm.__wbindgen_start();` anchor not found",
  );
  process.exit(1);
}
// `cfml_worker_jspi_smoke` is the wasm-bindgen-exported sync function from
// crates/cfml-worker/src/jspi_smoke.rs. wasm-bindgen wraps the raw export
// for arg marshalling; for JSPI we need the marshalled wrapper because the
// args (u32 ptrs + lens) go through addHeapObject-style coercion. The JS
// wrapper IS sync (no awaits between its entry and the wasm call), so
// wrapping its underlying wasm function with promising still gives a
// contiguous wasm stack from the wrapper call site.
const wrappers =
  "\nvar __jspi_fetch=WebAssembly.promising(wasm.fetch);" +
  "var __jspi_scheduled=WebAssembly.promising(wasm.scheduled);" +
  "var __jspi_smoke=WebAssembly.promising(wasm.cfml_worker_jspi_smoke);" +
  "var __jspi_run_sync=WebAssembly.promising(wasm.cfml_worker_run_sync);" +
  "globalThis.__cfmlJspi=globalThis.__cfmlJspi||{};" +
  // Smoke test entry — bypasses the fetch handler entirely.
  "globalThis.__cfmlJspi.smoke=async function(env){" +
  "  globalThis.__cfmlJspi.setEnv(env);" +
  "  try { await __jspi_smoke(); }" +
  "  finally { globalThis.__cfmlJspi.clearEnv(); }" +
  "  return cfml_worker_jspi_smoke_take();" +
  "};" +
  // The async fetch handler stages a RunContext in a Rust thread-local,
  // then awaits this. We invoke the promising-wrapped sync wasm export
  // from JS so JSPI gets a contiguous wasm stack to suspend on for
  // <cfquery> Suspending imports inside the VM.
  "globalThis.__cfmlJspi.runSync=async function(){await __jspi_run_sync();};";
src = src.replace(initAnchor, initAnchor + wrappers);

// ─── 2. Rewrite fetch / scheduled exports to await the promising wrapper ──
//
// Current (unminified) shape:
//
//   function fetch(req, env, ctx) {
//     let ret;
//     __wbg_call_guard();
//     ret = wasm.fetch(addHeapObject(req), addHeapObject(env), addHeapObject(ctx));
//     return takeObject(ret);
//   }
//
// becomes:
//
//   async function fetch(req, env, ctx) {
//     __wbg_call_guard();
//     return takeObject(await __jspi_fetch(addHeapObject(req), addHeapObject(env), addHeapObject(ctx)));
//   }
function rewriteExport(exportName, promisingVar) {
  const re = new RegExp(
    String.raw`function (` +
      exportName +
      String.raw`)\(([^)]*)\)\s*\{\s*let ret;\s*__wbg_call_guard\(\);\s*ret = wasm\.` +
      exportName +
      String.raw`\((.*?)\);\s*return takeObject\(ret\);\s*\}`,
    "s",
  );
  const m = src.match(re);
  if (!m) {
    console.error(`jspi-patch: no wrapper found for wasm.${exportName}`);
    process.exit(1);
  }
  src = src.replace(
    re,
    `async function ${exportName}(${m[2]}){__wbg_call_guard();return takeObject(await ${promisingVar}(${m[3]}))}`,
  );
  console.log(`jspi-patch: rewrote wasm.${exportName} export → ${promisingVar}`);
}

rewriteExport("fetch", "__jspi_fetch");
rewriteExport("scheduled", "__jspi_scheduled");

// ─── 3. Bypass wasm-bindgen adapter for Suspending imports ──────────
//
// wasm-bindgen emits a thin JS adapter for each snippet import:
//
//   __wbg_cfml_jspi_hyperdrive_query_HASH: function(arg0, ...) {
//     const ret = cfml_jspi_hyperdrive_query(arg0 >>> 0, ...);
//     return ret;
//   },
//
// The wasm import then sees a regular JS function, not the Suspending
// object. The await inside has nowhere to suspend the wasm stack to and
// the whole request hangs. Replace the adapter with a direct reference
// to the Suspending variable.
function bypassAdapter(importName, { required = false } = {}) {
  const re = new RegExp(
    String.raw`(__wbg_` +
      importName +
      String.raw`_[0-9a-f]+):\s*function\([^)]*\)\s*\{\s*const ret = ` +
      importName +
      String.raw`\([^)]*\);\s*return ret;\s*\}`,
    "g",
  );
  let count = 0;
  src = src.replace(re, (_m, fullName) => {
    count++;
    return `${fullName}:${importName}`;
  });
  if (count === 0) {
    if (required) {
      console.error(`jspi-patch: adapter for ${importName} not found`);
      process.exit(1);
    }
    console.log(
      `jspi-patch: adapter for ${importName} absent (tree-shaken) — skipping`,
    );
    return;
  }
  console.log(`jspi-patch: bypassed wasm-bindgen adapter for ${importName}`);
}

bypassAdapter("cfml_jspi_hyperdrive_query", { required: true });
bypassAdapter("cfml_jspi_do_fetch"); // optional — DO path uses plain async
// <cfhttp> transport. Required: handler.rs registers the cfhttp builtin
// unconditionally, so the import is always reachable and never tree-shaken.
// If it ever is, failing loudly beats a Worker whose cfhttp cannot suspend.
bypassAdapter("cfml_jspi_http_fetch", { required: true });

// ─── 3b. Wire setEnv/clearEnv around the Entrypoint.fetch dispatch ──
//
// The JSPI snippet looks up the active env on a `globalThis.__cfmlJspi`
// hook so suspending callbacks (hyperdrive_query / do_fetch) can resolve
// bindings by name. Inject the bracket calls around the wasm fetch call.
const entryFetchAnchor =
  "Entrypoint.prototype.fetch = function fetch2(arg) {\n  return fetch.call(this, arg, this.env, this.ctx);\n};";
const entryFetchReplacement =
  "Entrypoint.prototype.fetch = async function fetch2(arg) {\n" +
  "  try {\n" +
  "    const url = new URL(arg.url);\n" +
  "    if (url.pathname === '/__cfml_smoke') {\n" +
  "      const body = await globalThis.__cfmlJspi.smoke(this.env);\n" +
  "      return new Response(body, { headers: { 'content-type': 'application/json' } });\n" +
  "    }\n" +
  "  } catch (e) {\n" +
  "    return new Response('smoke error: ' + (e && e.stack || e), { status: 500 });\n" +
  "  }\n" +
  "  globalThis.__cfmlJspi && globalThis.__cfmlJspi.setEnv && globalThis.__cfmlJspi.setEnv(this.env);\n" +
  "  try { return await fetch.call(this, arg, this.env, this.ctx); }\n" +
  "  finally { globalThis.__cfmlJspi && globalThis.__cfmlJspi.clearEnv && globalThis.__cfmlJspi.clearEnv(); }\n" +
  "};";
if (!src.includes(entryFetchAnchor)) {
  console.error("jspi-patch: Entrypoint.prototype.fetch anchor not found");
  process.exit(1);
}
src = src.replace(entryFetchAnchor, entryFetchReplacement);
console.log("jspi-patch: wired __cfmlJspi.setEnv around Entrypoint.fetch");

// ─── 4. Rewrite CJS-style __require("node:*") / require("events") etc.
//        to ESM namespace imports ─────────────────────────────────────
//
// esbuild keeps Node built-ins external (since we run with --platform=node)
// but because the source files are CommonJS, it emits `__require("X")`
// instead of a top-level `import * as ns from "X"`. The __require shim
// throws at runtime in Workers ("Dynamic require of ... is not
// supported"). Hoist each distinct external module to a real ESM
// namespace import and rewrite the call sites.
const NODE_BUILTINS = new Set([
  "assert", "async_hooks", "buffer", "child_process", "console", "constants",
  "crypto", "dns", "events", "fs", "http", "http2", "https", "net", "os",
  "path", "perf_hooks", "process", "punycode", "querystring", "readline",
  "stream", "string_decoder", "timers", "tls", "tty", "url", "util", "v8",
  "vm", "worker_threads", "zlib",
]);
const requireRe = /__require\("([^"]+)"\)/g;
const externalMods = new Set();
let m;
while ((m = requireRe.exec(src)) !== null) {
  const mod = m[1];
  const bare = mod.startsWith("node:") ? mod.slice(5) : mod;
  if (NODE_BUILTINS.has(bare)) externalMods.add(mod);
}
if (externalMods.size > 0) {
  // Each `import * as ns from "node:X"` yields a Module namespace with null
  // prototype; CommonJS callers do `buf.hasOwnProperty(...)` etc. which then
  // explodes. Convert each namespace to a plain Object (with Object.prototype)
  // that merges the namespace + default export. That matches what CJS
  // `require("node:X")` would have returned.
  const importLines = [];
  const tableEntries = [];
  for (const mod of externalMods) {
    const ident = "__cfml_ns_" + mod.replace(/[^a-z]/gi, "_");
    importLines.push(`import * as ${ident} from "${mod}";`);
    tableEntries.push(
      `  "${mod}": Object.assign({}, ${ident}, (${ident}).default && typeof (${ident}).default === "object" ? (${ident}).default : {}),`,
    );
  }
  const table =
    `const __cfml_cjs = {\n${tableEntries.join("\n")}\n};\n`;
  // Replace the throwing __require shim with one that consults the table.
  const shimRe = /var __require = \/\* @__PURE__ \*\/ \(\(x\) => typeof require[\s\S]*?Error\('Dynamic require of "' \+ x \+ '" is not supported'\);\s*\}\);/;
  const newShim =
    table +
    `var __require = (id) => {\n` +
    `  if (id in __cfml_cjs) return __cfml_cjs[id];\n` +
    `  throw new Error('Dynamic require of "' + id + '" is not supported');\n` +
    `};`;
  if (!shimRe.test(src)) {
    console.error("jspi-patch: __require shim anchor not found");
    process.exit(1);
  }
  src = src.replace(shimRe, newShim);
  src = importLines.join("\n") + "\n" + src;
  console.log(
    `jspi-patch: hoisted ${externalMods.size} node require(s) into CJS-shape dispatch table — ${[...externalMods].join(", ")}`,
  );
}

writeFileSync(path, src);
console.log("jspi-patch: build/index.js patched");
