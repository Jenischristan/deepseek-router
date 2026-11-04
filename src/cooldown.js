// Tool-result cooldown
// ===========================================================================
// The router knows when it wrote a tool-call response and when the client comes
// back with the result. The difference is a lower bound on how long the tool
// actually ran, which is all we need to decide whether another wait is useful.
// Only the tool call ids that this process delivered are tracked; a restart or
// a client that drops the ids gets the configured cooldown as a safe fallback.

const DEFAULT_TTL_MS = 60 * 60 * 1000;
const DEFAULT_MAX = 2048;

function toolCallIds(toolCalls) {
  const ids = new Set();
  for (const call of toolCalls || []) {
    const id = call?.id || call?.tool_call_id;
    if (id) ids.add(String(id));
  }
  return [...ids];
}

function resultCallIds(assistant, toolMessages) {
  const ids = new Set(toolCallIds(assistant?.tool_calls));
  for (const message of toolMessages || []) {
    const id = message?.tool_call_id || message?.id;
    if (id) ids.add(String(id));
  }
  return [...ids];
}

export class ToolCooldown {
  constructor({ ttlMs = DEFAULT_TTL_MS, max = DEFAULT_MAX, now = Date.now } = {}) {
    this.ttlMs = Math.max(0, Number(ttlMs) || 0);
    this.max = Math.max(1, Number(max) || 1);
    this.now = now;
    this.deliveredAt = new Map();
  }

  record(toolCalls, at = this.now()) {
    const ids = toolCallIds(toolCalls);
    for (const id of ids) {
      this.deliveredAt.delete(id);
      this.deliveredAt.set(id, at);
    }
    this._prune(at);
    return ids.length;
  }

  // Milliseconds since the matching tool-call response was delivered, or null
  // when this process has no timestamp for any of the result's call ids.
  executionMs({ assistant, toolMessages } = {}, at = this.now()) {
    const ids = resultCallIds(assistant, toolMessages);
    let first = null;
    for (const id of ids) {
      const sentAt = this.deliveredAt.get(id);
      if (sentAt == null) continue;
      if (first == null || sentAt < first) first = sentAt;
    }
    return first == null ? null : Math.max(0, at - first);
  }

  delayFor({ assistant, toolMessages, delayMs, skipAfterMs, at = this.now() } = {}) {
    const wait = Number(delayMs);
    if (!Number.isFinite(wait) || wait <= 0) return 0;
    if (!Array.isArray(toolMessages) || toolMessages.length === 0) return 0;

    const execution = this.executionMs({ assistant, toolMessages }, at);
    // Unknown execution time: pace the result anyway, because a missing
    // timestamp must not turn into a burst for the upstream rate limiter.
    if (execution == null) return Math.round(wait);

    const skip = Number(skipAfterMs);
    if (Number.isFinite(skip) && skip >= 0 && execution >= skip) return 0;
    return Math.round(wait);
  }

  _prune(now) {
    for (const [id, at] of this.deliveredAt) {
      if (now - at > this.ttlMs) this.deliveredAt.delete(id);
    }
    while (this.deliveredAt.size > this.max) {
      this.deliveredAt.delete(this.deliveredAt.keys().next().value);
    }
  }
}
