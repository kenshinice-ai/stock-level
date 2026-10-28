// Per-(store, part) restock state machine shared by the agent and the Worker.
//
// - A part lands the first time it is seen "available" (stock lasts minutes,
//   so there is no confirmation round).
// - It sells out only after `outRounds` consecutive non-available rounds,
//   so one flaky response does not cause a duplicate alert.
// - A part that comes back within `realertMs` of selling out continues the
//   previous restock instead of firing a new alert.
// - Missing, unknown or search-disabled results keep the previous state.

export function createRestockTracker({ outRounds = 2, realertMs = 90000 } = {}) {
  const state = new Map(); // `${store}|${part}` -> { inStock, since, missCount, lastOut }

  function update(storesById, storeIds, parts, now = Date.now()) {
    const landed = [];
    const soldOut = [];

    for (const storeId of storeIds) {
      const store = storesById.get(storeId);
      if (!store) continue;

      for (const part of parts) {
        const info = store.parts[part];
        if (!info || info.status === "unknown" || !info.searchEnabled) continue;

        const key = `${storeId}|${part}`;
        const prev = state.get(key) || { inStock: false, since: 0, missCount: 0, lastOut: 0 };

        if (info.status === "available" && store.pickupEligible) {
          if (prev.inStock) {
            state.set(key, { ...prev, missCount: 0 });
            continue;
          }
          const sameRestock = prev.lastOut && now - prev.lastOut < realertMs;
          state.set(key, { inStock: true, since: sameRestock ? prev.since : now, missCount: 0, lastOut: 0 });
          if (!sameRestock) landed.push({ storeId, part, quote: info.quote, since: now });
        } else if (prev.inStock) {
          const missCount = prev.missCount + 1;
          if (missCount < outRounds) {
            state.set(key, { ...prev, missCount });
            continue;
          }
          state.set(key, { inStock: false, since: prev.since, missCount: 0, lastOut: now });
          soldOut.push({ storeId, part, since: prev.since, durationMs: now - prev.since });
        }
      }
    }

    return { landed, soldOut };
  }

  function inStock() {
    const rows = [];
    for (const [key, s] of state) {
      if (!s.inStock) continue;
      const [storeId, part] = key.split("|");
      rows.push({ storeId, part, since: s.since });
    }
    return rows;
  }

  return { update, inStock };
}
