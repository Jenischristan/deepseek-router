# deepseek-router

OpenAI-compatible HTTP router for `chat.deepseek.com`. It reuses sessions
from local Zen (or Firefox) profiles, solves DeepSeek's proof-of-work challenge
with the site's own WASM solver, and exposes standard `/v1/chat/completions`
and `/v1/models` endpoints. Multiple accounts can be queued for automatic
failover and scheduled rotation.

No npm packages, no pip packages. The default router uses the Firefox
transport sidecar, so build it once to get started; the optional C launcher is
described below.

## Requirements

- Node.js 20.3+ (uses built-in `fetch`, `AbortSignal.any`)
- Python 3.10+ (only for `scripts/get-token.py`)
- Go 1.24+ (to build the default Firefox transport sidecar)
- One or more logged-in DeepSeek accounts in Zen/Firefox profiles (see
  [Multiple accounts](#multiple-accounts-automatic-collection))

## Setup

1. Extract the browser session (the browser can stay open):

   ```bash
   python3 scripts/get-token.py --write
   ```

   This reads `userToken` from the profile's localStorage snapshot, plus
   optional DeepSeek cookies and the `hif_leim_cached`/`hif_dliq_cached`
   values, validates the token against DeepSeek, and writes
   `~/.config/deepseek-router/config.json` with mode `600`. Validation is a
   single read-only `GET https://chat.deepseek.com/api/v0/users/settings`; dead
   (`40002`/`40003`), rate-limited, or challenged tokens are not written. If the
   check cannot reach DeepSeek, the command keeps the existing config instead of
   deleting accounts. Use `--no-validate` only when you explicitly want an
   offline extraction.

### Multiple accounts (automatic collection)

You do not need to copy tokens, cookies, or `hifLeim`/`hifDliq` by hand. The
extractor pulls all of them from each browser profile/container automatically.

- Recommended for one browser: keep each account in its own Firefox/Zen
  container (Multi-Account Containers). Containers isolate cookies and
  localStorage, so logging out of one account does not log out the others.

  1. Open `https://chat.deepseek.com` in container A and log in.
  2. Open it again in container B and log in.
  3. Run the extractor:

  ```bash
  python3 scripts/get-token.py --write-accounts
  # or: npm run token:accounts
  ```

  Container sessions are detected per profile and labelled like
  `~/.config/zen/<profile> [Work]`. Cookies are matched to the same container,
  so each account keeps its own `smidV2` and other cookies.

  To rebuild the queue from only the currently active profile (and avoid stale
  tokens from old profiles), pass the profile path shown by `--list`:

  ```bash
  python3 scripts/get-token.py --profile "$HOME/.config/zen/<profile>" --write-accounts
  ```

- If each account lives in its own Zen/Firefox profile:

  ```bash
  python3 scripts/get-token.py --write-accounts
  # or: npm run token:accounts
  ```

  It scans every discovered profile with a DeepSeek session, deduplicates by
  token, and writes the ordered `accounts` array. Use `--profile PATH`
  (repeatable) to limit the scan, or `--all --json` to preview first.

- If you use one browser and switch accounts in the same context, run the
  watcher and log into each account while it runs. Switching accounts in one
  container logs out the previous session there, so use separate containers
  if you need both to stay active:

  ```bash
  python3 scripts/get-token.py --watch
  # or: npm run token:watch
  ```

  Every new token it sees is validated first and only appended to `accounts`
  if it is alive, together with that profile's cookies, `hifLeim`, and
  `hifDliq`. Press Ctrl+C when done. Existing accounts are kept, so re-running
  only adds new ones. The extractor also stores the profile's
  `deepseek-device-id:chat` value as `deviceId`; the router sends it as
  `x-device-id` so each account keeps the device identity its browser session
  was created with.

  `accountSwitchAfter` is `0` (failover only) by default, which is the
  recommended setting. Scheduled rotation across several accounts is a strong
  multi-account abuse signal; only set it if you deliberately want to spread
  messages across the queue. The router logs a warning when it is enabled. See
  [Multiple accounts](#multiple-accounts).

2. Start the router:

   ```bash
   npm start
   # or: node src/main.js
   ```

   It listens on `http://127.0.0.1:8788` by default. `start` runs in the
   background and writes logs to `~/.config/deepseek-router/router.log`; a pid
   file in the same directory lets the CLI stop it again.

   ```bash
   npm start                             # background (headless, default)
   npm run foreground                    # attached, live logs in this terminal
   npm run status                        # state, pid, log path
   npm run logs                          # last 50 log lines
   npm run stop                          # stop the background server
   ```

   The same flags work on the compiled launcher: `deepseek-router`,
   `deepseek-router start --foreground`, `deepseek-router stop`,
   `deepseek-router status`, `deepseek-router logs -n 200`.

3. Point any OpenAI client at it:

   ```text
   Base URL: http://127.0.0.1:8788/v1
   API key:  (anything, unless DEEPSEEK_ROUTER_KEY is set)
   Model:    deepseek-chat or deepseek-reasoner
   ```

### Compiled launcher (optional)

A small C launcher provides one `deepseek-router` command for the Node and
Python entry points. It resolves the repository and `exec`s the real script;
router behavior stays in `src/index.js`, while `src/main.js` handles the
background/foreground CLI.

```bash
make                 # build ./deepseek-router
make install         # symlink into ~/.local/bin
deepseek-router --help
```

```bash
deepseek-router                     # start in the background
deepseek-router start --port 9000   # override port/host
deepseek-router start --foreground  # attached, with live logs
deepseek-router start --transport node     # opt out of the Go sidecar
deepseek-router start --request-delay 4    # wait 4s between request starts
deepseek-router logs -n 100         # recent background log lines
deepseek-router status              # running? which pid?
deepseek-router stop                # stop the background server
deepseek-router token --write       # python3 scripts/get-token.py --write
deepseek-router token:accounts      # --write-accounts
deepseek-router token:watch         # --watch
deepseek-router test                # node --test
deepseek-router paths               # resolved paths and tools
```

`make install` symlinks the binary in this repository, so rebuilding updates
the installed command. If the binary is copied elsewhere, set
`DEEPSEEK_ROUTER_ROOT=/path/to/deepseek-router`; the build also embeds the
repository path as a fallback.

## Endpoints

- `GET /v1/models`
- `GET /v1/models/:id`
- `POST /v1/chat/completions` (streaming and non-streaming)
- `POST /v1/token` — update the token (or `accounts` array) at runtime
  (`{"token":"..."}`, optional `cookies`/`hifLeim`/`hifDliq`, `persist`
  defaults to true)
- `POST /v1/sessions/clear` — drop cached upstream sessions
- `GET /health` — status, active account, session count, current request delay

### Examples

```bash
curl http://127.0.0.1:8788/v1/models

curl http://127.0.0.1:8788/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{
    "model": "deepseek-chat",
    "messages": [{"role": "user", "content": "Say hello in five words."}]
  }'

curl -N http://127.0.0.1:8788/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{
    "model": "deepseek-reasoner",
    "stream": true,
    "messages": [{"role": "user", "content": "Why is the sky blue?"}]
  }'
```

`deepseek-reasoner` emits `reasoning_content` deltas before the final
`content`, matching the official DeepSeek API shape.

### opencode

Add a custom provider in `~/.config/opencode/opencode.json` or
`opencode.jsonc`, then restart opencode:

```json
{
  "provider": {
    "deepseek-router": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "DeepSeek Router (local)",
      "options": {
        "baseURL": "http://127.0.0.1:8788/v1",
        "apiKey": "local-router"
      },
      "models": {
        "deepseek-chat": {
          "name": "DeepSeek Chat (local)",
          "tool_call": true
        },
        "deepseek-reasoner": {
          "name": "DeepSeek Reasoner (local)",
          "reasoning": true,
          "interleaved": { "field": "reasoning_content" },
          "tool_call": true
        }
      }
    }
  }
}
```

Select it with `/models`, or run
`opencode run -m deepseek-router/deepseek-chat "..."`. Tool calls are emulated
(see below), so `opencode run --auto` can execute tools such as `bash`, `read`,
and `edit`.

### Tool calling

The web endpoint has no tool protocol, so the router emulates one:

1. OpenAI `tools`/`functions` definitions are rendered into a prompt protocol.
   The model is asked to answer with DeepSeek DSML:
   `<｜DSML｜calls><｜DSML｜invoke name="..."><｜DSML｜parameter ...>...`.
   The JSON form `<tool_call>{"calls":[...]}</tool_call>` remains an accepted
   fallback.
2. The parser accepts DSML with ASCII or full-width bars (1-3 on either side),
   `calls`/`tool_calls`/`function_calls`, and invokes without an outer block.
   Plain `<parameter>` and prefixed `<｜DSML｜parameter>` tags are both handled.
   `string="true"` values are kept verbatim (whitespace matters for edits);
   `string="false"` or a missing attribute is parsed as JSON with a raw-text
   fallback.
3. Bare argument objects are accepted too. `<tool_call>{"command":"ls"}</tool_call>`,
   newline-separated objects, and trailing stray braces are matched to the tool
   whose schema best fits the arguments (with `tool_choice` as a tie-breaker).
4. Argument values are coerced to the types declared in the tool schema
   (`integer`, `number`, `boolean`, `object`, `array`) before the call is
   returned.
5. Parsed calls are returned as standard OpenAI `tool_calls`: generated
   `call_...` ids, `type: "function"`, and `arguments` as a JSON string, with
   `finish_reason: "tool_calls"`. Streaming sends the id, type and name in the
   first delta for each index, then argument fragments, then the finish chunk.
6. Tool results are formatted and sent as a continuation of the same upstream
   session, so the model can call another tool or produce a final answer.

Malformed DSML is recovered conservatively: a missing `</invoke>` resynchronizes
on the next invoke (so one call cannot swallow the next), a missing outer close
still yields its complete invokes, repeated parameters become separate calls,
and a complete parameter left outside an invoke is recovered. An unterminated
parameter value is rejected instead of being executed. A complete tool call
inside ` thinking` is executed, while the markup is stripped from the returned
reasoning and never leaks into assistant content.

Supported controls: `tool_choice` (`auto`, `none`, `required`, or a specific
function), legacy `functions`/`function_call`, and `parallel_tool_calls`.
Tool execution remains client-side; the router never runs a tool itself.

Set `injectToolPrompt` to `false` to stop injecting the protocol. Tool
definitions are then left out of the prompt entirely, but the parser still
converts any `<tool_call>` or DSML output it receives, and tool results are
still relayed to the same upstream session.

Set `parseToolCalls` to `false` to disable parsing too. The upstream output
(including any `<tool_call>` or DSML markup) is then returned verbatim as
assistant `content`, with `finish_reason: "stop"`, and the client has to
interpret it. This is useful for observing what the model emits on its own.

## How it works

1. A new DeepSeek chat session is created for the first request of a
   conversation.
2. For every completion, a fresh PoW challenge is requested and solved with
   `assets/sha3.wasm`. PoW answers are single-use; reusing one returns
   `INVALID_POW_RESPONSE`.
3. The first request sends the whole conversation (system prompts and history)
   as a single seeded prompt. Later turns reuse the same upstream session and
   only send the new user message, with `parent_message_id` set to the previous
   assistant message id.
4. Responses are translated from DeepSeek's patch-based SSE stream into OpenAI
   `chat.completion.chunk` events. `THINK` fragments become
   `reasoning_content`; `RESPONSE` fragments become `content`. Emulated tool
   calls are emitted as standard `tool_calls` deltas.
5. Before every completion the client refreshes `x-hif-leim` from
   `hif-leim.deepseek.com/query`, which returns a new value with
   `x-hif-ttl: 600` (10 minutes). `x-hif-dliq` is sent from the configured
   value by default because `hif-dliq.deepseek.com` is IPv6-only on some
   networks. Set `hifDliqRefresh` to also refresh it from
   `hif-dliq.deepseek.com/query`; the router then keeps both values fresh
   before their TTL expires.

Upstream requests are serialized (one at a time by default, with a small gap)
and use browser-like headers. `requestDelaySeconds` sets the average wait
before each new upstream request, in seconds: `0` disables the delay, `4`
waits about four seconds. Each gap is jittered by roughly +/-15% so repeated
turns do not land on a metronomic cadence. It applies to chat turns, account
failover attempts, uploads, and repair calls, and is hot-reloaded from
`config.json`, so an edit applies to the next request without restarting. The
first request after a router start is not delayed. If `requestDelaySeconds` is
unset, `minIntervalMs` is used as the millisecond fallback. The short
session-create -> PoW -> completion chain for one turn is not delayed, because
the PoW challenge is time-limited. Values below four seconds are logged as a
warning at startup.

Tool loops get an extra cooldown. When a tool result comes back,
`toolResultDelaySeconds` waits a randomly jittered fraction of that value
before the follow-up completion request is sent upstream: 70-95%, so `4` means
roughly 2.8-3.8 seconds rather than an exact four-second beat. The router never
waits longer than the configured value. It measures the tool's execution time
from when it delivered the assistant tool-call response until the result
request arrived. If that time is at least `toolResultSkipAfterSeconds`, the
cooldown is skipped because the tool already took long enough. `0` disables the
cooldown. If the timing is unknown (for example after a router restart), the
full jittered cooldown is applied rather than risking a burst. Both settings
are hot-reloaded and are separate from `requestDelaySeconds`, which spaces the
starts of all upstream requests.

### Browser fingerprint

The router mirrors the headers the DeepSeek web client sends from Firefox:
`user-agent`, `accept`, `accept-language`, `accept-encoding`, the PoW header,
`x-hif-*`, the `x-client-*` headers, `authorization`, `content-type`,
`origin`, `sec-gpc`, `referer`, the cookies, and `sec-fetch-*`, in the same
order Firefox writes them for the client's `XMLHttpRequest` calls. Like the web
client, it sends no `Priority` header. Cookies are copied from the browser
profile verbatim (including `smidV2` and the AWS WAF `aws-waf-token`) in
Firefox's cookie order. The hif requests use `sec-fetch-site: same-site` with
the same client headers, but no `Authorization` or `Cookie` header, because the
DeepSeek cookies are scoped to `chat.deepseek.com`.

`acceptEncoding` defaults to the browser's `gzip, deflate, br, zstd`. Node's
fetch handles gzip/deflate/br itself; the router decompresses zstd before the
JSON/SSE parser sees it. On Node builds without zstd support the default falls
back to `gzip, deflate, br`.

By default, the router sends chat and hif requests through the Firefox
transport sidecar below, so network-level fingerprints (HTTP/2 and TLS/JA3)
match Firefox as well. Set `transport: "node"` to fall back to Node's
HTTP/1.1/OpenSSL stack.

### Firefox transport (default)

Build the sidecar once:

```bash
make transport
npm start
# or set "transport": "firefox" in config.json (the default)
```

The router starts `transport/deepseek-transport` on a random loopback port,
passes it a random per-process key, and sends all chat and hif requests through
it. The sidecar uses `bogdanfinn/tls-client` with a `firefox_159` profile
derived from the bundled Firefox 148 profile, so it negotiates HTTP/2 and sends
a Firefox-like TLS ClientHello, HTTP/2 SETTINGS, HTTP/2 priority frames, and
header order. The derived profile drops the CBC/DHE cipher suites and finite-field DH
groups that Firefox 149+ removed and matches the 224-byte ECH grease payload.
It is not a general proxy: only `chat.deepseek.com`, `hif-leim.deepseek.com`,
and `hif-dliq.deepseek.com` are accepted, and it exits when the router process
disappears.

This is wire-level Firefox impersonation, not a literal NSS build: the TLS stack
is Go/uTLS rather than Mozilla NSS. Literal NSS/Gecko transport would require
driving Zen/Firefox itself as a sidecar. The sidecar keeps response bodies
compressed and lets the router decode them, so `acceptEncoding` still applies.

## Configuration

The router reads `~/.config/deepseek-router/config.json` (or `config.json` in
this directory), plus environment variables. Environment variables win. Set
`DEEPSEEK_ROUTER_CONFIG_FILE` to read only a specific config file.

| Key | Env | Default | Meaning |
| --- | --- | --- | --- |
| `accounts` | `DEEPSEEK_ACCOUNTS` | — | Ordered list of accounts (JSON array) |
| `token` | `DEEPSEEK_TOKEN` | — | Bearer token from localStorage |
| `tokenFile` | `DEEPSEEK_TOKEN_FILE` | — | File containing just the token |
| `cookies` | `DEEPSEEK_COOKIES` | — | Optional `Cookie` header |
| `hifLeim` | `DEEPSEEK_HIF_LEIM` | — | Optional fallback `x-hif-leim`; the runtime value from `hif-leim.deepseek.com/query` is preferred |
| `hifDliq` | `DEEPSEEK_HIF_DLIQ` | — | Optional fallback `x-hif-dliq`; used when the runtime refresh is disabled or fails |
| `deviceId` | `DEEPSEEK_DEVICE_ID` | — | Per-account `x-device-id` UUID from the browser's `deepseek-device-id:chat` localStorage entry; extract it with `get-token.py` so requests keep the account's device identity |
| `hifDliqRefresh` | `DEEPSEEK_HIF_DLIQ_REFRESH` | `false` | Also refresh `x-hif-dliq` from `hif-dliq.deepseek.com/query` (that host is IPv6-only on some networks) |
| `hifRefreshEnabled` | `DEEPSEEK_HIF_REFRESH_ENABLED` | `true` | Poll `hif-leim.deepseek.com/query` for a fresh `x-hif-leim`; `false` sends only the configured static value and drops the extra poll |
| `powChallengeEnabled` | `DEEPSEEK_POW_CHALLENGE_ENABLED` | `true` | Request `/chat/create_pow_challenge` and send `x-ds-pow-response`. **Diagnostic only:** `false` skips both and DeepSeek rejects the completion with `MISSING_HEADER` (code `40300`) |
| `apiKey` | `DEEPSEEK_ROUTER_KEY` | — | Require this key on `/v1/*` |
| `host` | `HOST` | `127.0.0.1` | Listen address |
| `port` | `PORT` | `8788` | Listen port |
| `requestDelaySeconds` | `DEEPSEEK_REQUEST_DELAY_SECONDS` | — | Wait this many seconds before each upstream request; `0` disables it; hot-reloaded (falls back to `minIntervalMs` when unset) |
| `minIntervalMs` | `UPSTREAM_MIN_INTERVAL_MS` | `400` | Millisecond fallback spacing when `requestDelaySeconds` is unset |
| `toolResultDelaySeconds` | `DEEPSEEK_TOOL_RESULT_DELAY_SECONDS` | — | Base wait after a tool result before sending the follow-up; the actual wait is jittered to 70-95% of this value; `0` disables it; hot-reloaded |
| `toolResultSkipAfterSeconds` | `DEEPSEEK_TOOL_RESULT_SKIP_AFTER_SECONDS` | `8` | Skip the tool-result cooldown when the tool already ran at least this long |
| `concurrency` | `UPSTREAM_CONCURRENCY` | `1` | Parallel upstream completions |
| `rateLimitCooldownSeconds` | `DEEPSEEK_RATE_LIMIT_COOLDOWN_SECONDS` | `60` | Pause before retrying the same account after a 429 when DeepSeek sends no `Retry-After` |
| `rateLimitRetries` | `DEEPSEEK_RATE_LIMIT_RETRIES` | `1` | How many times to pause and retry the same account on a 429 (0-5); never rotates accounts |
| `sessionTtlMs` | `SESSION_TTL_MS` | `21600000` | Session cache lifetime (6h) |
| `maxSessions` | `MAX_SESSIONS` | `500` | Session cache size |
| `injectToolPrompt` | `INJECT_TOOL_PROMPT` | `true` | Add the tool-use protocol to the prompt; `false` leaves tool parsing on but injects nothing |
| `parseToolCalls` | `PARSE_TOOL_CALLS` | `true` | Convert DSML or JSON tool markup into `tool_calls`; `false` returns the raw text |
| `repairToolCalls` | `REPAIR_TOOL_CALLS` | `true` | Ask the model to resend an unusable tool call instead of returning it broken |
| `maxToolRepairs` | `MAX_TOOL_REPAIRS` | `2` | Maximum repair attempts per turn (clamped to 0-5) |
| `accountSwitchAfter` | `DEEPSEEK_ACCOUNT_SWITCH_AFTER` | `0` | Rotate after N assistant messages per account (0 disables; leave at 0 to avoid multi-account abuse signals) |
| `requestTimeoutMs` | `REQUEST_TIMEOUT_MS` | `600000` | Per-request upstream timeout |
| `clientVersion` | `DEEPSEEK_CLIENT_VERSION` | `2.7.0` | `x-client-version` header |
| `locale` | `DEEPSEEK_LOCALE` | `en_US` | `x-client-locale` header |
| `userAgent` | `DEEPSEEK_USER_AGENT` | Firefox 159 on Linux | `user-agent` header |
| `acceptLanguage` | `DEEPSEEK_ACCEPT_LANGUAGE` | `en-US,en;q=0.9` | `accept-language` header |
| `acceptEncoding` | `DEEPSEEK_ACCEPT_ENCODING` | `gzip, deflate, br, zstd` | `accept-encoding` header; zstd is decoded by the router |
| `secGpc` | `DEEPSEEK_SEC_GPC` | `true` | Send `sec-gpc: 1` like Firefox with Global Privacy Control enabled |
| `transport` | `DEEPSEEK_TRANSPORT` | `firefox` | `firefox` (Go sidecar, default) or `node` (built-in fetch) |
| `transportBinary` | `DEEPSEEK_TRANSPORT_BINARY` | `transport/deepseek-transport` | Sidecar binary path |
| `transportProfile` | `DEEPSEEK_TRANSPORT_PROFILE` | `firefox_159` | tls-client browser profile (`firefox_159`, `firefox_148`, ...) |
| `wasmPath` | `SHA3_WASM` | `assets/sha3.wasm` | Path to the PoW solver wasm |
| `logLevel` | `LOG_LEVEL` | `info` | `error`, `warn`, `info`, `debug` |

See `config.example.json`. `minIntervalMs`, `concurrency`,
`rateLimitCooldownSeconds`, `rateLimitRetries`, `hifDliqRefresh`,
`hifRefreshEnabled`, and `powChallengeEnabled` are read at startup; restart
after changing them. Account changes,
`accountSwitchAfter`, `requestDelaySeconds`, `toolResultDelaySeconds`, and
`toolResultSkipAfterSeconds` are hot-reloaded.

### Multiple accounts

Configure an ordered queue of accounts; the first one is active. Generate it
automatically with `--write-accounts` or `--watch` (see Setup), or write it by
hand:

```json
{
  "accountSwitchAfter": 0,
  "accounts": [
    { "token": "...", "cookies": "...", "hifLeim": "...", "hifDliq": "...", "deviceId": "..." },
    { "token": "...", "cookies": "...", "hifLeim": "...", "hifDliq": "...", "deviceId": "..." }
  ]
}
```

`accountSwitchAfter` rotates the queue after that many successful assistant
messages on the active account. With `5`, account 1 handles five model
responses, the next request uses account 2 for five, then account 3, and so on.
Tool-call turns count as model messages because they also consume upstream
quota. The count is global across all conversations and tracks messages handled
during the current stint on the active account. Set it to `0` (the default) to
stay on the active account until it fails. Failover still works with `0`;
scheduled rotation is opt-in because it makes one browser session look like a
pool of interchangeable accounts.

Context is preserved across rotations. Each account has its own upstream
session; when the active account changes, the router starts a fresh session on
the new account and seeds it with the full conversation transcript, including
tool calls and tool results. Cached sessions are keyed by account, so a session
from one account is never reused with another.

If the active account fails with an auth error (401/403), the router advances
to the next account, removes that account's cached upstream sessions, and
retries the request from the start. The queue wraps around, and each account is
tried at most once per request. Scheduled rotation still applies on the new
account. With a single `token`, behavior is unchanged.

A `429` (or `50006`) is treated as global pacing pressure, not as a broken
account: the router pauses for `Retry-After` when DeepSeek sends one,
otherwise `rateLimitCooldownSeconds`, and retries the **same** account up to
`rateLimitRetries` times. It does not rotate during a rate limit, because
cycling the whole queue multiplies the request rate and looks like account
farming. If retries are exhausted, the 429 is returned to the client with a
`Retry-After` header.

A token that fails with an auth error is quarantined for 24 hours, so a dead
token is not retried on every rotation cycle. Quarantine is cleared as soon as
the account list changes (for example after re-syncing with
`scripts/get-token.py --write-accounts`), and falls back to plain round-robin
when every account is quarantined. Scheduled rotation also skips quarantined
accounts, so an invalid token is not retried just because the message counter
reached `accountSwitchAfter`.

If DeepSeek answers with an interactive verification challenge
(`CHALLENGE_REQUIRED`), the router does **not** try to solve or bypass it. The
account is quarantined for 24 hours and marked in `/health`, and the request
immediately fails over to the next account. Challenge detection also recognizes
the WAF response headers (`405` + `x-amzn-waf-action: captcha`, `202` +
`x-amzn-waf-action: challenge`, and `403`/`429` + `cf-mitigated: challenge`)
before parsing the body. When no other account is available,
the request fails with HTTP 403, `code: "challenge_required"`, and a short
message such as `DeepSeek account 4 requires manual verification
(captcha/challenge).` Open `https://chat.deepseek.com` in the same browser,
complete the verification, then refresh the session with
`python3 scripts/get-token.py --write-accounts`. Updating the account list,
token, or cookies clears the quarantine. `/health` reports
`challengeRequired` and the affected `challengedAccounts`.
`DEEPSEEK_ACCOUNTS` accepts the same array as JSON; set
`DEEPSEEK_ACCOUNT_SWITCH_AFTER` to change the rotation count without editing the
config file.


## Token refresh

The token comes from the browser session. When it expires, run:

```bash
python3 scripts/get-token.py --write
```

The server notices the config file change and reloads it within a few seconds;
no restart needed. `GET /health` shows whether a token is present, the active
account, `switchAfter`, and `messagesOnAccount`. When using `accounts`, run
`--write-accounts` (or keep `--watch` running) to refresh the whole queue; plain
`--write` adds or updates one entry without removing the others. You can also
send a new `accounts` array to `POST /v1/token`.

`--write-accounts` validates each discovered token and rebuilds `accounts` from
the live ones. A dead token (`40002`/`40003`, including an HTTP 200 response
with a non-zero `code`), a rate-limited token, or one that needs a
captcha/challenge is skipped. `--write` and `--watch` also validate the token
they are about to add or update, but they do not prune accounts that are already
in the config. If validation is `unknown` because the network, TLS, or DeepSeek
returned a 5xx, `--write-accounts` leaves the config untouched rather than
rewriting it without the account. If none of the discovered tokens is alive, it
writes an empty `accounts` array and exits non-zero, so log in again in the
browser before starting the router.

Useful extractor flags:

```bash
python3 scripts/get-token.py --list             # profiles/containers + token/hif presence
python3 scripts/get-token.py --json             # full JSON (secret: do not share)
python3 scripts/get-token.py --token-only       # print only the token
python3 scripts/get-token.py --write-accounts   # validated, alive profiles/containers -> accounts array
python3 scripts/get-token.py --watch            # capture and validate accounts as you switch
python3 scripts/get-token.py --validate         # validate even for --json / --token-only
python3 scripts/get-token.py --alive-only       # print only alive tokens (implies --validate)
python3 scripts/get-token.py --no-validate      # offline escape hatch; may write dead tokens
python3 scripts/get-token.py --validation-timeout 30
python3 scripts/get-token.py --profile ~/.config/zen/<profile> --write
```

## Session behavior

- Conversation keys are a SHA-256 of the model, thinking mode, tool
  definitions, account token, and the exact message prefix, so different
  conversations and different accounts never share an upstream session.
- Tool-call turns are cached together with the assistant message and tool
  results, so a tool result continues the same upstream session.
- The cache is in memory. Restarting the router starts new upstream sessions.
- If a client edits earlier messages, the key changes and a new upstream
  session is seeded with the full transcript.
- When the active account changes, the new account gets a fresh session seeded
  with the full transcript. `POST /v1/sessions/clear` drops all cached
  sessions, but account switches are handled automatically.

## Limitations

- Images are supported for OpenAI-style `image_url` content parts with base64
  `data:` URLs (for example `data:image/png;base64,...`) or `input_image`
  parts. The router uploads each image to the active DeepSeek account and
  passes the returned file ids as `ref_file_ids`; the model then sees the
  picture, so no placeholder is left in the prompt. Remote `http(s)` image URLs
  and plain file attachments are not fetched or uploaded and are replaced with
  a short placeholder.
- Tool calling is emulated through the prompt, not a native upstream API. It is
  best-effort: large tool sets or adversarial prompts can produce malformed
  calls. Missing DSML closing tags, repeated parameters, and stray parameters
  are recovered when possible; an unterminated parameter is rejected rather
  than executed. Unnamed calls are matched by argument shape, and ambiguous or
  unusable calls are reported as invalid instead of being silently dropped.
  `workdir`/`cwd`/`directory` arguments are folded into `cd ... && ...` only
  when the tool schema does not declare them.
- `n > 1` is rejected. Sampling options (`temperature`, `top_p`, `max_tokens`,
  `stop`, `response_format`) are ignored because the web endpoint has no
  equivalent.
- System/developer messages are flattened into the seeded first prompt, since
  the web API has no separate system role.
- `deepseek-chat` maps to thinking disabled; `deepseek-reasoner` maps to
  thinking enabled. Other model aliases (`deepseek-v3`, `deepseek-r1`, ...)
  are accepted.
- The web API is unofficial and may change without notice.
- One account is active at a time (see Multiple accounts for failover). Running
  multiple router instances or heavy parallel use increases the chance of rate
  limits or session invalidation.

## Troubleshooting

- **401 / invalid token** — rerun `python3 scripts/get-token.py --write` while
  logged in. The extractor validates the token before writing, so a successful
  write means DeepSeek accepted it during that run.
- **429 / `Messages too frequent`** — the router already pauses and retries the
  same account. If it keeps happening, raise `requestDelaySeconds` (for example
  to `8`), leave `concurrency` at `1`, and avoid `accountSwitchAfter`.
- **Tokens disappear from the config after re-syncing** — the extractor only
  keeps live tokens. Open `https://chat.deepseek.com` in the browser profile,
  log in again (and complete any captcha), then rerun `--write-accounts`. If the
  validation request itself could not reach DeepSeek, the command refuses to
  rewrite the config.
- **`INVALID_POW_RESPONSE`** — should be retried automatically with a fresh
  challenge. If it persists, the client version or PoW format changed. Do not
  set `powChallengeEnabled: false` as a workaround: DeepSeek rejects PoW-less
  completions with `MISSING_HEADER` (code `40300`), and the toggle exists only
  for diagnostics.
- **`CHALLENGE_REQUIRED` / 403 `challenge_required`** — DeepSeek wants
  interactive verification on that account. The router will not solve or
  bypass it; it quarantines the account and continues with the next one.
  Complete the check in the browser profile used by the extractor, then
  refresh the token and cookies to clear the quarantine.
- **Missing wasm** — ensure `assets/sha3.wasm` exists, or set `SHA3_WASM`.
- **`hif-dliq` refresh fails with `network is unreachable`** — that host may
  resolve only to IPv6. `hifDliqRefresh` defaults to `false`, so the configured
  `hifDliq` value is still sent; enable it only on an IPv6-capable network.
- **Session logged out / unusual-traffic warning after running the router** —
  the strongest known causes are account rotation and replayed dead tokens, not
  the hif or PoW requests. Keep `accountSwitchAfter` at `0`, keep one live
  account in the config, re-sync after any logout, keep `concurrency` at `1`,
  raise `requestDelaySeconds`, and avoid running the router and the website on
  the same account at the same time. Do not disable `powChallengeEnabled`;
  `hifRefreshEnabled: false` removes one poll but sends a static value that goes
  stale. A headless real Firefox backend does not remove the two-client problem:
  the site would still see the same account used from two clients, and
  automating a logged-in Firefox profile is itself an additional bot signal.
  See `docs/session-investigation.md` for the evidence.
- **Port in use** — set `PORT`.
- **No profiles found** — pass `--profile` with the directory that contains
  `prefs.js` and `storage/`.

## Security

The server binds to `127.0.0.1` by default. If you expose it beyond localhost,
set `DEEPSEEK_ROUTER_KEY` and configure your client with that API key. The
config file contains a live session token; it is written with mode `600`.
Do not commit it or paste extractor output anywhere.
