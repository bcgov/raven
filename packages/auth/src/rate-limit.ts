/**
 * Rate-limit + circuit-breaker primitives for raven's outbound calls.
 *
 * Three layers stacked per upstream host:
 *   1. Token bucket — caps burst rate; new requests wait for a token.
 *   2. 429/Retry-After handling (fetch only) — respects server back-off.
 *   3. Circuit breaker — opens once N failures accumulate inside a
 *      sliding window. Successes do NOT reset the failure timestamps
 *      (the window does that on its own as time passes), so a flaky
 *      host that mostly works but bursts failures still trips the
 *      breaker. Protects against cascading failed-auth attempts that
 *      would trigger MaxAuthTries / fail2ban on the bastion or upstream
 *      throttling.
 *
 * Designed so a normal interactive session is invisible (token bucket
 * stays full, breaker stays closed). Runaway loops, agent retries, and
 * dead hosts surface clearly instead of silently piling up.
 */

// ─── Token bucket ────────────────────────────────────────────────────

export class TokenBucket {
  private tokens: number;
  private lastRefillMs: number;

  constructor(
    public readonly capacity: number,
    public readonly refillPerSec: number,
    public readonly now: () => number = Date.now,
    public readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((r) => setTimeout(r, ms)),
  ) {
    if (capacity <= 0) throw new Error("TokenBucket: capacity must be > 0");
    if (refillPerSec <= 0) throw new Error("TokenBucket: refillPerSec must be > 0");
    this.tokens = capacity;
    this.lastRefillMs = now();
  }

  /** Current available tokens. Refills based on elapsed time. */
  available(): number {
    this.refill();
    return this.tokens;
  }

  /**
   * Consume one token. Waits up to `timeoutMs` for a token to become
   * available. Returns true if a token was consumed, false on timeout.
   */
  async take(timeoutMs: number): Promise<boolean> {
    const deadline = this.now() + timeoutMs;
    while (true) {
      this.refill();
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return true;
      }
      const remaining = deadline - this.now();
      if (remaining <= 0) return false;
      // Sleep until the next token is expected to be available, but in
      // small increments so we re-check timeout frequently.
      const msUntilNext = Math.max(1, Math.ceil(1000 / this.refillPerSec));
      const sleepMs = Math.min(msUntilNext, remaining, 50);
      if (sleepMs <= 0) return false;
      await this.sleep(sleepMs);
    }
  }

  private refill(): void {
    const now = this.now();
    const elapsedSec = (now - this.lastRefillMs) / 1000;
    if (elapsedSec <= 0) return;
    this.tokens = Math.min(
      this.capacity,
      this.tokens + elapsedSec * this.refillPerSec,
    );
    this.lastRefillMs = now;
  }
}

// ─── Circuit breaker ─────────────────────────────────────────────────

export type BreakerState = "closed" | "open" | "half-open";

export class CircuitBreaker {
  private state: BreakerState = "closed";
  private failureTimestamps: number[] = [];
  private openedAtMs = 0;

  constructor(
    public readonly failureThreshold: number,
    public readonly windowMs: number,
    public readonly cooldownMs: number,
    private readonly now: () => number = Date.now,
  ) {
    if (failureThreshold <= 0) throw new Error("CircuitBreaker: failureThreshold must be > 0");
  }

  getState(): BreakerState {
    if (this.state === "open" && this.now() - this.openedAtMs >= this.cooldownMs) {
      this.state = "half-open";
    }
    return this.state;
  }

  /** True if a call should be allowed through. */
  isAllowed(): boolean {
    return this.getState() !== "open";
  }

  recordSuccess(): void {
    if (this.state === "half-open") {
      this.state = "closed";
      this.failureTimestamps = [];
    }
  }

