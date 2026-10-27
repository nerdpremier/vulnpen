/**
 * Retry policy for the inference paths.
 *
 * One chat turn is many provider requests in a row, so a single transient
 * refusal used to end the whole turn. The refusal usually comes from a gateway
 * in front of a rate-limited or free-tier upstream: it says 429 for a few
 * seconds and then accepts again. Retry those, and the 5xx family a gateway
 * sends while it reconnects an upstream. Never retry a 4xx the caller has to
 * fix (bad key, bad request): the next attempt would fail the same way. A spent
 * daily allowance is the same story told slower — hours, not seconds — so it
 * fails fast with an explanation instead.
 */

export const MAX_PROVIDER_ATTEMPTS = 4;

/** A server asking us to wait longer than this is not worth blocking a turn. */
const MAX_RETRY_DELAY_MS = 15_000;
const BASE_RETRY_DELAY_MS = 1_000;

export interface ProviderRetryOptions {
  /** Cancels the wait between attempts, so Stop still stops a retrying turn. */
  abortSignal?: AbortSignal;
  maxAttempts?: number;
  /** Called before each retry; the streaming path uses it to refuse a retry
   *  once deltas have reached the caller and a second attempt would duplicate
   *  text. */
  canRetry?: () => boolean;
  onRetry?: (err: unknown, attempt: number, delayMs: number) => void;
  /** Test seam: replaces the real timer. */
  sleep?: (ms: number, abortSignal?: AbortSignal) => Promise<void>;
}

function statusOf(err: any): number | undefined {
  const raw = err?.status ?? err?.response?.status ?? err?.error?.code;
  const status = Number(raw);
  return Number.isFinite(status) ? status : undefined;
}

/**
 * A free-tier refusal is not a throttle: the allowance is spent until the daily
 * reset (openCode answers `retry-after: 28000` — hours, not seconds), and the
 * budget is anonymous, so nothing the caller does makes the next attempt work.
 * Retrying it only delays the one message the operator needs to read.
 */
export function isFreeTierExhausted(err: any): boolean {
  return /free usage limit|FreeUsageLimitError/i.test(
    String(err?.message ?? err?.error?.message ?? ""),
  );
}

export function isRetryableProviderError(err: any): boolean {
  if (isFreeTierExhausted(err)) return false;

  const status = statusOf(err);
  if (status === 429) return true;
  if (status !== undefined && status >= 500 && status <= 599) return true;
  return false;
}

/** `Retry-After` as milliseconds, in either its seconds or HTTP-date form. */
export function retryAfterMs(err: any): number | undefined {
  const headers = err?.headers ?? err?.response?.headers;
  const raw =
    (typeof headers?.get === "function" ? headers.get("retry-after") : undefined) ??
    headers?.["retry-after"];
  if (raw === undefined || raw === null || raw === "") return undefined;

  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);

  const date = Date.parse(String(raw));
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

/**
 * The wait before attempt `attempt + 1`: the server's own `Retry-After` when it
 * sent one, otherwise exponential backoff with a little jitter so parallel
 * callers do not retry in lockstep.
 */
export function retryDelayMs(err: any, attempt: number): number {
  const asked = retryAfterMs(err);
  const delay =
    asked ??
    BASE_RETRY_DELAY_MS * 2 ** attempt + Math.floor(Math.random() * 250);
  return Math.min(delay, MAX_RETRY_DELAY_MS);
}

function wait(ms: number, abortSignal?: AbortSignal): Promise<void> {
  if (abortSignal?.aborted) {
    return Promise.reject(new DOMException("Aborted", "AbortError"));
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      abortSignal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    }
    abortSignal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function withProviderRetry<T>(
  run: () => Promise<T>,
  options: ProviderRetryOptions = {},
): Promise<T> {
  const {
    abortSignal,
    maxAttempts = MAX_PROVIDER_ATTEMPTS,
    canRetry = () => true,
    onRetry,
    sleep = wait,
  } = options;

  for (let attempt = 0; ; attempt++) {
    try {
      return await run();
    } catch (err) {
      if (
        abortSignal?.aborted ||
        attempt + 1 >= maxAttempts ||
        !canRetry() ||
        !isRetryableProviderError(err)
      ) {
        throw err;
      }

      const delayMs = retryDelayMs(err, attempt);
      onRetry?.(err, attempt + 1, delayMs);
      await sleep(delayMs, abortSignal);
    }
  }
}

/**
 * Turn the upstream's free-tier refusal into something the operator can act on.
 * The raw body ("Free usage limit reached. Free models work in OpenCode…") names
 * a product the operator may not be using directly, because a router sits in
 * between, and it hides the real shape of the limit: the allowance is granted to
 * the calling IP, not to an account, and it refills on a daily boundary.
 */
export function explainProviderError(err: any): any {
  if (!isFreeTierExhausted(err)) return err;

  const friendly = new Error(
    "The free quota for this model is spent until the daily reset (00:00 UTC). " +
      "OpenCode grants free models anonymously to the calling IP address, not to an account, " +
      "so every app behind the same connection shares one allowance and any of them can use it up. " +
      "Wait for the reset, or point this model at a paid provider (OpenCode Go or any other API key).",
  );
  (friendly as any).status = err?.status;
  (friendly as any).code = "free_tier_exhausted";
  (friendly as any).cause = err;
  return friendly;
}
