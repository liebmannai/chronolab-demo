// reconstruct.mjs -- recover missed R-peaks (the Polar H10 dropout artifact: a merged interval that
// is ~an integer multiple >=2x of the local reference). Each such interval is split into that many
// equal sub-intervals, re-inserting the dropped beat(s). Opt-in preprocessing, applied BEFORE the
// HRV metrics. Short/normal intervals are never touched, and a long interval is only split when the
// resulting sub-interval looks like a normal beat (so genuine pauses aren't fabricated into beats).
export function reconstructMissedBeats(rr, opts = {}) {
  const win = opts.win ?? 20;          // rolling window for the local reference (beats)
  const minRatio = opts.minRatio ?? 1.6; // an interval must be at least this x reference to be a merge
  const tol = opts.tol ?? 0.30;        // each recovered sub-interval must be within tol of the reference
  const maxN = opts.maxN ?? 5;         // cap beats recovered from one interval
  const out = []; const recent = []; let inserted = 0;
  const median = a => { const s = [...a].sort((x, y) => x - y); return s.length ? s[s.length >> 1] : NaN; };
  const pushRef = v => { recent.push(v); if (recent.length > win) recent.shift(); };
  for (let i = 0; i < rr.length; i++) {
    const v = rr[i], ref = median(recent);
    if (recent.length >= 5 && v >= minRatio * ref) {
      const n = Math.min(maxN, Math.round(v / ref)), sub = v / n;
      if (n >= 2 && Math.abs(sub - ref) <= tol * ref) {   // clean integer-multiple merge -> split
        for (let k = 0; k < n; k++) { out.push(sub); pushRef(sub); }
        inserted += n - 1;
        continue;
      }
    }
    out.push(v);
    if (recent.length < 5 || (v >= 0.5 * ref && v <= 1.6 * ref)) pushRef(v); // only normal beats define the reference
  }
  return { rr: out, inserted };
}
