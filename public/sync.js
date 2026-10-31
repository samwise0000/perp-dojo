// Pulling history, run by the page: one call to /api/pull per 7-day window
// (Bybit's maximum), so each server call stays short. The result is a cache
// object the page keeps in IndexedDB: raw closed-P&L records, fills, and the
// spans covered.
export const DAY = 86_400_000;
const WINDOW = 7 * DAY;
const FILL_LEAD = 14 * DAY;          // fills from before the range, so positions opened just before still get a hold time
const CATEGORIES = ['linear', 'inverse'];

export const emptyCache = uid => ({ v: 3, uid: uid ?? null, raw: {}, execs: {}, covered: [], syncedAt: null });

// Merge [from, to] into a sorted list of covered intervals.
export function addCovered(list, from, to) {
  const all = [...list, [from, to]].sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const [a, b] of all) {
    const last = out[out.length - 1];
    if (last && a <= last[1] + 1) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

// Pull [from, to]. `replace` makes the result exactly that span; without it the
// new data merges into `cache` (Refresh). Either way `cache` itself is never
// modified: a new object comes back, so a failed pull leaves the old data intact.
// fetchWindow({ category, start, end, fillsOnly }) → { uid, rows, fills, warning? }
export async function pull(cache, { from, to, replace = false, earliest, now = Date.now() }, { fetchWindow, onProgress = () => {} }) {
  const next = replace || !cache ? emptyCache(cache?.uid) : structuredClone(cache);
  const warnings = [];
  to = Math.min(to ?? now, now);
  if (from === undefined || from === null) {
    const cov = next.covered;
    from = (cov.length ? cov[cov.length - 1][1] : now - 30 * DAY) - DAY;   // refresh: overlap a day for late updates
  }
  if (earliest && from < earliest) {
    warnings.push(`Bybit only keeps about two years of closed P&L, so the pull starts at ${new Date(earliest).toISOString().slice(0, 10)}.`);
    from = earliest;
  }
  if (from >= to) return { cache: cache || next, added: 0, warnings: [...warnings, 'Nothing to pull: the start date is after the end date.'], from, to, total: Object.keys(cache?.raw || {}).length };

  const windows = [];
  for (let s = Math.max(from - FILL_LEAD, earliest ?? -Infinity); s < from; s += WINDOW) windows.push([s, Math.min(s + WINDOW - 1, from - 1), true]);
  for (let s = from; s < to; s += WINDOW) windows.push([s, Math.min(s + WINDOW - 1, to), false]);
  const total = windows.length * CATEGORIES.length;
  let done = 0, added = 0;

  for (const category of CATEGORIES) {
    for (const [start, end, fillsOnly] of windows) {
      const r = await fetchWindow({ category, start, end, fillsOnly });
      if (r.uid !== undefined && next.uid !== null && String(next.uid) !== String(r.uid)) {
        // a different Bybit account: never mix histories
        Object.assign(next, emptyCache(r.uid));
      }
      next.uid = r.uid ?? next.uid;
      for (const row of r.rows || []) {
        const id = `${category}:${row.orderId}:${row.updatedTime}`;
        if (!next.raw[id]) added++;
        next.raw[id] = { r: row, category };
      }
      for (const f of r.fills || []) { const { id, ...rest } = f; next.execs[`${category}:${id}`] = rest; }
      if (r.warning) warnings.push(`${category} ${new Date(start).toISOString().slice(0, 10)}: ${r.warning}`);
      done++;
      onProgress({ done, total, added, category, through: end });
    }
  }
  next.covered = addCovered(next.covered, from, to);
  next.syncedAt = now;
  return { cache: next, added, warnings, from, to, total: Object.keys(next.raw).length };
}
