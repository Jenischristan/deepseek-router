# deepseek-router

OpenAI-compatible HTTP router for `chat.deepseek.com`. It reuses sessions
from local Zen (or Firefox) profiles, solves DeepSeek's proof-of-work challenge
with the site's own WASM solver, and exposes standard `/v1/chat/completions`
and `/v1/models` endpoints. Multiple accounts can be queued for automatic
failover and scheduled rotation.

No npm packages, no pip packages, and no required build step. An optional C
launcher is described below.

## Requirements

- Node.js 20.3+ (uses built-in `fetch`, `AbortSignal.any`)
- Python 3.10+ (only for `scripts/get-token.py`)
- One or more logged-in DeepSeek accounts in Zen/Firefox profiles (see
  [Multiple accounts](#multiple-accounts-automatic-collection))

## Setup

1. Extract the browser session (the browser can stay open):

   ```bash
   python3 scripts/get-token.py --write
   ```

   This reads `userToken` from the profile's localStorage snapshot, plus
   optional DeepSeek cookies and `hif_leim_cached`, and writes
   `~/.config/deepseek-router/config.json` with mode `600`.

### Multiple accounts (automatic collection)

You do not need to copy tokens, cookies, or `hifLeim` by hand. The extractor
pulls all three from each browser profile/container automatically.

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

  Every new token it sees is appended to `accounts` together with that
  profile's cookies and `hifLeim`. Press Ctrl+C when done. Existing accounts
  are kept, so re-running only adds new ones.

  To rotate the queue after a fixed number of model messages, set
  `accountSwitchAfter` in the config (for example `5`) or start the router with
  `DEEPSEEK_ACCOUNT_SWITCH_AFTER=5`. The next request moves to the next account
  and the conversation is reseeded there. See
  [Multiple accounts](#multiple-accounts).

2. Start the router:

   ```bash
   npm start
   # or: node src/index.js
   ```

   It listens on `http://127.0.0.1:8788` by default.

3. Point any OpenAI client at it:

   ```text
   Base URL: http://127.0.0.1:8788/v1
   API key:  (anything, unless DEEPSEEK_ROUTER_KEY is set)
   Model:    deepseek-chat or deepseek-reasoner
   ```

### Compiled launcher (optional)

A small C launcher provides one `deepseek-router` command for the Node and
Python entry points. It resolves the repository and `exec`s the real script;
router behavior stays in `src/index.js`.

```bash
make                 # build ./deepseek-router
make install         # symlink into ~/.local/bin
deepseek-router --help
```

```bash
deepseek-router                     # start the server
deepseek-router start --port 9000   # override port/host
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
  (`{"token":"..."}`, `persist` defaults to true)
- `POST /v1/sessions/clear` — drop cached upstream sessions
- `GET /health` — status, active account, session count

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
   The model is asked to answer with a JSON block:
   `<tool_call>{"calls":[{"name":"...","arguments":{...}}]}</tool_call>`.
2. DeepSeek's native DSML tool format is also accepted. The parser tolerates
   ASCII or full-width bars (1-3 on either side), `calls`/`tool_calls`/
   `function_calls`, V4.1 spaced tags such as `<｜｜DSML｜｜ invoke>`, and invokes
   without an outer block: `<｜｜DSML｜｜ calls>` / `<invoke name="...">` /
   `<parameter ...>` blocks. Plain `<parameter>` and prefixed
   `<｜｜DSML｜｜ parameter>` tags are both handled. `string="true"` values are kept
   verbatim (whitespace matters for edits); `string="false"` or a missing
   attribute is parsed as JSON with a raw-text fallback.
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
parameter value is rejected instead of being executed. Tool markup inside
` thinking` is ignored and never leaks into assistant content.

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

Upstream requests are serialized (one at a time by default, with a small gap)
and use browser-like headers. This is deliberate: it keeps traffic close to a
normal web client and avoids hammering the web API.

## Configuration

The router reads `~/.config/deepseek-router/config.json` (or `config.json` in
this directory), plus environment variables. Environment variables win.

| Key | Env | Default | Meaning |
| --- | --- | --- | --- |
| `accounts` | `DEEPSEEK_ACCOUNTS` | — | Ordered list of accounts (JSON array) |
| `token` | `DEEPSEEK_TOKEN` | — | Bearer token from localStorage |
| `tokenFile` | `DEEPSEEK_TOKEN_FILE` | — | File containing just the token |
| `cookies` | `DEEPSEEK_COOKIES` | — | Optional `Cookie` header |
| `hifLeim` | `DEEPSEEK_HIF_LEIM` | — | Optional `x-hif-leim` header |
| `apiKey` | `DEEPSEEK_ROUTER_KEY` | — | Require this key on `/v1/*` |
| `host` | `HOST` | `127.0.0.1` | Listen address |
| `port` | `PORT` | `8788` | Listen port |
| `minIntervalMs` | `UPSTREAM_MIN_INTERVAL_MS` | `400` | Gap between upstream request starts |
| `concurrency` | `UPSTREAM_CONCURRENCY` | `1` | Parallel upstream completions |
| `sessionTtlMs` | `SESSION_TTL_MS` | `21600000` | Session cache lifetime (6h) |
| `maxSessions` | `MAX_SESSIONS` | `500` | Session cache size |
| `injectToolPrompt` | `INJECT_TOOL_PROMPT` | `true` | Add the tool-use protocol to the prompt; `false` leaves tool parsing on but injects nothing |
| `parseToolCalls` | `PARSE_TOOL_CALLS` | `true` | Convert ``/DSML output into `tool_calls`; `false` returns the raw text |
| `repairToolCalls` | `REPAIR_TOOL_CALLS` | `true` | Ask the model to resend an unusable tool call instead of returning it broken |
| `maxToolRepairs` | `MAX_TOOL_REPAIRS` | `2` | Maximum repair attempts per turn (clamped to 0-5) |
| `accountSwitchAfter` | `DEEPSEEK_ACCOUNT_SWITCH_AFTER` | `0` | Rotate after N assistant messages per account (0 disables) |
| `requestTimeoutMs` | `REQUEST_TIMEOUT_MS` | `600000` | Per-request upstream timeout |
| `clientVersion` | `DEEPSEEK_CLIENT_VERSION` | `2.7.0` | `x-client-version` header |
| `locale` | `DEEPSEEK_LOCALE` | `en_US` | `x-client-locale` header |
| `userAgent` | `DEEPSEEK_USER_AGENT` | Firefox UA | `user-agent` header |
| `wasmPath` | `SHA3_WASM` | `assets/sha3.wasm` | Path to the PoW solver wasm |
| `logLevel` | `LOG_LEVEL` | `info` | `error`, `warn`, `info`, `debug` |

See `config.example.json`.

### Multiple accounts

Configure an ordered queue of accounts; the first one is active. Generate it
automatically with `--write-accounts` or `--watch` (see Setup), or write it by
hand:

```json
{
  "accountSwitchAfter": 5,
  "accounts": [
    { "token": "...", "cookies": "...", "hifLeim": "..." },
    { "token": "...", "cookies": "...", "hifLeim": "..." }
  ]
}
```

`accountSwitchAfter` rotates the queue after that many successful assistant
messages on the active account. With `5`, account 1 handles five model
responses, the next request uses account 2 for five, then account 3, and so on.
Tool-call turns count as model messages because they also consume upstream
quota. The count is global across all conversations and tracks messages handled
during the current stint on the active account. Set it to `0` (the default) to
stay on the active account until it fails.

Context is preserved across rotations. Each account has its own upstream
session; when the active account changes, the router starts a fresh session on
the new account and seeds it with the full conversation transcript, including
tool calls and tool results. Cached sessions are keyed by account, so a session
from one account is never reused with another.

If the active account fails with an auth error (401/403) or rate limit (429),
the router advances to the next account, removes that account's cached upstream
sessions, and retries the request from the start. The queue wraps around, and
each account is tried at most once per request. Scheduled rotation still applies
on the new account. With a single `token`, behavior is unchanged.
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

Useful extractor flags:

```bash
python3 scripts/get-token.py --list             # profiles/containers + token/hif presence
python3 scripts/get-token.py --json             # full JSON (secret: do not share)
python3 scripts/get-token.py --token-only       # print only the token
python3 scripts/get-token.py --write-accounts   # all profiles/containers -> accounts array
python3 scripts/get-token.py --watch            # capture accounts as you switch
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

- Text only. Images and file attachments are replaced with a short placeholder.
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
  logged in.
- **`INVALID_POW_RESPONSE`** — should be retried automatically with a fresh
  challenge. If it persists, the client version or PoW format changed.
- **Missing wasm** — ensure `assets/sha3.wasm` exists, or set `SHA3_WASM`.
- **Port in use** — set `PORT`.
- **No profiles found** — pass `--profile` with the directory that contains
  `prefs.js` and `storage/`.

## Security

The server binds to `127.0.0.1` by default. If you expose it beyond localhost,
set `DEEPSEEK_ROUTER_KEY` and configure your client with that API key. The
config file contains a live session token; it is written with mode `600`.
Do not commit it or paste extractor output anywhere.
