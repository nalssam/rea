// Per-IP counters. In-memory only; nothing is persisted.

const SEOUL_OFFSET_MS = 9 * 60 * 60 * 1000; // Asia/Seoul is UTC+9 with no DST
const DAY_MS = 24 * 60 * 60 * 1000;

/** Day number that changes exactly at Asia/Seoul midnight. */
export function seoulDayKey(ms) {
  return Math.floor((ms + SEOUL_OFFSET_MS) / DAY_MS);
}

export function createDailyLimiter({ limit, now = Date.now }) {
  let day = seoulDayKey(now());
  let counts = new Map();

  function roll() {
    const today = seoulDayKey(now());
    if (today !== day) {
      day = today;
      counts = new Map();
    }
  }

  return {
    used(ip) {
      roll();
      return counts.get(ip) ?? 0;
    },
    /** Counts one use; returns false (and counts nothing) when the limit is reached. */
    tryConsume(ip) {
      roll();
      const used = counts.get(ip) ?? 0;
      if (used >= limit) return false;
      counts.set(ip, used + 1);
      return true;
    },
  };
}

/** Fixed-window limiter for cheap-but-not-free requests (info lookups). */
export function createWindowLimiter({ limit, windowMs, now = Date.now }) {
  let windowStart = now();
  let counts = new Map();
  return {
    tryConsume(key) {
      const t = now();
      if (t - windowStart >= windowMs) {
        windowStart = t;
        counts = new Map();
      }
      const used = counts.get(key) ?? 0;
      if (used >= limit) return false;
      counts.set(key, used + 1);
      return true;
    },
  };
}

/** Caps how many things one key may have in progress at once (running or waiting). */
export function createInFlightLimiter({ limit }) {
  const counts = new Map();
  return {
    /** @returns {(() => void) | null} a release function, or null when the key is at its cap */
    tryAcquire(key) {
      const used = counts.get(key) ?? 0;
      if (used >= limit) return null;
      counts.set(key, used + 1);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const left = (counts.get(key) ?? 1) - 1;
        if (left <= 0) counts.delete(key);
        else counts.set(key, left);
      };
    },
    get keys() {
      return counts.size;
    },
  };
}
