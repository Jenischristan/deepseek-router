# Session / logout investigation

Date: 2026-11-06
Scope: why the router appears to log the website out, whether
`create_pow_challenge` and `hif-leim` are responsible, and what changed between
the early router and the current one.

No source code was changed for this investigation. The only persistent change
is the live config (documented at the end); the uncommitted source changes
discussed below predate the investigation. All token values below are shown as
truncated SHA-256 hashes; no tokens, cookies, or hif values are reproduced here.

## TL;DR

1. **The two requests are not the root cause.** Both are part of the normal web
   client flow. The A/B runs below did not rotate or invalidate the browser
   token, and disabling them did not reduce the invalidation pattern.
2. **The real smoking gun is the old multi-account configuration:** 6-7
   accounts rotating every 6-15 messages, with no token quarantine in the
   version that was running at the time. The log contains **2,125 scheduled
   account switches**, **732 `INVALID_TOKEN` failures**, and **83**
   `Messages too frequent` events. That is the signature of an account farm,
   not of a browser-fingerprint mismatch.
3. **The live config was already broken:** both configured tokens were dead,
   and neither matched either current Zen session. The router was replaying
   dead credentials on every request. That alone produces constant auth
   failures and can worsen account-level flags.
4. **PoW cannot be disabled.** `powChallengeEnabled: false` makes DeepSeek
   return `MISSING_HEADER` (40300), and the router retries the completion three
   times. This is a diagnostic switch only.
5. **The newer code is mostly mitigation, not regression.** The Firefox
   transport, hif refresh, challenge detection, quarantine, 429 handling, and
   device id were added *after* most of the damage in the log. The remaining
   risky change is the uncommitted Python token validator, which talks to
   DeepSeek over OpenSSL/`urllib` rather than the Firefox sidecar. Several of
   the safety fixes (24-hour quarantine, 429 pause/retry) are also still
   uncommitted, so `HEAD` is less safe than the working tree.

## Method

- Backed up `~/.config/deepseek-router/config.json` before touching it.
- Read browser localStorage/cookies from a private SQLite copy (the normal
  `scripts/get-token.py` path). No browser database was modified.
- Compared only hashes of tokens; values were never printed.
- Ran short completions against the live account with the two toggles set via
  environment variables, so the on-disk config was not edited during the runs.
- Restored the config to one live account before the final run.
- Analyzed `~/.config/deepseek-router/router.log` (18,079 lines, 2026-10-25 to
  2026-11-05) and the timestamped config backups.

## Live token state before the tests

| Source | Token hash | Status | Cookies | Device id |
| --- | --- | --- | --- | --- |
| Config account 1 | `1347d5a826a3` | **dead** (`Authorization Failed`) | yes | yes |
| Config account 2 | `0df3b359a5ed` | **dead** (`Authorization Failed`) | yes | yes |
| Zen profile `0zrlal6k` (container 1) | `5a992b66fdd4` | **dead** (`Authorization Failed`) | yes | **no** |
| Zen profile `uhix2twb` (container 3) | `14bbcfd2c5f0` | **alive** (`ok`) | yes | yes |

Two important facts:

- **No config token matched any current browser session.** The config was a
  stale snapshot from an older login.
- The only alive session was in container 3. Container 1 was also dead, with no
  `aws-waf-token` and no device id.

After re-syncing with `scripts/get-token.py --write-accounts`, the config
contained exactly one account: hash `14bbcfd2c5f0`.

## A/B/C/D completion runs

All runs used the same live account, `concurrency: 1`, and the existing
`requestDelaySeconds: 15`. Each run was one short non-streaming completion.

| Mode | `hifRefreshEnabled` | `powChallengeEnabled` | Upstream calls | Result | Browser token after |
| --- | --- | --- | --- | --- | --- |
| A | true | true | session create, PoW, hif-leim, completion | **200 OK**, 3.25 s | unchanged |
| B | false | false | session create, completion ×3 | **502 `MISSING_HEADER` (40300)**, 2.89 s | unchanged |
| C | false | true | session create, PoW, completion | **200 OK**, 2.91 s | unchanged |
| D | false | true, static hif ~27 min old | session create, PoW, completion | **200 OK** | unchanged |

Observed sidecar request lines:

- Mode A: `chat_session/create`, `create_pow_challenge`, `hif-leim/query`,
  `chat/completion` — all HTTP 200.
- Mode B: `chat_session/create`, then three `chat/completion` attempts — all
  HTTP 200 at the HTTP layer, but the JSON body was `MISSING_HEADER` /
  code `40300`. The router treated each as a retryable upstream failure.
- Mode C: `chat_session/create`, `create_pow_challenge`, `chat/completion` —
  no hif request.
- Mode D: same calls as mode C. The configured `hifLeim` had been written by
  the browser at 15:06:30 IST and was used at 15:33:34 IST, so it was about
  **27 minutes old** — well past the advertised 10-minute TTL. The completion
  still returned 200.

Conclusions from the runs:

