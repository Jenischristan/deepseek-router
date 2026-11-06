# Old vs new router: what changed, what damages sessions, and what the old version did better

Date: 2026-11-06
Scope: compare the initial router (`7b40ff2`, 2026-10-25) with the current
working tree, explain the logout / `INVALID_TOKEN` / captcha pattern, and record
the live A/B runs of the boolean toggles requested on 2026-11-06.

No source code was changed for this investigation. The only persistent changes
are this documentation and the live config (the pre-run backup is listed at the
end). The uncommitted working-tree changes discussed below were already present
before the investigation. Tokens, cookies, hif values, and device ids below are
shown as truncated SHA-256 hashes; no secrets are reproduced.

Companion document: [session-investigation.md](session-investigation.md).

## TL;DR

1. **The old router was not safer. It was simpler and quieter.** The same
   multi-account rotation that damaged the current account was already running
   in the old code, and the log shows captcha/challenge responses on
   **2026-10-31** and **2026-11-03**, before the Firefox transport existed.
2. **The dominant historical cause is the 6-7 account carousel plus dead-token
   replay.** The log contains **2,125 scheduled account switches**, **732
   invalid-token failures**, and **83** `Messages too frequent` events. Rotation
   after 6-15 messages made one browser session look like a pool of
   interchangeable accounts.
3. **The boolean toggles are not the cause.** Five live A/B runs on 2026-11-06
   (Firefox vs Node transport, hif refresh on/off, hif-dliq refresh on/off) all
   returned HTTP 200, and the browser token hash did not change. A static
   `hifLeim` value that was roughly 27 minutes old was accepted with
   `hifRefreshEnabled: false`. Disabling hif refresh is therefore not an
   immediate logout trigger.
4. **The genuinely new risk is the Python token validator.** The old extractor
   only read the browser profile. The current working tree adds live
   `GET /api/v0/users/settings` validation through `urllib` + Python/OpenSSL,
   with the real bearer token, cookies, and device id. `--write-accounts`
   validates every discovered token, including dead ones; `--watch` repeats it.
   That is a second TLS client with a non-Firefox fingerprint, and the one new
   thing in the workflow that can plausibly invalidate a session.
5. **Many safety fixes are still uncommitted.** `HEAD` (`8e7e92e`) still has a
   10-minute auth quarantine, a 30-minute challenge quarantine, and 429 =
   "rotate to the next account". The working tree has 24-hour quarantine,
   challenge headers, and 429 pause/retry, but a fresh clone or a deploy from
   `HEAD` does not.
6. **Operate one account.** `accountSwitchAfter: 0`, remove dead accounts,
   keep `concurrency: 1`, keep a long request delay, and do not run the website
   and the router on the same account at the same time.

## The 2026-11-06 A/B runs

The live config had one account (token hash `14bbcfd2c5f0`), `transport:
firefox`, `requestDelaySeconds: 15`, and `hifDliqRefresh: false`. Each run
started a fresh router on its own port, sent one short non-streaming completion,
and then stopped. Overrides were passed as environment variables, so the
on-disk config was not edited. The browser token hash was `14bbcfd2c5f0`
before and after every run.

| # | Time (IST) | Transport | hif refresh | hif-dliq refresh | PoW | Upstream calls observed | Result | Token after |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A | 15:33:34 | Firefox sidecar | off | off | on | `chat_session/create`, `create_pow_challenge`, `chat/completion` | **200**, static hif accepted | unchanged |
| B | 15:33:42 | Firefox sidecar | on | off | on | `chat_session/create`, `create_pow_challenge`, `hif-leim/query`, `chat/completion` | **200** | unchanged |
| C | 15:33:50 | Firefox sidecar | on | on | on | `chat_session/create`, `create_pow_challenge`, `hif-dliq/query` failed (IPv6 unreachable), `hif-leim/query` 200, `chat/completion` | **200** | unchanged |
| D | 15:34:02 | Node (`transport: node`) | on | off | on | completion only visible in the Node log | **200** | unchanged |
| E | 15:34:11 | Node (`transport: node`) | off | off | on | completion only visible in the Node log | **200** | unchanged |

### What the runs show

- **`hifRefreshEnabled: false` is viable short-term.** The configured
  `hifLeim` was written by the browser at 15:06:30 (localStorage DB mtime) and
  used at 15:33:34, so it was about **27 minutes old** — well past the advertised
  10-minute TTL. DeepSeek still accepted the completion. This contradicts a hard
  "static hif is rejected after ten minutes" rule. It does not prove that a
  days-old static value is safe, only that there is no strict per-request TTL
  rejection in this account/request.
