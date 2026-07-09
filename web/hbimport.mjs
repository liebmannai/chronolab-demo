// hbimport.mjs -- parse RR intervals from a HeartBalance/Movesense recording export.
// The HeartBalance firmware records ~24 h to the sensor, then the app downloads it as JSON:
//   { "HeartBalance": { "PeakData":[{ "rr": <ms>, "amplitude": <x20 µV> }, ...],
//                       "Metadata":[{ battery_level, event_id, event_reason, timestamp, utc }],
//                       "AccData":[{x,y,z},...] } }
// This parser also accepts the CSV export (amplitude;rr) and a plain one-RR-per-line list.

export function parseHeartBalanceRR(text, name = '') {
  const t = text.replace(/^﻿/, '').trim();

  // ---- JSON (HeartBalance recording, or a plain RR array) ----
  if (t[0] === '{' || t[0] === '[') {
    const d = JSON.parse(t);
    const hb = d.HeartBalance || d;
    const peaks = hb.PeakData || d.PeakData;
    if (Array.isArray(peaks) && peaks.length && typeof peaks[0] === 'object') {
      const rr = peaks.map(p => Number(p.rr)).filter(Number.isFinite);
      const amplitude = peaks.map(p => Number(p.amplitude) * 20); // unit: value × 20 µV
      const meta = (hb.Metadata && hb.Metadata[0]) || {};
      return { rr, amplitude, meta, source: 'HeartBalance JSON', name };
    }
    if (Array.isArray(d) && d.every(x => typeof x === 'number')) {
      return { rr: d.filter(Number.isFinite), amplitude: [], meta: {}, source: 'JSON RR array', name };
    }
    if (Array.isArray(d) && d.length && typeof d[0] === 'object' && 'rr' in d[0]) {
      return { rr: d.map(p => Number(p.rr)).filter(Number.isFinite),
               amplitude: d.map(p => Number(p.amplitude) * 20), meta: {}, source: 'JSON peaks', name };
    }
    throw new Error('JSON has no HeartBalance.PeakData or RR array');
  }

  // ---- CSV (e.g. "amplitude";"rr") ----
  const lines = t.split(/\r?\n/).filter(l => l.trim());
  const delim = lines[0].includes(';') ? ';' : (lines[0].includes('\t') ? '\t' : ',');
  const cells0 = lines[0].split(delim).map(s => s.replace(/"/g, '').trim());
  const hasHeader = cells0.some(c => /[a-z]/i.test(c) && !/^-?\d/.test(c));
  const header = cells0.map(c => c.toLowerCase());
  let rrCol = header.indexOf('rr');
  if (rrCol < 0 && cells0.length >= 2) rrCol = cells0.length - 1; // assume last column is rr
  if (rrCol >= 0 && lines.length > (hasHeader ? 1 : 0)) {
    const rr = [], amplitude = [];
    const ampCol = header.indexOf('amplitude');
    for (let i = hasHeader ? 1 : 0; i < lines.length; i++) {
      const c = lines[i].split(delim);
      const v = parseFloat((c[rrCol] || '').replace(/"/g, '').trim().replace(',', '.'));
      if (Number.isFinite(v)) {
        rr.push(v);
        if (ampCol >= 0) amplitude.push(parseFloat((c[ampCol] || '').replace(/"/g, '').replace(',', '.')) * 20);
      }
    }
    if (rr.length) return { rr, amplitude, meta: {}, source: 'CSV', name };
  }

  // ---- plain list: one RR (ms) per line / whitespace-separated ----
  const nums = t.split(/[\s,;]+/).map(parseFloat).filter(Number.isFinite);
  if (nums.length) return { rr: nums, amplitude: [], meta: {}, source: 'RR list', name };

  throw new Error('Could not find RR intervals in the file');
}
