// movesense.mjs -- live HRV for the Movesense HR2. RR via the standard Heart Rate service (primary)
// or the Movesense Whiteboard API (/Meas/HR, fallback). Reuses the eval-core wasm + reconstruction.
import { parseHeartRateMeasurement } from './hrm.mjs';
import { reconstructMissedBeats } from './reconstruct.mjs';
import { MS_SERVICE, MS_WRITE, MS_NOTIFY, subscribeCmd, unsubscribeCmd, parseMovesenseHr } from './movesense-ble.mjs';

const KEYS = ["beats_in","beats_kept","kept_pct","duration_h","blocks","HR_sgolay","SDNN_pop","RMSSD",
  "pNN50_pct","IRRR","MADRR","TINN","HRVi","LF_ms2","HF_ms2","TOT_ms2","VQ","VitalesPotential","VitalitaetsIndex"];
const $ = id => document.getElementById(id);
const root = document.querySelector('.viz-root');
const cssVar = n => getComputedStyle(root).getPropertyValue(n).trim();
const setStatus = h => $('status').innerHTML = h;

const rr = [];
let hrInstant = null, dirty = false, mode = null, simTimer = null;
let reconstructOn = false, lastInserted = 0;
let msServer = null, msNotify = null, msLogged = 0;

// ---- wasm (eval-core export) ----
const CAP = 200000;
let W = null, inPtr = 0, outPtr = 0;
async function loadWasm() {
  const { instance } = await WebAssembly.instantiate(await (await fetch(new URL('../wasm/hrv_core.wasm', import.meta.url))).arrayBuffer(), {});
  W = instance.exports; inPtr = W.alloc_f64(CAP); outPtr = W.alloc_f64(KEYS.length);
}
function compute() {
  if (!W || rr.length < 2) return null;
  let src = rr.length > CAP ? rr.slice(rr.length - CAP) : rr.slice();
  if (reconstructOn) { const r = reconstructMissedBeats(src); src = r.rr; lastInserted = r.inserted; } else lastInserted = 0;
  if (src.length > CAP) src = src.slice(src.length - CAP);
  new Float64Array(W.memory.buffer, inPtr, src.length).set(src);
  W.hrv_eval_run(inPtr, src.length, outPtr);
  const out = new Float64Array(W.memory.buffer, outPtr, KEYS.length);
  const o = {}; KEYS.forEach((k, i) => o[k] = out[i]);
  $('recount').textContent = (reconstructOn && lastInserted) ? `(${lastInserted} recovered)` : '';
  return o;
}
const f = (x, d = 0) => (x == null || Number.isNaN(x)) ? '—' : x.toFixed(d);
const mmss = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

function onBeat(rrMs, hr) {
  rr.push(rrMs); hrInstant = hr ?? Math.round(60000 / rrMs);
  updateHero(); drawTachogram(); dirty = true;
}
function updateHero() {
  $('hr').textContent = hrInstant ?? '—'; $('bin').textContent = rr.length;
  $('dur').textContent = mmss(rr.reduce((a, b) => a + b, 0) / 1000);
}
function render(m) {
  $('bkept').textContent = f(m.beats_kept, 0); $('bpct').textContent = f(m.kept_pct, 0) + '%'; $('blocks').textContent = f(m.blocks, 0);
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
setInterval(() => { if (dirty) { dirty = false; const m = compute(); if (m) render(m); } }, 1000);

const canvas = $('tach');
function drawTachogram() {
  const ctx = canvas.getContext('2d'), dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight || 140;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, w, h);
  const data = (reconstructOn ? reconstructMissedBeats(rr.slice(-400)).rr : rr).slice(-150); if (data.length < 2) return;
  const pad = 10, lo = Math.min(...data), hi = Math.max(...data), ymin = lo - 15, ymax = hi + 15, span = (ymax - ymin) || 1;
  const X = i => pad + (w - 2 * pad) * (i / (data.length - 1)), Y = v => (h - pad) - (h - 2 * pad) * ((v - ymin) / span);
  const s = [...data].sort((a, b) => a - b), med = s[Math.floor(s.length / 2)];
  ctx.strokeStyle = cssVar('--baseline'); ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(pad, Y(med)); ctx.lineTo(w - pad, Y(med)); ctx.stroke();
  ctx.strokeStyle = cssVar('--series'); ctx.lineWidth = 2; ctx.lineJoin = 'round'; ctx.lineCap = 'round'; ctx.beginPath();
  data.forEach((v, i) => i ? ctx.lineTo(X(i), Y(v)) : ctx.moveTo(X(i), Y(v))); ctx.stroke();
  const ex = X(data.length - 1), ey = Y(data[data.length - 1]);
  ctx.fillStyle = cssVar('--surface'); ctx.beginPath(); ctx.arc(ex, ey, 5.5, 0, 7); ctx.fill();
  ctx.fillStyle = cssVar('--series'); ctx.beginPath(); ctx.arc(ex, ey, 3.5, 0, 7); ctx.fill();
}
window.addEventListener('resize', drawTachogram);

