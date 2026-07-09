// import.mjs -- analyse a HeartBalance/Movesense recording export (JSON/CSV/RR list): full HRV suite
// via the eval-core wasm, whole-recording tachogram, and RR download. No sensor connection.
import { parseHeartBalanceRR } from './hbimport.mjs';
import { reconstructMissedBeats } from './reconstruct.mjs';

const KEYS = ["beats_in","beats_kept","kept_pct","duration_h","blocks","HR_sgolay","SDNN_pop","RMSSD",
  "pNN50_pct","IRRR","MADRR","TINN","HRVi","LF_ms2","HF_ms2","TOT_ms2","VQ","VitalesPotential","VitalitaetsIndex"];
const $ = id => document.getElementById(id);
const root = document.querySelector('.viz-root');
const cssVar = n => getComputedStyle(root).getPropertyValue(n).trim();
const setStatus = h => $('status').innerHTML = h;

let rr = [], parsed = null, reconstructOn = false, lastInserted = 0;

// ---- wasm ----
const CAP = 300000;
let W = null, inPtr = 0, outPtr = 0;
async function loadWasm() {
  const { instance } = await WebAssembly.instantiate(await (await fetch(new URL('../wasm/hrv_core.wasm', import.meta.url))).arrayBuffer(), {});
  W = instance.exports; inPtr = W.alloc_f64(CAP); outPtr = W.alloc_f64(KEYS.length);
}
function compute(series) {
  let src = series.length > CAP ? series.slice(series.length - CAP) : series.slice();
  if (reconstructOn) { const r = reconstructMissedBeats(src); src = r.rr; lastInserted = r.inserted; } else lastInserted = 0;
  if (src.length > CAP) src = src.slice(src.length - CAP);
  new Float64Array(W.memory.buffer, inPtr, src.length).set(src);
  W.hrv_eval_run(inPtr, src.length, outPtr);
  const out = new Float64Array(W.memory.buffer, outPtr, KEYS.length);
  const o = {}; KEYS.forEach((k, i) => o[k] = out[i]); return o;
}
const f = (x, d = 0) => (x == null || Number.isNaN(x)) ? '—' : x.toFixed(d);

// ---- file handling ----
async function handleFile(file) {
  try {
    setStatus(`Reading <b>${file.name}</b>…`);
    const text = await file.text();
    parsed = parseHeartBalanceRR(text, file.name);
    rr = parsed.rr.filter(v => Number.isFinite(v) && v > 0);
    if (!rr.length) throw new Error('no RR intervals found');
    analyze();
  } catch (e) { setStatus('<span class="warn">Could not read that file:</span> ' + e.message); }
}
function analyze() {
  if (!W) { setStatus('Loading engine…'); return; }
  $('panels').style.display = 'grid';
  const m = compute(rr);
  // hero + metadata
  $('hr').textContent = f(m.HR_sgolay, 0);
  $('beats').textContent = rr.length;
  const secs = rr.reduce((a, b) => a + b, 0) / 1000;
  $('dur').textContent = secs >= 3600 ? `${(secs / 3600).toFixed(2)} h` : `${Math.floor(secs / 60)}:${String(Math.floor(secs % 60)).padStart(2, '0')} min`;
  $('src').textContent = parsed.source;
  const md = parsed.meta || {};
  const bits = [];
  if (md.utc) bits.push(new Date(md.utc * 1000).toLocaleString());
  if (md.battery_level != null) bits.push(`battery ${md.battery_level}%`);
  $('metaline').textContent = bits.join(' · ');
  render(m);
  drawTachogram();
  $('dlRr').disabled = $('dlCsv').disabled = false;
  $('recount').textContent = (reconstructOn && lastInserted) ? `(${lastInserted} recovered)` : '';
  setStatus(`Analysed <b>${parsed.name || 'recording'}</b> — ${rr.length} beats.`);
}
function render(m) {
  $('hrsg').textContent = f(m.HR_sgolay, 1); $('sdnn').textContent = f(m.SDNN_pop, 1); $('rmssd').textContent = f(m.RMSSD, 1);
  $('pnn50').textContent = f(m.pNN50_pct, 1); $('irrr').textContent = f(m.IRRR, 1); $('madrr').textContent = f(m.MADRR, 1);
  $('tinn').textContent = f(m.TINN, 1); $('hrvi').textContent = f(m.HRVi, 1); $('vq').textContent = f(m.VQ, 2);
  const lf = m.LF_ms2, hf = m.HF_ms2;
  $('lfhf').textContent = (Number.isNaN(lf) || Number.isNaN(hf) || hf === 0) ? '—' : (lf / hf).toFixed(2);
  $('lfhfsplit').textContent = (Number.isNaN(lf) || Number.isNaN(hf)) ? '—' : `LF ${lf.toFixed(0)} · HF ${hf.toFixed(0)} ms²`;
  $('vitpot').textContent = f(m.VitalesPotential, 0); $('vitidx').textContent = f(m.VitalitaetsIndex, 0);
  const chip = $('vqchip'), state = $('vqstate');
  if (Number.isNaN(m.VQ)) { chip.className = 'chip'; state.textContent = '—'; }
  else if (m.VQ > 0) { chip.className = 'chip act'; state.textContent = 'activation (sympathetic)'; }
  else { chip.className = 'chip rec'; state.textContent = 'recovery (parasympathetic)'; }
}

