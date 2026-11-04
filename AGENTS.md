# AGENTS.md

Guidance for agents working on `deepseek-router`.

## Commands

```bash
npm test              # node --test (all tests)
node --test test/tools.test.js   # one file
make                  # build the optional C launcher
make install          # symlink ./deepseek-router into ~/.local/bin
make transport        # build the default Go Firefox transport sidecar
node --check src/main.js         # syntax check (repeat per file)
python3 -m py_compile scripts/get-token.py
cd transport && go test ./...    # sidecar tests (local HTTP/2 upstream)
```

No linter/formatter is configured. Keep the existing style: 2-space indent,
single quotes, trailing commas, ESM imports.

## Architecture

| File | Role |
| --- | --- |
| `src/main.js` | CLI: background start (default), `--foreground`, `stop`, `status`, `logs` |
| `src/index.js` | Entry point: load config, init PoW solver, start server, signals |
| `src/daemon.js` | pid/log file handling for the background server |
| `src/config.js` | `loadConfig` (env > file), `saveConfig`, `normalizeAccounts` |
| `src/token.js` | `TokenStore`: account queue, rotation, config/token-file hot reload |
| `src/hif.js` | `HifStore`: fetches/refreshes `x-hif-leim`; optional `x-hif-dliq` refresh (off by default) |
| `src/fetch.js` | `withZstd`: decodes `content-encoding: zstd`; default `accept-encoding` |
| `src/transport.js` | Default Firefox sidecar lifecycle + fetch wrapper (loopback, shared key, DeepSeek host allowlist) |
| `src/deepseek.js` | Upstream client: sessions, PoW header, completion, retries; accepts `fetchImpl` |
| `src/pow.js` | `PowSolver` driving `assets/sha3.wasm` |
| `src/sessions.js` | `SessionStore` (TTL + LRU) and `conversationKey` |
| `src/errors.js` | `HttpError`, `AuthError`, `UpstreamError`, `isPowError` |
| `src/http.js` | HTTP layer: `Gate` (concurrency + min interval), auth, routes, `handleCompletion` |
| `src/server.js` | Compatibility shim re-exporting `createServer` and the openai helpers |
| `src/openai/models.js` | Model list/aliases, `buildSeedPrompt`, response shaping (`completionResponse`, `chunk`, `usageChunk`) |
| `src/openai/sse.js` | `consumeDeepSeekStream` — DeepSeek patch SSE -> fragments/status/usage |
| `src/openai/json.js` | Loose JSON repair (`repairJsonText`, `looseJsonParse`), tool/choice normalization |
| `src/openai/schema.js` | Schema validation, argument coercion, tool index and name resolution |
| `src/openai/extract.js` | Payload -> tool call extraction (JSON forms, DSML, V3 special tokens) |
| `src/openai/sanitize.js` | `sanitizeToolCalls` / `validateToolCalls` |
| `src/openai/parse.js` | `parseToolResponse` / `interpretToolResponse` and repair prompts |
| `src/openai/prompt.js` | Tool instruction/signature/reminder building |
| `src/openai/transcript.js` | Tool-call history and tool-result formatting, cache key normalization |
| `src/openai/filter.js` | `ToolCallStreamFilter` and `splitAtToolMarker` |
| `deepseek-router.c` | Optional launcher that `exec`s node/python |
| `transport/main.go` | Loopback Go sidecar: `bogdanfinn/tls-client` Firefox TLS/HTTP2 forwarding, SSE streaming |
| `scripts/get-token.py` | Browser-profile token/cookie extractor |

### Dependency order (openai modules)

`json` <- `schema` <- `extract`/`sanitize` <- `parse` <- `filter`/`prompt`/`transcript` <- `http`.
Import from the lowest module that declares the symbol; avoid cycles (only
`filter.js` imports `stripLeadingThink` from `parse.js`).

## Conventions / gotchas

- Env vars override config file; `saveConfig` re-reads before writing (retries on mtime change).
- `TokenStore` accepts `configFile: null` to disable disk reloads (tests use this).
- Streaming and non-streaming both go through `completionOutcome` for finish reason/usage — keep them in sync.
- Tool protocol must never leak raw markup into assistant `content`; see `tools.test.js`.
- Tests must not touch `~/.config/deepseek-router/config.json` or the network.
- The pid/log files live in `~/.config/deepseek-router/`; `DEEPSEEK_ROUTER_FOREGROUND=1`
  is set by the detached child so the same code path serves both modes.
- Config keys added to code must also be added to `README.md` and `config.example.json`.
- The Firefox transport is the default (`transport: "firefox"`); `node` is the
  opt-out. Keep both sides' host allowlists in sync.
- The sidecar keeps response bodies compressed (`DisableCompression`) so the
  router can decode them; `withZstd` handles zstd, and Node fetch handles
  gzip/deflate/br.
- `hifDliqRefresh` is off by default because `hif-dliq.deepseek.com` is
  IPv6-only on some networks; the static `hifDliq` value is still sent.
- Upstream header order mirrors the web client's XHR wire order: PoW/hif before
  `x-client-*`, `content-length` immediately before `origin`, and no
  `priority`. Keep `browserHeaders`, `orderWithContentLength`, and the tests in
  sync.

## Testing

`test/tools.test.js` — parser/DSML/stream-filter unit tests.
`test/server.test.js` — end-to-end with a fake upstream client.
`test/helpers.test.js` — config, `TokenStore`, `SessionStore`.
`test/http.test.js` — HTTP routes and error paths (uses a fake client, no upstream).
`test/sse.test.js` — patch-stream parsing and upstream error paths.
`test/transport.test.js` — Firefox transport wrapper protocol (local fake sidecar).
`transport/main_test.go` — sidecar allowlist, header order, HTTP/2 streaming, auth.

There is no `typecheck` step; ESM + `node --check` is the safety net.