// ---- connect: standard HR service (primary) ----
async function connect() {
  if (!navigator.bluetooth) { setStatus('<span class="warn">Web Bluetooth unavailable</span> — use Chrome/Edge over https or localhost. You can still press <b>Simulate</b>.'); return; }
  try {
    setStatus('Pick your sensor from the list (Movesense / HeartBalance)…');
    // custom HeartBalance firmware may advertise an unknown name/services -> accept all, filter after
    const dev = await navigator.bluetooth.requestDevice({
      acceptAllDevices: true,
      optionalServices: ['heart_rate', MS_SERVICE],
    });
    dev.addEventListener('gattserverdisconnected', () => { setStatus('Disconnected.'); setRunning(false); });
    setStatus('Connecting…');
    msServer = await dev.gatt.connect();
    $('msapi').disabled = false;
    try {
      const ch = await (await msServer.getPrimaryService('heart_rate')).getCharacteristic('heart_rate_measurement');
      await ch.startNotifications();
      ch.addEventListener('characteristicvaluechanged', ev => {
        const { hr, rr: rrs } = parseHeartRateMeasurement(ev.target.value);
        if (rrs.length) for (const v of rrs) onBeat(v, hr); else { hrInstant = hr; updateHero(); }
      });
      mode = 'ble'; $('src').textContent = 'standard HR service'; setRunning(true);
      setStatus(`Connected: <b>${dev.name || 'sensor'}</b> via the standard Heart Rate service. Streaming…`);
      // if HR arrives but no RR (custom firmware may omit RR), nudge toward the Movesense API
      setTimeout(() => { if (mode === 'ble' && rr.length === 0) setStatus(`Connected to <b>${dev.name || 'sensor'}</b>, but no RR intervals from the HR service yet. If none appear, click <b>Use Movesense API</b>.`); }, 8000);
    } catch {
      setStatus(`Connected: <b>${dev.name || 'Movesense'}</b>, but no standard HR service — trying the Movesense API…`);
      await connectMovesenseApi();
    }
  } catch (err) { setStatus('<span class="warn">Connect failed:</span> ' + err.message); }
}

// ---- Movesense Whiteboard API (fallback / native): subscribe /Meas/HR ----
async function connectMovesenseApi() {
  if (!msServer) { setStatus('Connect first.'); return; }
  try {
    const svc = await msServer.getPrimaryService(MS_SERVICE);
    const wr = await svc.getCharacteristic(MS_WRITE);
    msNotify = await svc.getCharacteristic(MS_NOTIFY);
    await msNotify.startNotifications();
    msNotify.addEventListener('characteristicvaluechanged', onMovesenseData);
    await wr.writeValueWithResponse(subscribeCmd('/Meas/HR'));
    mode = 'msapi'; $('src').textContent = 'Movesense API'; setRunning(true);
    setStatus('Subscribed to Movesense <code>/Meas/HR</code> (experimental). Waiting for data…');
  } catch (e) { setStatus('<span class="warn">Movesense API failed:</span> ' + e.message + ' — the standard HR service is the reliable path.'); }
}
function onMovesenseData(e) {
  const dv = e.target.value;
  if (msLogged < 3) { // surface raw frames for protocol tuning against real hardware
    const hex = [...new Uint8Array(dv.buffer)].slice(0, 16).map(b => b.toString(16).padStart(2, '0')).join(' ');
    console.log('Movesense frame:', hex); msLogged++;
    if (msLogged === 1) setStatus(`Movesense data flowing (frame starts <code>${hex}</code>). If RR looks wrong, send me this.`);
  }
  const r = parseMovesenseHr(dv);
  if (r && r.rr.length) for (const v of r.rr) onBeat(v, r.average ? Math.round(r.average) : null);
}

// ---- simulate / controls (shared) ----
function startSim() {
  stop(); mode = 'sim'; $('src').textContent = 'simulated'; setRunning(true);
  const t0 = performance.now();
  setStatus('Simulating a synthetic RR stream (0.10 Hz + 0.25 Hz modulation).');
  const tick = () => {
    const t = (performance.now() - t0) / 1000;
    let rrMs = 60000 / 64 + 60 * Math.sin(2 * Math.PI * 0.10 * t) + 40 * Math.sin(2 * Math.PI * 0.25 * t) + (Math.random() - 0.5) * 30;
    if (Math.random() < 0.004) rrMs = 1800 + Math.random() * 1600;
    onBeat(rrMs, Math.round(60000 / rrMs));
    simTimer = setTimeout(tick, Math.max(250, rrMs));
  };
  tick();
}
function stop() { if (simTimer) { clearTimeout(simTimer); simTimer = null; } setRunning(false); }
function reset() {
  stop(); rr.length = 0; hrInstant = null; mode = null; updateHero(); drawTachogram();
  ['bkept','bpct','blocks','hrsg','sdnn','rmssd','pnn50','irrr','madrr','tinn','hrvi','vq','lfhf','vitpot','vitidx'].forEach(id => $(id).textContent = '—');
  $('lfhfsplit').textContent = '—'; $('vqchip').className = 'chip'; $('vqstate').textContent = '—'; $('recount').textContent = ''; $('src').textContent = '—'; setStatus('Reset.');
}
function setRunning(on) { $('stop').disabled = !on; }

$('connect').addEventListener('click', connect);
$('simulate').addEventListener('click', startSim);
$('msapi').addEventListener('click', connectMovesenseApi);
$('stop').addEventListener('click', stop);
$('reset').addEventListener('click', reset);
const recon = $('reconstruct');
reconstructOn = localStorage.getItem('hrvReconstruct') === '1'; recon.checked = reconstructOn;
recon.addEventListener('change', () => { reconstructOn = recon.checked; localStorage.setItem('hrvReconstruct', reconstructOn ? '1' : '0'); dirty = true; drawTachogram(); });
if (!navigator.bluetooth) $('connect').title = 'Web Bluetooth needs Chrome/Edge over https or localhost';

loadWasm().then(() => setStatus('Ready. Connect your Movesense HR2, or press <b>Simulate</b>.'))
  .catch(e => setStatus('<span class="warn">Failed to load hrv_core.wasm:</span> ' + e.message));
