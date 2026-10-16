export class FixedWindowRateLimiter {
  constructor({ limit, windowMs, maxKeys = 10000 }) {
    if (!Number.isInteger(limit) || limit < 1) throw new TypeError("limit must be a positive integer");
    if (!Number.isInteger(windowMs) || windowMs < 1) throw new TypeError("windowMs must be a positive integer");
    if (!Number.isInteger(maxKeys) || maxKeys < 1) throw new TypeError("maxKeys must be a positive integer");
    this.limit = limit;
    this.windowMs = windowMs;
    this.maxKeys = maxKeys;
    this.windows = new Map();
  }

  consume(key, now = Date.now()) {
    const current = this.windows.get(key);
    if (current && now < current.resetAt) {
      current.count += 1;
      return {
        allowed: current.count <= this.limit,
        limit: this.limit,
        remaining: Math.max(0, this.limit - current.count),
        resetAt: current.resetAt
      };
    }

    for (const [existingKey, window] of this.windows) {
      if (window.resetAt <= now) this.windows.delete(existingKey);
    }
    if (this.windows.size >= this.maxKeys) {
      return { allowed: false, limit: this.limit, remaining: 0, resetAt: now + this.windowMs };
    }

    const resetAt = now + this.windowMs;
    this.windows.set(key, { count: 1, resetAt });
    return { allowed: true, limit: this.limit, remaining: this.limit - 1, resetAt };
  }
}