- **PoW is mandatory.** Disabling it does not reduce risk; it turns every
  request into three failed completions.
- **hif-off is viable short-term.** The static configured value was accepted
  immediately in mode C and still accepted at ~27 minutes in mode D. This
  contradicts a strict "static hif is rejected after ten minutes" rule, but it
  does not prove that a days-old value is safe.
- None of these runs changed the browser token hash.

A later five-run matrix (labeled A-E in the companion document) also covered
`transport: firefox` vs `transport: node` and `hifDliqRefresh` on/off. All five
returned HTTP 200 and left the browser token hash unchanged. See
[old-vs-new-session-safety.md](old-vs-new-session-safety.md#the-2026-11-06-ab-runs)
for the full table, including the IPv6 failure of `hif-dliq`.

## What the historical log shows

Log range: 2026-10-25 15:25 UTC to 2026-11-05 15:01 UTC.

| Day | Successful client requests | Scheduled account switches | `INVALID_TOKEN` | `Messages too frequent` |
| --- | ---: | ---: | ---: | ---: |
| 2026-10-29 | 2,244 | 373 | 3 | 48 |
| 2026-10-30 | 2,546 | 423 | 83 | 0 |
| 2026-10-31 | 1,439 | 238 | 255 | 6 |
| 2026-11-01 | 1,192 | 197 | 152 | 11 |
| 2026-11-02 | 1,527 | 254 | 104 | 6 |
| 2026-11-03 | 1,347 | 193 | 123 | 11 |
| 2026-11-04 | 82 | 5 | 8 | 1 |
| 2026-11-05 | 37 | 0 | 4 | 0 |
| **Total** |  | **2,125** | **732** | **83** |

`INVALID_TOKEN` failures by account:

| Account | Failures |
| --- | ---: |
| 5 | 244 |
| 6 | 182 |
| 1 | 147 |
| 2 | 126 |
| 4 | 15 |
| 3 | 8 |

The failures cluster on the accounts that were rotated through most often
(5 and 6), then spread to 1 and 2 as those tokens died too.

### Config snapshots

| Snapshot | Accounts | `accountSwitchAfter` | Pacing |
| --- | ---: | ---: | --- |
| 2026-10-31 backup | 6 | 6 | `minIntervalMs: 400` |
| 2026-11-03 backup | 7 | 15 | `minIntervalMs: 4000` |
| 2026-11-05 backup | 2 | 0 | `requestDelaySeconds: 15` |
| Before re-sync (2026-11-06) | 2 | 0 | `requestDelaySeconds: 15` |

The worst invalidation days (Oct 31-Nov 3) line up exactly with the 6-7 account
rotation period. By Nov 4-5 the account count and rotation were reduced, but
the configured tokens were already dead.

### Why this pattern damages sessions

- `accountSwitchAfter: 6` does not mean "rotate on failure". It means **rotate
  after six successful assistant messages**, continuously. Six or seven
  accounts then present the same IP and browser fingerprint in a repeating
  carousel.
- In the code that was running before 2026-11-04, there was **no quarantine**
  (`markFailed` did not exist in the initial `src/token.js`). A dead token was
  retried again on the next rotation cycle, forever.
- `isAccountFailure()` in the initial and committed HEAD code treats **429 and
  `50006` as account failures** and rotates to the next account. A rate limit
  therefore increased aggregate request rate instead of pausing. The
  uncommitted working tree fixes this by pausing and retrying the same
  account.
- The initial code also had **no challenge detection**, so a captcha response
  could be retried/rotated instead of quarantined.

## Code timeline: old vs new

| Commit / state | Date | Change | Session impact |
| --- | --- | --- | --- |
| `7b40ff2` initial code | 2026-10-25 | Node HTTP/1.1 + OpenSSL; static `hifLeim` only; no device id; no quarantine; 429 counts as account failure; no challenge detection | Simpler, but fragile once a token dies or a 429 hits |
| `23ae25a` | 2026-11-04 | Firefox/uTLS sidecar; runtime hif polling; cookie ordering; zstd; challenge detection; 10-minute quarantine | More browser-like; adds the two extra requests, but also adds safety |
| `685ed8c` | 2026-11-04 | Firefox transport becomes the default | TLS/HTTP2 parity instead of Node OpenSSL |
| `34a459f` / `3ebaba1` | 2026-11-04 | Configurable request delay, example set to 4 s | Human-like pacing |
| `7d77485` / `4219be0` | 2026-11-04 | Tool-result cooldown and jitter | Fewer metronomic tool turns |
| Working tree (uncommitted) | current | `x-device-id`; challenge-response detection; 429 pause/retry instead of rotation; 24 h quarantine; ±15% delay jitter; Python token validation/watch; the two toggles | Mostly mitigation; the Python validator is the main new risk |

**Key conclusion:** the problems in the log predate the Firefox transport and
hif refresh. The new requests did not create the invalidation wave; the
multi-account rotation did. The newer code is safer than the code that produced
the log, but it arrived after the tokens were already dead.

## What actually changed that can still hurt

Ranked by evidence strength:

1. **Multi-account rotation (strong, proven).** 2,125 scheduled switches and
   732 invalid-token failures. This is the dominant signal.
2. **Dead-token replay (strong, proven).** The config held two dead tokens and
   they matched no browser session. Every request replayed them.
3. **429 treated as an account failure (strong, code + 83 events).** Rotation
   during rate limiting multiplied traffic across accounts.
4. **No quarantine in the running version (strong, code).** Dead tokens were
   retried indefinitely; the 10-minute quarantine arrived only on Nov 4, and
   the 24-hour quarantine is still uncommitted.
5. **Stale extraction / token rotation (strong, live state).** The website's
   token changes; a one-time extraction goes stale. This is why the config and
   browser no longer matched.
6. **Browser and router using the same account concurrently (likely, not
   directly proven).** The short A/B runs did not rotate the token, but over
   days the site sees two clients. This remains the reason a "perfect" client
   fingerprint cannot fully guarantee one session.
7. **Python token validation over OpenSSL (uncommitted, plausible risk).**
   `scripts/get-token.py --write/--watch/--validate` sends
   `https://chat.deepseek.com/api/v0/users/settings` through
   `urllib` + `ssl.create_default_context()`. That is a non-Firefox TLS stack
   with browser-like headers and the live bearer token. It is a much stronger
   mismatch than anything in the router itself, and it runs on a 2-second scan
   loop with `--watch`.
8. **Static hif after the TTL (weak, tested in mode D).** A ~27-minute-old
   static `hifLeim` was still accepted with hif refresh off, so this is not a
   proven logout trigger. A days-old value remains untested.
9. **Header drift (minor, unproven).** `clientVersion` is still `2.7.0`, the
   default UA is Firefox 159, and `sec-gpc: 1` is forced. Verify the real values
   in DevTools; a mismatch is a weak signal, not the main cause.

## Why the "old router" seemed fine

The old code did not magically avoid logout. It had the same scheduled rotation
feature and, in fact, a worse failure mode (no quarantine, 429 rotation). Three
things make the comparison misleading:

- Early use was probably one account at low volume; the 6-7 account carousel
  came later.
- The old router did not refresh hif, so it made fewer requests, but it also
  sent a stale hif. Mode D shows a 27-minute-old value still worked; fewer
  requests is not the same as safer.
- Most of the visible damage happened **before** the Firefox transport landed.
  The new transport and hif refresh were added as a reaction to the damage, not
  its cause.

## Headless Firefox: would it fix it?

It would improve transport fidelity (real NSS TLS, real HTTP/2, real cookie
jar, the site's own JS for PoW/hif), but it would **not** fix account-level
invalidation while the same account is also used in the normal browser. It also
adds automation signals (`navigator.webdriver`, BiDi/CDP, headless GPU/WebGL,
locked profile). It is only a real fix if the router's browser is the **only**
client for that account, ideally a dedicated account and profile.

## Recommended operating rules

1. Keep `powChallengeEnabled: true`. `false` is a diagnostic that causes
   `MISSING_HEADER` and 3× failed completion attempts.
2. Set `accountSwitchAfter: 0`. Use one account at a time; failover only.
3. Re-sync after any logout or token rotation. Never leave dead tokens in the
   config; the router will replay them.
4. Avoid running the website and the router on the same account at the same
   time. Use a dedicated account for the router if possible.
5. Keep `concurrency: 1`, `requestDelaySeconds` at 15 or higher, and the
   tool-result cooldown enabled.
6. Verify `clientVersion`, UA, and `secGpc` against a real DevTools request.
7. Treat `scripts/get-token.py` validation as a separate client. If the router
   is running, prefer `--no-validate` for reads; if you use `--watch`, remember
   it validates over Python TLS every time it finds a new token.
8. If you need maximum fidelity, the next step is a real Firefox/BiDi transport
   that executes fetches inside `chat.deepseek.com` and uses that browser as the
   only client for the account. It is a significant sidecar, not a config flag.

## Applied configuration

- Config backup: `~/.config/deepseek-router/config.json.bak-session-20261106-151748`
  (mode 600).
- Accounts: reduced to the single live session (`14bbcfd2c5f0`).
- `accountSwitchAfter`: `0`.
- `requestDelaySeconds`: `15`.
- `powChallengeEnabled`: `true` (see mode B result — false is not viable).
- `hifRefreshEnabled`: unset (defaults to `true`). Mode D shows `false` also
  works short-term, but `true` remains the safer default for fidelity.
- `hifDliqRefresh`: `false` (IPv6 refresh fails on this network).

## Open questions

- The exact server-side rule that invalidates a token is not observable from
  the client. The log proves correlation with multi-account rotation, not the
  precise trigger.
- Whether a single account, low-volume, long-running session stays alive for
  days is still unproven.
- Whether replaying `x-device-id` from two clients matters is unproven.
- The impact of the Python validator's TLS fingerprint is plausible but not
  isolated in a controlled test; deliberately triggering it could damage the
  only live account.