  recordFailure(): void {
    // Open-state guard: if a caller bypasses isAllowed() (or wins a race
    // where state flipped between the gate and this call), don't reset
    // openedAtMs — that would extend the cooldown indefinitely as long
    // as failures keep landing on an already-open breaker.
    if (this.state === "open") return;

    const now = this.now();
    if (this.state === "half-open") {
      this.state = "open";
      this.openedAtMs = now;
      return;
    }
    this.failureTimestamps = this.failureTimestamps.filter(
      (t) => now - t < this.windowMs,
    );
    this.failureTimestamps.push(now);
    if (this.failureTimestamps.length >= this.failureThreshold) {
      this.state = "open";
      this.openedAtMs = now;
    }
  }
}

// ─── HostLimiter — bucket + breaker bundled ──────────────────────────

export class RateLimitError extends Error {
  constructor(
    public readonly kind: "circuit-open" | "local-throttle",
    message: string,
  ) {
    super(message);
    this.name = "RateLimitError";
  }
}

export class HostLimiter {
  constructor(
    public readonly host: string,
    public readonly bucket: TokenBucket,
    public readonly breaker: CircuitBreaker,
  ) {}

  /**
   * Acquire permission to make one call. Throws RateLimitError if the
   * circuit is open or no token becomes available within `timeoutMs`.
   */
  async acquire(timeoutMs: number): Promise<void> {
    if (!this.breaker.isAllowed()) {
      throw new RateLimitError(
        "circuit-open",
        `Circuit breaker open for ${this.host} — too many recent failures.`,
      );
    }
    const got = await this.bucket.take(timeoutMs);
    if (!got) {
      throw new RateLimitError(
        "local-throttle",
        `Local rate limit hit for ${this.host} — request waited > ${timeoutMs}ms for a token.`,
      );
    }
  }

  recordSuccess(): void {
    this.breaker.recordSuccess();
  }

  recordFailure(): void {
    this.breaker.recordFailure();
  }
}

// ─── Registry ────────────────────────────────────────────────────────

export interface LimiterOpts {
  burst: number;
  rps: number;
  breakerFailures: number;
  breakerWindowSec: number;
  breakerCooldownSec: number;
}

const limiters = new Map<string, HostLimiter>();

/**
 * Get-or-create the limiter for a host. The opts are read on FIRST creation
 * for a given host; subsequent calls return the existing limiter unchanged.
 * For tests, use {@link _resetLimiters}.
 */
export function getHostLimiter(host: string, opts: LimiterOpts): HostLimiter {
  let lim = limiters.get(host);
  if (!lim) {
    lim = new HostLimiter(
      host,
      new TokenBucket(opts.burst, opts.rps),
      new CircuitBreaker(
        opts.breakerFailures,
        opts.breakerWindowSec * 1000,
        opts.breakerCooldownSec * 1000,
      ),
    );
    limiters.set(host, lim);
  }
  return lim;
}

/** Test helper: clear the limiter registry. */
export function _resetLimiters(): void {
  limiters.clear();
}

// ─── Env-based default opts ──────────────────────────────────────────

