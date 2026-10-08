'use strict';

// Tiny memoisation + single-flight cache for expensive, read-only endpoints.
// Concurrent identical requests share one execution; results are cached for a
// TTL (0 = dedupe only, no caching).

const store = new Map(); // key -> { value, expires }
const inflight = new Map(); // key -> Promise
let hits = 0;
let misses = 0;

async function memo(key, ttlMs, fn) {
  const now = Date.now();
  const entry = store.get(key);
  if (entry && entry.expires > now) {
    hits += 1;
    return entry.value;
  }
  if (inflight.has(key)) {
    hits += 1;
    return inflight.get(key);
  }
  misses += 1;
  const promise = Promise.resolve()
    .then(fn)
    .then((value) => {
      if (ttlMs > 0) store.set(key, { value, expires: Date.now() + ttlMs });
      return value;
    })
    .finally(() => {
      inflight.delete(key);
    });
  inflight.set(key, promise);
  return promise;
}

function clear(prefix) {
  for (const key of [...store.keys()]) {
    if (!prefix || key.startsWith(prefix)) store.delete(key);
  }
}

function stats() {
  return { keys: store.size, inflight: inflight.size, hits, misses };
}

module.exports = { memo, clear, stats };
