import test from "node:test";
import assert from "node:assert/strict";
import { FixedWindowRateLimiter } from "../lib/rate-limit.js";

test("allows the configured request count and blocks the next request", () => {
  const limiter = new FixedWindowRateLimiter({ limit: 2, windowMs: 1000 });
  assert.equal(limiter.consume("client", 100).allowed, true);
  assert.equal(limiter.consume("client", 200).allowed, true);
  assert.deepEqual(limiter.consume("client", 300), {
    allowed: false,
    limit: 2,
    remaining: 0,
    resetAt: 1100
  });
});

test("resets the window and bounds unique client keys", () => {
  const limiter = new FixedWindowRateLimiter({ limit: 1, windowMs: 100, maxKeys: 1 });
  assert.equal(limiter.consume("first", 0).allowed, true);
  assert.equal(limiter.consume("second", 50).allowed, false);
  assert.equal(limiter.consume("second", 101).allowed, true);
  assert.equal(limiter.windows.size, 1);
});