// whole-recording tachogram (downsampled to ~fit the canvas width)
const canvas = $('tach');
function drawTachogram() {
  const ctx = canvas.getContext('2d'), dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight || 150;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, w, h);
  const series = reconstructOn ? reconstructMissedBeats(rr).rr : rr;
  if (series.length < 2) return;
  const N = Math.min(series.length, Math.max(200, Math.floor(w)));
  const step = series.length / N, data = [];
  for (let i = 0; i < N; i++) data.push(series[Math.floor(i * step)]);
  const pad = 10, lo = Math.min(...data), hi = Math.max(...data), ymin = lo - 15, ymax = hi + 15, span = (ymax - ymin) || 1;
  const X = i => pad + (w - 2 * pad) * (i / (data.length - 1)), Y = v => (h - pad) - (h - 2 * pad) * ((v - ymin) / span);
  const s = [...data].sort((a, b) => a - b), med = s[Math.floor(s.length / 2)];
  ctx.strokeStyle = cssVar('--baseline'); ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(pad, Y(med)); ctx.lineTo(w - pad, Y(med)); ctx.stroke();
  ctx.strokeStyle = cssVar('--series'); ctx.lineWidth = 1.5; ctx.lineJoin = 'round'; ctx.lineCap = 'round'; ctx.beginPath();
  data.forEach((v, i) => i ? ctx.lineTo(X(i), Y(v)) : ctx.moveTo(X(i), Y(v))); ctx.stroke();
}
window.addEventListener('resize', () => { if (rr.length) drawTachogram(); });

// ---- downloads ----
function download(name, text, mime = 'text/plain') {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
const baseName = () => (parsed?.name || 'recording').replace(/\.[^.]+$/, '');
$('dlRr').addEventListener('click', () => download(`${baseName()}_rr.txt`, rr.map(x => x.toFixed(1)).join('\n') + '\n'));
$('dlCsv').addEventListener('click', () => {
  let s = 'index,rr_ms,t_s\n', t = 0; for (let i = 0; i < rr.length; i++) { t += rr[i] / 1000; s += `${i + 1},${rr[i].toFixed(1)},${t.toFixed(3)}\n`; }
  download(`${baseName()}_rr.csv`, s, 'text/csv');
});

// ---- wiring: file input + drag/drop ----
const drop = $('drop');
$('file').addEventListener('change', e => { if (e.target.files[0]) handleFile(e.target.files[0]); });
['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', e => { const file = e.dataTransfer.files[0]; if (file) handleFile(file); });
const recon = $('reconstruct');
reconstructOn = localStorage.getItem('hrvReconstruct') === '1'; recon.checked = reconstructOn;
recon.addEventListener('change', () => { reconstructOn = recon.checked; localStorage.setItem('hrvReconstruct', reconstructOn ? '1' : '0'); if (rr.length) analyze(); });

loadWasm().then(() => setStatus('Ready — drop a HeartBalance recording (JSON/CSV) or an RR list.'))
  .catch(e => setStatus('<span class="warn">Failed to load hrv_core.wasm:</span> ' + e.message));