- **`hifDliqRefresh: true` fails gracefully on this network.** The sidecar tried
  `hif-dliq.deepseek.com` over IPv6 and got `network is unreachable`; the router
  fell back to the static hif-dliq value and the completion still returned 200.
  Leave it `false` on an IPv4-only network.
- **The Firefox sidecar is not required for a successful request today.** Node
  transport (`transport: node`) also returned 200 with the same token, both with
  hif refresh on and off. The sidecar is still the better fingerprint match; this
  is a diagnostic result, not a recommendation to use Node.
- **Caveat:** each run restarted the router, and the first request after a start
  is intentionally not delayed. The configured 15-second spacing therefore did
  not apply between the five runs; they landed about 8-12 seconds apart. This was
  a short A/B, not a soak test, and it cannot prove long-term safety.

### What was not re-run

- `powChallengeEnabled: false` was already tested in
  [session-investigation.md](session-investigation.md). It produces
  `MISSING_HEADER` (40300) and three failed completion attempts. PoW is
  mandatory; do not disable it.
- Long-duration static hif (hours/days) was not tested. The 27-minute result is
  useful but not a long-term guarantee.

## Historical evidence from `router.log`

Log range: 2026-10-25 15:25 UTC to 2026-11-05 15:01 UTC.

| Day | `/v1/chat/completions` log lines (incl. failures) | Scheduled switches | Invalid token | `Messages too frequent` | Challenge events |
| --- | ---: | ---: | ---: | ---: | ---: |
| 2026-10-25 | 360 | 59 | 0 | 0 | 0 |
| 2026-10-26 | 1,185 | 196 | 0 | 0 | 0 |
| 2026-10-27 | 995 | 163 | 0 | 0 | 0 |
| 2026-10-28 | 150 | 24 | 0 | 0 | 0 |
| 2026-10-29 | 2,287 | 373 | 3 | 48 | 0 |
| 2026-10-30 | 2,588 | 423 | 83 | 0 | 0 |
| 2026-10-31 | 1,450 | 238 | 255 | 6 | 4 `CHALLENGE_REQUIRED` |
| 2026-11-01 | 1,211 | 197 | 152 | 11 | 0 |
| 2026-11-02 | 1,527 | 254 | 104 | 6 | 0 |
| 2026-11-03 | 1,366 | 193 | 123 | 11 | 6 `CHALLENGE_REQUIRED` + 13 verification warnings |
| 2026-11-04 | 87 | 5 | 8 | 1 | account 1: 3 verification warnings |
| 2026-11-05 | 43 | 0 | 4 | 0 | account 1: 3 verification warnings |
| **Total** |  | **2,125** | **732** | **83** |  |

Key timing facts:

- The first Firefox sidecar line is **2026-11-04 10:34 IST** (05:04 UTC).
- The first `CHALLENGE_REQUIRED` is **2026-10-31 04:16 UTC**.
- Account 1 was already challenged on **2026-11-03 13:08 UTC** and
  **2026-11-04 07:37 UTC**, before the final Nov 5 challenge.
- The worst invalidation days (Oct 31-Nov 3) line up with the 6-7 account
  rotation period, not with the Firefox transport.
- On Oct 31 the requests were often 2-5 seconds apart while rotating every six
  messages. That is the account-farm signature, not a browser fingerprint
  mismatch.

### Config snapshots

| Snapshot | Accounts | `accountSwitchAfter` | Pacing |
| --- | ---: | ---: | --- |
| 2026-10-31 backup | 6 | 6 | `minIntervalMs: 400` |
| 2026-11-03 backup | 7 | 15 | `minIntervalMs: 4000` |
| 2026-11-05 backup | 2 | 0 | `requestDelaySeconds: 15`, tool cooldown 15 s |
| 2026-11-06 live | 1 | 0 | `requestDelaySeconds: 15`, tool cooldown 15 s |

The rotation was a **config choice**, not a new-code default. `accountSwitchAfter`
has always defaulted to `0`. The old router did not protect against a bad config,
and neither the old nor the current code prevents a user from setting it.

## Code inventory: initial -> HEAD -> working tree

