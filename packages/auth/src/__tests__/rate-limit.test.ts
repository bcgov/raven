import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  TokenBucket,
  CircuitBreaker,
  HostLimiter,
  RateLimitError,
  getHostLimiter,
  _resetLimiters,
  parseRetryAfter,
  wrapFetchWithLimits,
  wrapSshExecWithLimits,
} from "../rate-limit.js";

beforeEach(() => {
  _resetLimiters();
});

// ─── TokenBucket ─────────────────────────────────────────────────────

describe("TokenBucket", () => {
  /** Make a controllable-time bucket. */
  function makeBucket(capacity: number, rps: number) {
    let now = 0;
    const sleeps: number[] = [];
    const bucket = new TokenBucket(
      capacity,
      rps,
      () => now,
      async (ms) => {
        sleeps.push(ms);
        now += ms;
      },
    );
    return { bucket, advance: (ms: number) => (now += ms), sleeps, getNow: () => now };
  }

  it("starts full at capacity", () => {
    const { bucket } = makeBucket(5, 10);
    expect(bucket.available()).toBe(5);
  });

  it("consumes one token per take()", async () => {
    const { bucket } = makeBucket(5, 10);
    expect(await bucket.take(0)).toBe(true);
    expect(bucket.available()).toBeCloseTo(4, 5);
  });

  it("refills at refillPerSec rate", () => {
    const { bucket, advance } = makeBucket(10, 5);
    // Drain to 0
    bucket["tokens"] = 0;
    bucket["lastRefillMs"] = 0;
    advance(1000); // 1 second at 5/sec → 5 tokens
    expect(bucket.available()).toBeCloseTo(5, 5);
  });

  it("caps refill at capacity", () => {
    const { bucket, advance } = makeBucket(3, 100);
    advance(60_000); // 60 seconds at 100/sec would be 6000, but cap is 3
    expect(bucket.available()).toBe(3);
  });

  it("waits for a token when empty, succeeds when one becomes available", async () => {
    const { bucket } = makeBucket(2, 10); // 10/sec → 100ms per token
    await bucket.take(0); // consume 1
    await bucket.take(0); // consume 2 — bucket empty
    const took = await bucket.take(500); // up to 500ms
    expect(took).toBe(true);
  });

  it("returns false if no token available within timeout", async () => {
    const { bucket } = makeBucket(1, 1); // 1/sec → 1000ms per token
    await bucket.take(0); // empty
    const took = await bucket.take(50); // only 50ms — not enough
    expect(took).toBe(false);
  });

  it("rejects invalid configuration", () => {
    expect(() => new TokenBucket(0, 5)).toThrow();
    expect(() => new TokenBucket(5, 0)).toThrow();
  });
});

// ─── CircuitBreaker ──────────────────────────────────────────────────

describe("CircuitBreaker", () => {
  function makeBreaker(threshold: number, windowMs: number, cooldownMs: number) {
    let now = 0;
    const breaker = new CircuitBreaker(threshold, windowMs, cooldownMs, () => now);
    return { breaker, advance: (ms: number) => (now += ms) };
  }

  it("starts closed and allows calls", () => {
    const { breaker } = makeBreaker(3, 30_000, 30_000);
    expect(breaker.isAllowed()).toBe(true);
    expect(breaker.getState()).toBe("closed");
  });

  it("opens once the threshold count of failures lands within the window (not necessarily consecutive)", () => {
    const { breaker } = makeBreaker(3, 30_000, 30_000);
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.isAllowed()).toBe(true); // 2 < 3
    breaker.recordFailure();
    expect(breaker.isAllowed()).toBe(false);
    expect(breaker.getState()).toBe("open");
  });

  it("intervening successes do NOT clear the failure window (windowed, not consecutive)", () => {
    const { breaker } = makeBreaker(3, 30_000, 30_000);
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordSuccess(); // closed-state success is not a reset
    breaker.recordFailure();
    expect(breaker.isAllowed()).toBe(false);
    expect(breaker.getState()).toBe("open");
  });

  it("does NOT open if failures span beyond window", () => {
    const { breaker, advance } = makeBreaker(3, 1000, 30_000);
    breaker.recordFailure();
    advance(500);
    breaker.recordFailure();
    advance(600); // first failure now > 1000ms ago
    breaker.recordFailure();
    expect(breaker.isAllowed()).toBe(true);
  });

  it("transitions open → half-open after cooldownMs", () => {
    const { breaker, advance } = makeBreaker(2, 30_000, 1000);
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.getState()).toBe("open");
    advance(500);
    expect(breaker.getState()).toBe("open");
    advance(600); // total 1100 > cooldown
    expect(breaker.getState()).toBe("half-open");
    expect(breaker.isAllowed()).toBe(true);
  });

  it("recordFailure() in open state does NOT extend the cooldown", () => {
    // Without the guard, a failure landing on an already-open breaker
    // would re-set openedAtMs and push the half-open transition further
    // out — masking the original cooldown. With the guard, the breaker
    // still flips to half-open on schedule even if more failures hit.
    const { breaker, advance } = makeBreaker(2, 30_000, 1000);
    breaker.recordFailure();
    breaker.recordFailure(); // breaker is now open
    expect(breaker.getState()).toBe("open");
    advance(500);
    breaker.recordFailure(); // would have reset openedAtMs without the guard
    advance(600); // total 1100 — would still be open if guard missed
    expect(breaker.getState()).toBe("half-open");
  });

  it("half-open + success → closed", () => {
    const { breaker, advance } = makeBreaker(2, 30_000, 1000);
    breaker.recordFailure();
    breaker.recordFailure();
    advance(1100);
    breaker.getState(); // triggers transition to half-open
    breaker.recordSuccess();
    expect(breaker.getState()).toBe("closed");
  });

  it("half-open + failure → re-open with new cooldown", () => {
    const { breaker, advance } = makeBreaker(2, 30_000, 1000);
    breaker.recordFailure();
    breaker.recordFailure();
    advance(1100);
    breaker.getState(); // half-open
    breaker.recordFailure();
    expect(breaker.getState()).toBe("open");
    expect(breaker.isAllowed()).toBe(false);
  });

  it("success in closed state does not change anything", () => {
    const { breaker } = makeBreaker(3, 30_000, 30_000);
    breaker.recordSuccess();
    expect(breaker.getState()).toBe("closed");
  });
});

