import crypto from 'node:crypto';

export function conversationKey(
  modelType,
  thinking,
  messages,
  toolsKey = '',
  accountToken = '',
) {
  const hash = crypto.createHash('sha256');
  hash.update(
    JSON.stringify({ modelType, thinking, toolsKey, accountToken, messages }),
  );
  return hash.digest('hex');
}

export class SessionStore {
  constructor({ ttlMs, max }) {
    this.ttlMs = ttlMs;
    this.max = max;
    this.map = new Map();
  }

  _prune() {
    const now = Date.now();
    for (const [key, value] of this.map) {
      if (now - value.updatedAt > this.ttlMs) this.map.delete(key);
    }
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next().value;
      this.map.delete(oldest);
    }
  }

  get(key) {
    this._prune();
    const value = this.map.get(key);
    if (!value) return null;
    value.updatedAt = Date.now();
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  set(key, value) {
    this.map.delete(key);
    this.map.set(key, { ...value, updatedAt: Date.now() });
    this._prune();
  }

  clear() {
    this.map.clear();
  }

  deleteByAccount(accountToken) {
    if (!accountToken) return;
    for (const [key, value] of this.map) {
      if (value.accountToken === accountToken) this.map.delete(key);
    }
  }

  get size() {
    return this.map.size;
  }
}