| Area | Initial `7b40ff2` | `HEAD` `8e7e92e` | Current working tree | Session impact |
| --- | --- | --- | --- | --- |
| Transport | Node `fetch` (HTTP/1.1, OpenSSL) | Firefox sidecar default (Go/uTLS, HTTP/2) | Same | More browser-like wire fingerprint; sidecar logs every upstream call |
| Headers | Minimal: auth, content-type, accept, language, origin, referer, UA, `x-client-*`, sec-fetch, cookie, static `x-hif-leim` | Browser order, `accept-encoding`, `sec-gpc`, `x-hif-dliq` | Adds `x-device-id`, `x-device-model` | Closer to the real client; also more chances to mismatch |
| `x-hif-leim` | Static value only | Refreshed from `hif-leim.deepseek.com/query` with ~8 min cache | Toggle `hifRefreshEnabled` | Extra GET when cache expires; not every completion |
| `x-hif-dliq` | Not sent | Static value; optional IPv6 refresh | Same | Extra header; IPv6 refresh fails on this network |
| PoW | Always required | Always required; 40300 retry | Optional diagnostic `powChallengeEnabled` | Disabling it causes `MISSING_HEADER` and 3 failed POSTs |
| Device identity | None | None | `x-device-id` + empty `x-device-model` from localStorage | Closer if it matches the browser; a stable identifier if stale/shared |
| GPC | Not sent | `sec-gpc: 1` by default | Same | Mismatch if the browser does not send GPC |
| Cookies | Sent on chat requests | Sent on chat, not hif (host-only `chat.deepseek.com` cookies) | Same | Correct for this cookie jar |
| Account rotation | `accountSwitchAfter`, default 0 | Same | Same + skips quarantined accounts | Config-driven; 6/15-message rotation is the historical damage |
| Auth quarantine | None | 10 min | 24 h | HEAD still retries a dead token every 10 min |
| Challenge quarantine | None | 30 min, detection | 24 h, WAF header detection | HEAD still retries a captcha account every 30 min |
| 429 / 50006 | Treated as account failure, rotates | Treated as account failure, rotates | Pauses and retries same account | HEAD's behavior multiplies traffic across accounts |
| Challenge detection | None | Body-message detection | Body + `x-amzn-waf-action` / `cf-mitigated` | Stops hammering an account that needs a human |
| Pacing | `minIntervalMs` default 400 | `requestDelaySeconds` knob; code fallback still 400 | ±15% jitter + tool-result cooldown | Safer only if configured; code default is still fast |
| Tool-result cooldown | None | Added Nov 4 (config) | Jittered 70-95% | Reduces rapid tool loops, but did not prevent the Nov 5 tool burst |
| Token extractor | Read profile only; no validation; no device id; no hif-dliq | Adds hif-dliq | Adds Python/OpenSSL validation, device id, `--watch` validation | **New external client and the main new risk** |
| Retries / repair | 3 completion attempts, tool repair | More paths (hif, upload, challenge) | 429 pause/retry, WAF detection | More requests under failure; can multiply traffic |
| Session cache | Account-keyed | Account-keyed | Account-keyed | Correct: never reuses a session across accounts |
| Logging | Only `/v1/*` lines | Sidecar logs every upstream request | Same | Makes the new router look busier than the old one |

## What the old router did better

Only in the narrow sense of having fewer moving parts:

- **No Python/OpenSSL token validator.** The old extractor read the profile and
  wrote the config. The new validator is a second client that talks to DeepSeek
  with the live bearer token and a non-Firefox TLS stack.
- **No forced `sec-gpc`.** The old request did not add a privacy header the
  browser might not send.
- **No replayed device identity.** The old request omitted `x-device-id`; the new
  one can send a stable UUID (and an empty `x-device-model`) on every request
  once the extractor captures it.
- **No hif-dliq header and no hif-refresh poll.** Fewer extra requests and fewer
  header values that can be stale. The 27-minute static-hif run shows this can
  work.
- **Quieter logs.** The old Node fetch did not log upstream calls, so it looked
  like it made fewer requests. The sidecar logs `chat_session/create`,
  `create_pow_challenge`, `hif-*`, and `completion` separately, which makes the
  new router look much busier.
- **Less automatic retry machinery.** Fewer paths that can turn one failure into
  several requests.

But the old router was **worse** on the things that actually protect an account:

- no quarantine, so a dead token was retried forever;
- 429 counted as an account failure, so rate limiting rotated the whole queue;
- no challenge detection, so a captcha response could be retried/rotated;
- no device id, so requests did not carry the browser's device identity;
- a static hif value that was never refreshed;
- Node's TLS stack was obviously not Firefox;
- 400 ms default spacing.