function readEnvInt(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function atlassianLimiterOpts(): LimiterOpts {
  return {
    burst: readEnvInt("RATE_LIMIT_ATLASSIAN_BURST", 30),
    rps: readEnvInt("RATE_LIMIT_ATLASSIAN_RPS", 10),
    breakerFailures: readEnvInt("RATE_LIMIT_BREAKER_FAILURES", 3),
    breakerWindowSec: readEnvInt("RATE_LIMIT_BREAKER_WINDOW_S", 30),
    breakerCooldownSec: readEnvInt("RATE_LIMIT_BREAKER_COOLDOWN_S", 30),
  };
}

export function sshLimiterOpts(): LimiterOpts {
  return {
    burst: readEnvInt("RATE_LIMIT_SSH_BURST", 5),
    rps: readEnvInt("RATE_LIMIT_SSH_RPS", 2),
    breakerFailures: readEnvInt("RATE_LIMIT_BREAKER_FAILURES", 3),
    breakerWindowSec: readEnvInt("RATE_LIMIT_BREAKER_WINDOW_S", 30),
    breakerCooldownSec: readEnvInt("RATE_LIMIT_BREAKER_COOLDOWN_S", 30),
  };
}

// ─── Fetch wrapper (Atlassian APIs) ──────────────────────────────────

/**
 * Parse a `Retry-After` header. Returns milliseconds to wait, or undefined
 * if the header is missing or unparseable. Supports both the seconds form
 * ("30") and the HTTP-date form ("Wed, 21 Oct 2025 07:28:00 GMT").
 */
export function parseRetryAfter(header: string | null | undefined): number | undefined {
  if (!header) return undefined;
  const trimmed = header.trim();
  // Seconds form
  const seconds = parseInt(trimmed, 10);
  if (Number.isFinite(seconds) && String(seconds) === trimmed) {
    return seconds * 1000;
  }
  // HTTP-date form
  const date = Date.parse(trimmed);
  if (Number.isFinite(date)) {
    const ms = date - Date.now();
    return ms > 0 ? ms : 0;
  }
  return undefined;
}

export interface FetchLimitsOpts extends LimiterOpts {
  /** Max time to wait for a token before failing. Default 5000ms. */
  acquireTimeoutMs?: number;
  /** Max retries on 429 responses. Default 2. */
  maxRetriesOn429?: number;
  /** Cap on Retry-After waits. Default 30_000ms. */
  retryAfterCapMs?: number;
}

/**
 * Wrap a fetch function with per-host rate limiting + 429/Retry-After
 * handling + circuit breaker. The returned fetch is interface-compatible
 * with the input.
 */
export function wrapFetchWithLimits(
  fetchFn: typeof fetch,
  opts: FetchLimitsOpts,
): typeof fetch {
  const acquireTimeoutMs = opts.acquireTimeoutMs ?? 5000;
  const maxRetries = opts.maxRetriesOn429 ?? 2;
  const retryCap = opts.retryAfterCapMs ?? 30_000;

  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    const host = new URL(url).host;
    const limiter = getHostLimiter(host, opts);

    let attempt = 0;
    while (true) {
      // Acquire a token PER ATTEMPT (not just once before the loop). 429
      // retries are real outbound requests; without per-attempt acquire,
      // a runaway loop hitting Retry-After could fire many requests off
      // a single token, defeating the per-host bucket during exactly the
      // throttling scenarios it's meant to protect against.
      //
      // RateLimitError on acquire() is converted to a synthetic 429
      // Response so downstream callers (createBasicAuthFetch, etc.) see a
      // shape they already handle. Throwing RateLimitError out of fetch()
      // would surprise every consumer that wraps fetch and only knows
      // about HTTP status codes / network errors.
      try {
        await limiter.acquire(acquireTimeoutMs);
      } catch (err) {
        if (err instanceof RateLimitError) {
          return new Response(err.message, {
            status: 429,
            statusText: err.kind === "circuit-open" ? "Circuit Open" : "Local Throttle",
          });
        }
        throw err;
      }

      let response: Response;
      try {
        response = await fetchFn(input, init);
      } catch (err) {
        limiter.recordFailure();
        throw err;
      }

      if (response.status === 429 && attempt < maxRetries) {
        const retryAfter = parseRetryAfter(response.headers.get("retry-after"));
        const backoff = retryAfter ?? 1000 * Math.pow(2, attempt);
        await new Promise((r) => setTimeout(r, Math.min(backoff, retryCap)));
        attempt++;
        continue;
      }

      // Final response — record outcome.
      if (response.status === 429 || (response.status >= 500 && response.status !== 503)) {
        limiter.recordFailure();
      } else {
        limiter.recordSuccess();
      }
      return response;
    }
  }) as typeof fetch;
}

// ─── SSH wrapper ─────────────────────────────────────────────────────

export interface SshLimitsOpts extends LimiterOpts {
  acquireTimeoutMs?: number;
}