// ─── HostLimiter ─────────────────────────────────────────────────────

describe("HostLimiter", () => {
  it("allows a call when bucket has tokens and breaker is closed", async () => {
    const lim = new HostLimiter(
      "x.example.com",
      new TokenBucket(5, 10),
      new CircuitBreaker(3, 30_000, 30_000),
    );
    await expect(lim.acquire(1000)).resolves.toBeUndefined();
  });

  it("throws RateLimitError(circuit-open) when breaker is open", async () => {
    const breaker = new CircuitBreaker(2, 30_000, 30_000);
    breaker.recordFailure();
    breaker.recordFailure();
    const lim = new HostLimiter(
      "x.example.com",
      new TokenBucket(5, 10),
      breaker,
    );
    await expect(lim.acquire(1000)).rejects.toMatchObject({
      kind: "circuit-open",
    });
  });

  it("throws RateLimitError(local-throttle) when bucket is exhausted", async () => {
    const bucket = new TokenBucket(1, 1);
    await bucket.take(0); // drain
    const lim = new HostLimiter(
      "x.example.com",
      bucket,
      new CircuitBreaker(3, 30_000, 30_000),
    );
    await expect(lim.acquire(50)).rejects.toMatchObject({
      kind: "local-throttle",
    });
  });
});

// ─── getHostLimiter / registry ───────────────────────────────────────

describe("getHostLimiter", () => {
  it("returns the same instance for the same host", () => {
    const opts = { burst: 5, rps: 10, breakerFailures: 3, breakerWindowSec: 30, breakerCooldownSec: 30 };
    const a = getHostLimiter("a.example.com", opts);
    const b = getHostLimiter("a.example.com", opts);
    expect(a).toBe(b);
  });

  it("returns different instances for different hosts", () => {
    const opts = { burst: 5, rps: 10, breakerFailures: 3, breakerWindowSec: 30, breakerCooldownSec: 30 };
    const a = getHostLimiter("a.example.com", opts);
    const b = getHostLimiter("b.example.com", opts);
    expect(a).not.toBe(b);
  });
});

// ─── parseRetryAfter ─────────────────────────────────────────────────

describe("parseRetryAfter", () => {
  it("parses seconds form", () => {
    expect(parseRetryAfter("30")).toBe(30_000);
    expect(parseRetryAfter("0")).toBe(0);
  });

  it("parses HTTP-date form", () => {
    const futureDate = new Date(Date.now() + 5_000).toUTCString();
    const ms = parseRetryAfter(futureDate);
    expect(ms).toBeDefined();
    expect(ms!).toBeGreaterThan(3_000);
    expect(ms!).toBeLessThanOrEqual(6_000);
  });

  it("returns 0 for past HTTP-date", () => {
    const pastDate = new Date(Date.now() - 60_000).toUTCString();
    expect(parseRetryAfter(pastDate)).toBe(0);
  });

  it("returns undefined for missing or unparseable", () => {
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter("")).toBeUndefined();
    expect(parseRetryAfter("not a number or date")).toBeUndefined();
  });
});

// ─── wrapFetchWithLimits — 429 handling and breaker integration ──────