The old router did not "avoid" the logout. The log shows challenges under the old
transport. The likely reason it felt safer is that early use was one account at
low volume; the 6-7 account carousel came later and produced the visible damage.

## What the new router does worse / new risks, ranked

1. **Python token validation is a new second client (strongest new risk).**
   `scripts/get-token.py --write/--write-accounts/--watch/--validate` sends
   `GET https://chat.deepseek.com/api/v0/users/settings` through
   `urllib` + `ssl.create_default_context()`, with:
   - the live bearer token;
   - the profile cookies;
   - `x-device-id` and empty `x-device-model`;
   - `sec-gpc: 1`, `connection: close`, `accept-encoding: identity`;
   - a Python/OpenSSL TLS fingerprint, not the Firefox sidecar.

   `--write-accounts` validates **every** discovered token, including dead ones,
   before pruning. `--watch` validates every new token. Repeated runs therefore
   produce bursts of authenticated requests from a non-browser client — the
   exact pattern the sidecar was built to avoid. This is the one new feature that
   can plausibly invalidate a session on its own. It was not present in the
   initial version.
2. **Multi-account rotation and dead-token replay remain the dominant
   historical cause.** `accountSwitchAfter: 6` or `15` with 6-7 accounts produced
   2,125 switches and 732 invalid-token failures. A dead token in the config is
   replayed until the config is fixed.
3. **`HEAD` still rotates on 429.** The working tree fixes this, but a fresh
   clone or deploy from `HEAD` does not. The log's 83 rate-limit events show how
   often this path was hit.
4. **`sec-gpc: 1` is forced by default.** The live Zen profile does not show an
   explicit `privacy.globalprivacycontrol.enabled` pref (only
   `was_ever_enabled`), so the real browser may not send it. Verify in DevTools;
   if it does not, set `secGpc: false`. This is a weak signal, not the main cause.
5. **`x-device-id` / `x-device-model` replay is unverified.** The UUID is the
   browser's stable device identity, which is good if it matches. If the browser
   rotates it after a re-login and the config keeps the old one, or if the
   browser and router use the same account concurrently, the server sees two
   clients with the same identity. The empty `x-device-model` value has not been
   verified against a real request.
6. **Extra hif/dliq requests and headers.** Tested: harmless in the short run,
   and dliq refresh fails gracefully. But each extra request/header is another
   chance to differ from the browser.
7. **The Firefox sidecar is uTLS, not Mozilla NSS.** It is much closer than Node,
   but a derived TLS profile is not literal Firefox. A profile/UA mismatch (for
   example, `transportProfile: firefox_159` with a different browser) is a
   false fingerprint. Here the live profile is Zen 159.0 and the UA is Firefox
   159, so they match.
8. **More automatic retries and repair paths.** Tool repair, image upload, hif
   polling, challenge failover, and 429 retries can each turn one client request
   into several upstream requests. The Nov 5 challenge happened during a
   tool-heavy burst: seven completions in about 60 seconds. The tool-result
   cooldown was added on Nov 4, but that burst still preceded the challenge.
   Tool loops are a real pacing risk.
9. **The fixes are uncommitted.** `HEAD` has 10-minute auth quarantine,
   30-minute challenge quarantine, 429 rotation, and no device id / WAF header /
   24-hour quarantine. The working tree is safer, but a deploy from `HEAD` is
   not.
10. **Header drift.** `clientVersion: 2.7.0`, hardcoded `accept-language`, and
    `sec-gpc` may not match the current browser. Weak individually; verify
    against DevTools.

## Why the new router feels worse than the old one

- **Log visibility.** The sidecar logs every upstream request. The old Node
  transport did not. The same number of completions produces far more log lines
  now, which looks like more traffic.
- **Deployment timing.** The new transport and hif refresh landed on Nov 4,
  after the account had already been challenged on Oct 31 and Nov 3. The visible
  final invalidation on Nov 5 is correlation, not proof that the transport
  caused it.
- **The extractor changed.** The new `--write-accounts`/`--watch` validation is a
  real new client. If the logout started after a re-sync rather than after a
  router restart, suspect the validator before the transport.
- **The old code was running the same bad config.** The old router had the same
  rotation feature; the damage came from the 6-7 account config, not from the
  transport.