export interface SshLikeResult {
  exitCode: number;
  stderr: string;
  stdout: string;
}

/**
 * Wrap an sshExec-shaped function with per-host rate limiting + circuit
 * breaker. The wrapper extracts the host from the first argument via
 * `getHost` and routes through {@link HostLimiter}.
 *
 * Outcome accounting:
 *   - exitCode 0 → recordSuccess
 *   - non-zero with auth/connect-shaped stderr → recordFailure
 *   - non-zero with any other stderr (e.g., grep no-match, missing file) →
 *     recordSuccess. The host responded to us, which proves reachability;
 *     the command's failure isn't a host-health signal. Without this,
 *     half-open transitions could get stuck because non-auth failures
 *     neither closed nor re-opened the breaker.
 *   - thrown exception (e.g., transport error) → recordFailure
 *
 * Two overloads:
 *   1. R = SshLikeResult — factory not required; the default builds
 *      { exitCode, stderr, stdout } on RateLimitError.
 *   2. R extends SshLikeResult with EXTRA required fields — factory is
 *      required by the type system. Without this constraint, an
 *      `as unknown as R` cast would let us return a result missing
 *      caller-required fields (e.g., a custom `host` property), and
 *      `result.host` would silently be `undefined` at runtime.
 */
export function wrapSshExecWithLimits<Args extends unknown[]>(
  execFn: (...args: Args) => Promise<SshLikeResult>,
  getHost: (args: Args) => string,
  opts: SshLimitsOpts & { makeRateLimitError?: (err: RateLimitError) => SshLikeResult },
): (...args: Args) => Promise<SshLikeResult>;
export function wrapSshExecWithLimits<Args extends unknown[], R extends SshLikeResult>(
  execFn: (...args: Args) => Promise<R>,
  getHost: (args: Args) => string,
  opts: SshLimitsOpts & { makeRateLimitError: (err: RateLimitError) => R },
): (...args: Args) => Promise<R>;
export function wrapSshExecWithLimits<Args extends unknown[], R extends SshLikeResult>(
  execFn: (...args: Args) => Promise<R>,
  getHost: (args: Args) => string,
  opts: SshLimitsOpts & { makeRateLimitError?: (err: RateLimitError) => R },
): (...args: Args) => Promise<R> {
  const acquireTimeoutMs = opts.acquireTimeoutMs ?? 5000;
  const makeRateLimitError: (err: RateLimitError) => R =
    opts.makeRateLimitError ??
    // Safe under the first overload (R = SshLikeResult). The second
    // overload makes makeRateLimitError required at the type level, so
    // this default only fires for the exactly-SshLikeResult case.
    ((err: RateLimitError) => ({ exitCode: 1, stderr: err.message, stdout: "" } as R));

  return async (...args: Args): Promise<R> => {
    const host = getHost(args);
    const limiter = getHostLimiter(host, opts);

    try {
      await limiter.acquire(acquireTimeoutMs);
    } catch (err) {
      if (err instanceof RateLimitError) {
        return makeRateLimitError(err);
      }
      throw err;
    }

    try {
      const result = await execFn(...args);
      if (result.exitCode === 0) {
        limiter.recordSuccess();
      } else {
        const stderr = (result.stderr ?? "").toLowerCase();
        const looksLikeAuthOrConnect =
          /auth|password|denied|unauthorized|timed out|timeout|refused|unreachable|reset|host key/.test(
            stderr,
          );
        if (looksLikeAuthOrConnect) {
          limiter.recordFailure();
        } else {
          // Non-auth, non-connect non-zero exit = the host responded with
          // a normal shell-level error (grep no-match, missing file, etc.).
          // That's still proof of reachability — count it as success so
          // half-open can resolve back to closed.
          limiter.recordSuccess();
        }
      }
      return result;
    } catch (err) {
      limiter.recordFailure();
      throw err;
    }
  };
}