describe("wrapFetchWithLimits", () => {
  function makeResponse(status: number, headers: Record<string, string> = {}): Response {
    return new Response("body", { status, headers });
  }

  it("passes through a 200 response unchanged", async () => {
    const upstream = vi.fn().mockResolvedValue(makeResponse(200));
    const wrapped = wrapFetchWithLimits(upstream, {
      burst: 10, rps: 10,
      breakerFailures: 3, breakerWindowSec: 30, breakerCooldownSec: 30,
    });
    const resp = await wrapped("https://example.com/api");
    expect(resp.status).toBe(200);
    expect(upstream).toHaveBeenCalledOnce();
  });

  it("retries on 429 up to maxRetriesOn429, respecting Retry-After (seconds)", async () => {
    const upstream = vi
      .fn()
      .mockResolvedValueOnce(makeResponse(429, { "retry-after": "0" }))
      .mockResolvedValueOnce(makeResponse(429, { "retry-after": "0" }))
      .mockResolvedValueOnce(makeResponse(200));
    const wrapped = wrapFetchWithLimits(upstream, {
      burst: 10, rps: 10,
      breakerFailures: 3, breakerWindowSec: 30, breakerCooldownSec: 30,
      maxRetriesOn429: 2,
    });
    const resp = await wrapped("https://retry.example.com/api");
    expect(resp.status).toBe(200);
    expect(upstream).toHaveBeenCalledTimes(3);
  });

  it("returns the 429 response after exhausting retries", async () => {
    const upstream = vi
      .fn()
      .mockResolvedValue(makeResponse(429, { "retry-after": "0" }));
    const wrapped = wrapFetchWithLimits(upstream, {
      burst: 10, rps: 10,
      breakerFailures: 3, breakerWindowSec: 30, breakerCooldownSec: 30,
      maxRetriesOn429: 1,
    });
    const resp = await wrapped("https://exhaust.example.com/api");
    expect(resp.status).toBe(429);
    expect(upstream).toHaveBeenCalledTimes(2); // initial + 1 retry
  });

  it("records breaker failures on 5xx and opens the circuit", async () => {
    const upstream = vi.fn().mockResolvedValue(makeResponse(500));
    const wrapped = wrapFetchWithLimits(upstream, {
      burst: 10, rps: 10,
      breakerFailures: 2, breakerWindowSec: 30, breakerCooldownSec: 30,
    });
    await wrapped("https://broken.example.com/api"); // failure 1
    await wrapped("https://broken.example.com/api"); // failure 2 — opens breaker
    // Third call: fail-fast as a synthetic 429 Response (no upstream call).
    // The wrapper converts RateLimitError(circuit-open) to a 429 so
    // callers see a familiar shape instead of a new exception type.
    const r = await wrapped("https://broken.example.com/api");
    expect(r.status).toBe(429);
    expect(r.statusText).toBe("Circuit Open");
    expect(upstream).toHaveBeenCalledTimes(2);
  });

  it("503 (service unavailable) does NOT trip the breaker", async () => {
    // 503 is often a transient signal from a load balancer; we don't want
    // it to compound into a breaker trip on top of the host's own retry.
    const upstream = vi.fn().mockResolvedValue(makeResponse(503));
    const wrapped = wrapFetchWithLimits(upstream, {
      burst: 10, rps: 10,
      breakerFailures: 2, breakerWindowSec: 30, breakerCooldownSec: 30,
    });
    await wrapped("https://temp.example.com/api");
    await wrapped("https://temp.example.com/api");
    await wrapped("https://temp.example.com/api"); // would be #3 if 503 counted
    expect(upstream).toHaveBeenCalledTimes(3);
  });

  it("4xx (non-429) does NOT trip the breaker", async () => {
    const upstream = vi.fn().mockResolvedValue(makeResponse(404));
    const wrapped = wrapFetchWithLimits(upstream, {
      burst: 10, rps: 10,
      breakerFailures: 2, breakerWindowSec: 30, breakerCooldownSec: 30,
    });
    await wrapped("https://nf.example.com/api");
    await wrapped("https://nf.example.com/api");
    await wrapped("https://nf.example.com/api");
    expect(upstream).toHaveBeenCalledTimes(3);
  });

  it("propagates network errors and counts them as breaker failures", async () => {
    const upstream = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const wrapped = wrapFetchWithLimits(upstream, {
      burst: 10, rps: 10,
      breakerFailures: 2, breakerWindowSec: 30, breakerCooldownSec: 30,
    });
    await expect(wrapped("https://down.example.com/api")).rejects.toThrow("ECONNREFUSED");
    await expect(wrapped("https://down.example.com/api")).rejects.toThrow("ECONNREFUSED");
    // Breaker is now open. Third call: acquire() throws RateLimitError, the
    // wrapper converts it to a synthetic 429 Response so downstream fetch
    // consumers see a shape they already handle. NOT a thrown error —
    // callers like createBasicAuthFetch don't expect new exception types
    // out of fetch().
    const r = await wrapped("https://down.example.com/api");
    expect(r.status).toBe(429);
    expect(r.statusText).toBe("Circuit Open");
  });

  it("converts a local-throttle (bucket exhausted) RateLimitError into a 429 too", async () => {
    const upstream = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
    const wrapped = wrapFetchWithLimits(upstream, {
      burst: 1, rps: 1,
      breakerFailures: 5, breakerWindowSec: 30, breakerCooldownSec: 30,
      acquireTimeoutMs: 50,
    });
    await wrapped("https://slow.example.com/api"); // drain bucket
    const r = await wrapped("https://slow.example.com/api"); // bucket empty + low timeout
    expect(r.status).toBe(429);
    expect(r.statusText).toBe("Local Throttle");
  });
});