## Ranked causes of the observed logout / invalid-token pattern

1. **Multi-account rotation** (`accountSwitchAfter: 6`/`15`, 6-7 accounts) with a
   shared IP and fingerprint. Strong, proven by 2,125 switches and the timing.
2. **Dead-token replay.** The config did not match any live browser session at
   one point; every request replayed dead credentials. Strong, proven by live
   state and 732 invalid-token failures.
3. **429 treated as an account failure.** Rate limits rotated the queue and
   increased aggregate traffic. Strong, code + 83 events.
4. **No quarantine in the running version.** Dead tokens were retried
   indefinitely. Strong, code + log.
5. **Stale extraction / token rotation.** A one-time extraction goes stale; the
   website and the router then use different tokens. Strong, live state.
6. **Browser and router using the same account concurrently.** Likely, not
   directly proven. Two clients for one account is exactly what the website
   sees.
7. **Python validator.** Plausible and new; not isolated in a controlled test.
   Do not run it in a loop.
8. **Header/device/GPC drift.** Weak individually; verify against the browser.
9. **hif refresh / Firefox transport.** Not supported by the A/B runs. Both
   toggles returned 200 and did not change the token.

## Operating rules

1. **One account, `accountSwitchAfter: 0`.** Use failover only, never scheduled
   rotation. Remove dead accounts.
2. **Do not run the website and the router on the same account at the same
   time.** Use a dedicated account for the router if possible.
3. **Re-sync once, then stop.** `--write-accounts` validates every token,
   including dead ones. Run it once, keep the live token, and avoid `--watch`
   unless you accept repeated Python/OpenSSL auth requests. For a read-only
   extraction, `--json --no-validate` avoids the extra network call, but it can
   capture a dead token; do not write that result blindly.
4. **Keep `concurrency: 1`, `requestDelaySeconds: 15` or higher, and the
   tool-result cooldown enabled.** The code fallback is still 400 ms if
   `requestDelaySeconds` is unset, so set it explicitly.
5. **Keep `powChallengeEnabled: true`.** `false` is diagnostic only and causes
   `MISSING_HEADER` plus three failed POSTs.
6. **`hifRefreshEnabled`:** keep `true` for fidelity; `false` worked at 27
   minutes in the A/B but is not proven for days. If you want fewer requests,
   `false` is the lower-traffic option and did not immediately break.
7. **`hifDliqRefresh`:** keep `false` on an IPv4-only network. It fails
   gracefully, but the failed IPv6 request is noise.
8. **`transport: firefox`** for the best fingerprint match. `transport: node` is
   a useful diagnostic, not stealth.
9. **Verify `secGpc` and `x-device-id` against DevTools.** If the browser does
   not send `sec-gpc`, set `secGpc: false`. If the device id changes after a
   re-login, re-extract it.
10. **If challenged, stop.** Complete the captcha in the browser, re-sync the
    one account, and do not rotate through the queue to "find a working one".
11. **Prefer the official API if the account matters.** The web endpoint is
    unofficial and the account-level rules are not observable from the client.

## Open questions

- The exact server-side rule that invalidates a token is not observable.
- Static hif beyond 27 minutes was not tested; a days-old value may behave
  differently.
- Whether `sec-gpc`, `x-device-model`, or the replayed `x-device-id` matter is
  unproven.
- Whether the Python validator alone can invalidate a session is plausible but
  not isolated. Testing it deliberately could damage the only live account.
- A controlled test with a throwaway account would be needed to separate
  transport, hif, device id, and validator effects.

## Reproduction notes

The A/B runs used environment overrides so the live config stayed untouched:

```bash
PORT=8891 DEEPSEEK_TRANSPORT=firefox \
  DEEPSEEK_HIF_REFRESH_ENABLED=false DEEPSEEK_HIF_DLIQ_REFRESH=false \
  DEEPSEEK_POW_CHALLENGE_ENABLED=true \
  node src/main.js start --foreground
```

Then one completion:

```bash
curl -sS http://127.0.0.1:8891/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"deepseek-chat","stream":false,
       "messages":[{"role":"user","content":"Reply with exactly the word ok."}]}'
```

Token identity was checked by hashing, never printing:

```bash
python3 scripts/get-token.py --json --no-validate --no-cookies --no-hif \
  | jq -r '.token' | sha256sum | cut -c1-12
```

The live config before the runs is backed up at
`~/.config/deepseek-router/config.json.bak-session-20261106-151748`.
