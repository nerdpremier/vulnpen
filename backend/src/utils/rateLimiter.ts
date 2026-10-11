// In-memory per-key rate limiter (fixed window). State is per process.
export const createRateLimiter = (max: number, windowMs: number, now: () => number = Date.now) => {
  const attempts = new Map<string, { count: number; resetAt: number }>();
  return (key: string): boolean => {
    const t = now();
    const entry = attempts.get(key);
    if (!entry || entry.resetAt <= t) {
      attempts.set(key, { count: 1, resetAt: t + windowMs });
      // Opportunistic cleanup of expired entries.
      for (const [k, value] of attempts) {
        if (value.resetAt <= t) attempts.delete(k);
      }
      return false;
    }
    entry.count += 1;
    return entry.count > max;
  };
};
