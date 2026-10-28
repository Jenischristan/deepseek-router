# AGENTS.md

Guidance for agents working on `deepseek-router`.

## Commands

```bash
npm test              # node --test (all tests)
node --test test/tools.test.js   # one file
make                  # build the optional C launcher
make install          # symlink ./deepseek-router into ~/.local/bin
make tui              # build tui/deepseek-router-tui (system FTXUI)
make install-tui      # install the TUI into ~/.local/bin
node --check src/main.js         # syntax check (repeat per file)
python3 -m py_compile scripts/get-token.py
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
| `src/deepseek.js` | Upstream client: sessions, PoW header, completion, retries |
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
| `src/deepseek-router.c` | Optional launcher that `exec`s node/python |
| `tui/dashboard.cpp` | FTXUI dashboard: polls `/health` via a forked node fetch, tails pid/log files |
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

## Testing

`test/tools.test.js` — parser/DSML/stream-filter unit tests.
`test/server.test.js` — end-to-end with a fake upstream client.
`test/helpers.test.js` — config, `TokenStore`, `SessionStore`.
`test/http.test.js` — HTTP routes and error paths (uses a fake client, no upstream).
`test/sse.test.js` — patch-stream parsing and upstream error paths.

There is no `typecheck` step; ESM + `node --check` is the safety net.