// ─── wrapSshExecWithLimits ───────────────────────────────────────────

describe("wrapSshExecWithLimits", () => {
  it("passes through exitCode 0 calls and records success", async () => {
    const exec = vi.fn().mockResolvedValue({ exitCode: 0, stderr: "", stdout: "ok" });
    const wrapped = wrapSshExecWithLimits(
      exec,
      ([host]: [string]) => host,
      { burst: 10, rps: 10, breakerFailures: 3, breakerWindowSec: 30, breakerCooldownSec: 30 },
    );
    const r = await wrapped("h.example.com");
    expect(r.exitCode).toBe(0);
    expect(exec).toHaveBeenCalledOnce();
  });

  it("counts auth/connect failures toward breaker", async () => {
    const exec = vi.fn().mockResolvedValue({
      exitCode: 1,
      stderr: "Permission denied (publickey,password)",
    });
    const wrapped = wrapSshExecWithLimits(
      exec,
      ([host]: [string]) => host,
      { burst: 10, rps: 10, breakerFailures: 2, breakerWindowSec: 30, breakerCooldownSec: 30 },
    );
    await wrapped("denied.example.com");
    await wrapped("denied.example.com");
    // Third call should fail-fast with circuit-open without invoking exec
    const r = await wrapped("denied.example.com");
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("Circuit breaker open");
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it("treats non-auth failures (e.g., grep no match) as host-reachability successes, not breaker failures", async () => {
    // grep returning exitCode 1 because no match — host responded fine,
    // just no results. These count as recordSuccess (they're proof of
    // reachability), so the breaker stays closed AND a half-open breaker
    // can resolve back to closed off these signals.
    const exec = vi.fn().mockResolvedValue({ exitCode: 1, stderr: "", stdout: "" });
    const wrapped = wrapSshExecWithLimits(
      exec,
      ([host]: [string]) => host,
      { burst: 10, rps: 10, breakerFailures: 2, breakerWindowSec: 30, breakerCooldownSec: 30 },
    );
    await wrapped("ok.example.com");
    await wrapped("ok.example.com");
    await wrapped("ok.example.com"); // would be #3 if it counted as failure
    expect(exec).toHaveBeenCalledTimes(3);
  });

  it("returns a result-shaped error rather than throwing on local-throttle", async () => {
    const exec = vi.fn().mockResolvedValue({ exitCode: 0, stderr: "" });
    const wrapped = wrapSshExecWithLimits(
      exec,
      ([host]: [string]) => host,
      {
        burst: 1, rps: 1,
        breakerFailures: 3, breakerWindowSec: 30, breakerCooldownSec: 30,
        acquireTimeoutMs: 50,
      },
    );
    await wrapped("slow.example.com"); // drain bucket
    const r = await wrapped("slow.example.com"); // bucket empty + low timeout
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("Local rate limit");
    expect(r.stdout).toBe(""); // shape includes stdout, satisfying SshResult
    expect(exec).toHaveBeenCalledOnce();
  });

  it("supports a custom makeRateLimitError factory for callers with extra result fields", async () => {
    interface ExtendedResult { exitCode: number; stderr: string; stdout: string; host: string; }
    const exec = vi.fn().mockResolvedValue({ exitCode: 0, stderr: "", stdout: "ok", host: "h" });
    const wrapped = wrapSshExecWithLimits<[string], ExtendedResult>(
      exec,
      ([host]) => host,
      {
        burst: 1, rps: 1,
        breakerFailures: 3, breakerWindowSec: 30, breakerCooldownSec: 30,
        acquireTimeoutMs: 50,
        makeRateLimitError: (err) => ({ exitCode: 1, stderr: err.message, stdout: "", host: "throttled" }),
      },
    );
    await wrapped("h.example.com"); // drain bucket
    const r = await wrapped("h.example.com");
    expect(r.host).toBe("throttled");
    expect(r.stdout).toBe("");
  });
});
