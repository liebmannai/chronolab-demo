// app.mjs -- Web Bluetooth heart-rate -> hrv_core.wasm -> live HRV dashboard.
import { parseHeartRateMeasurement } from './hrm.mjs';

const KEYS = ["beats","duration_h","valid_pct","blocks","blocks_valid","HR_bpm",
  "SDNN_sample_ms","SDNN_pop_ms","RMSSD_ms","NN50","pNN50","LRSA","MADRR_ms",
  "berger_samples","VQ_iir","LF_ms2","HF_ms2","TOT_ms2","VQ_psd",
  "VitalesPotential_ms2","VitalitaetsIndex"];

const $ = id => document.getElementById(id);
const root = document.querySelector('.viz-root');
const cssVar = n => getComputedStyle(root).getPropertyValue(n).trim();

// ---- state ----
const rr = [];              // full session RR intervals (ms)
let hrInstant = null;
let dirty = false, mode = null, simTimer = null, rrWarned = false;
let viewSock = null, shareSock = null;   // WebSocket bridge: receive from / share to

// ---- wasm ----
const CAP = 200000;
let W = null, inPtr = 0, outPtr = 0;
async function loadWasm() {
  const url = new URL('../wasm/hrv_core.wasm', import.meta.url);
  const buf = await (await fetch(url)).arrayBuffer();
  const { instance } = await WebAssembly.instantiate(buf, {});
  W = instance.exports;
  inPtr = W.alloc_f64(CAP);      // allocate once, reuse (alloc leaks by design)
  outPtr = W.alloc_f64(KEYS.length);
}
function compute() {
  if (!W || rr.length < 2) return null;
  const n = Math.min(rr.length, CAP);
  const src = rr.length > CAP ? rr.slice(rr.length - CAP) : rr;
  new Float64Array(W.memory.buffer, inPtr, n).set(src);   // buffer current before the call
  W.hrv_run(inPtr, n, outPtr);
  const out = new Float64Array(W.memory.buffer, outPtr, KEYS.length); // re-read after possible grow
  const o = {}; KEYS.forEach((k, i) => o[k] = out[i]);
  return o;
}

// ---- formatting ----
const f = (x, d = 0) => (x == null || Number.isNaN(x)) ? '—' : x.toFixed(d);
function mmss(sec) { const m = Math.floor(sec / 60), s = Math.floor(sec % 60); return `${m}:${String(s).padStart(2, '0')}`; }

// ---- beats ----
function onBeat(rrMs, hr) {
  rr.push(rrMs);
  hrInstant = hr ?? Math.round(60000 / rrMs);
  updateHero();
  drawTachogram();
  dirty = true;
  if (shareSock && shareSock.readyState === 1) shareSock.send(JSON.stringify({ t: 'rr', rr: [rrMs], hr: hrInstant }));
}
function updateHero() {
  $('hr').textContent = hrInstant ?? '—';
  $('beats').textContent = rr.length;
  const secs = rr.reduce((a, b) => a + b, 0) / 1000;
  $('dur').textContent = mmss(secs);
}

// ---- render metric grid (throttled) ----
function render(m) {
  $('valid').textContent = f(m.valid_pct, 0) + '%';
  $('sdnn').textContent = f(m.SDNN_sample_ms, 1);
  $('rmssd').textContent = f(m.RMSSD_ms, 1);
  $('pnn50').textContent = f(m.pNN50 * 100, 1);
  $('lrsa').textContent = f(m.LRSA, 3);
  $('vq').textContent = f(m.VQ_psd, 2);
  const lf = m.LF_ms2, hf = m.HF_ms2;
  $('lfhf').textContent = (Number.isNaN(lf) || Number.isNaN(hf) || hf === 0) ? '—' : (lf / hf).toFixed(2);
  $('lfhfsplit').textContent = (Number.isNaN(lf) || Number.isNaN(hf)) ? '—' : `LF ${lf.toFixed(0)} · HF ${hf.toFixed(0)} ms²`;
  $('vitpot').textContent = f(m.VitalesPotential_ms2, 0);
  $('vitidx').textContent = f(m.VitalitaetsIndex, 0);
  // VQ state chip (activation vs recovery), always with a label — never colour alone
  const chip = $('vqchip'), state = $('vqstate');
  if (Number.isNaN(m.VQ_psd)) { chip.className = 'chip'; state.textContent = '—'; }
  else if (m.VQ_psd > 0) { chip.className = 'chip act'; state.textContent = 'activation (sympathetic)'; }
  else { chip.className = 'chip rec'; state.textContent = 'recovery (parasympathetic)'; }
}
setInterval(() => { if (dirty) { dirty = false; const m = compute(); if (m) render(m); } }, 1000);

// ---- tachogram sparkline ----
const canvas = $('tach');
function drawTachogram() {
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight || 140;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const data = rr.slice(-150);
  if (data.length < 2) return;
  const pad = 10;
  const lo = Math.min(...data), hi = Math.max(...data);
  const ymin = lo - 15, ymax = hi + 15, span = (ymax - ymin) || 1;
  const X = i => pad + (w - 2 * pad) * (i / (data.length - 1));
  const Y = v => (h - pad) - (h - 2 * pad) * ((v - ymin) / span);
  // recessive median baseline
  const sorted = [...data].sort((a, b) => a - b);
  const med = sorted[Math.floor(sorted.length / 2)];
  ctx.strokeStyle = cssVar('--baseline'); ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(pad, Y(med)); ctx.lineTo(w - pad, Y(med)); ctx.stroke();
  // series line
  ctx.strokeStyle = cssVar('--series'); ctx.lineWidth = 2; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  ctx.beginPath();
  data.forEach((v, i) => i ? ctx.lineTo(X(i), Y(v)) : ctx.moveTo(X(i), Y(v)));
  ctx.stroke();
  // end dot with 2px surface ring
  const ex = X(data.length - 1), ey = Y(data[data.length - 1]);
  ctx.fillStyle = cssVar('--surface'); ctx.beginPath(); ctx.arc(ex, ey, 5.5, 0, 7); ctx.fill();
  ctx.fillStyle = cssVar('--series'); ctx.beginPath(); ctx.arc(ex, ey, 3.5, 0, 7); ctx.fill();
}
window.addEventListener('resize', drawTachogram);

// ---- status ----
function setStatus(html) { $('status').innerHTML = html; }

// ---- Web Bluetooth ----
async function connect() {
  if (!navigator.bluetooth) { setStatus('<span class="warn">Web Bluetooth unavailable</span> — use Chrome/Edge over https or localhost. You can still press <b>Simulate</b>.'); return; }
  try {
    setStatus('Requesting device…');
    const device = await navigator.bluetooth.requestDevice({ filters: [{ services: ['heart_rate'] }] });
    device.addEventListener('gattserverdisconnected', () => { setStatus('Disconnected.'); setRunning(false); });
    setStatus('Connecting…');
    const server = await device.gatt.connect();
    const svc = await server.getPrimaryService('heart_rate');
    const ch = await svc.getCharacteristic('heart_rate_measurement');
    await ch.startNotifications();
    ch.addEventListener('characteristicvaluechanged', ev => {
      const { hr, rr: rrs, contact } = parseHeartRateMeasurement(ev.target.value);
      if (rrs.length) { for (const v of rrs) onBeat(v, hr); }
      else { hrInstant = hr; updateHero(); if (!rrWarned) { rrWarned = true; setStatus('Connected, but this sensor sends HR only (no RR intervals) — HRV needs RR. Try a Polar H10 or similar.'); } }
      if (contact === false) setStatus(`<b>${device.name || 'Sensor'}</b> — not in skin contact`);
    });
    mode = 'ble'; setRunning(true);
    setStatus(`Connected: <b>${device.name || 'device'}</b>. Streaming…`);
  } catch (err) { setStatus('<span class="warn">Connect failed:</span> ' + err.message); }
}

// ---- simulate (no hardware): RSA-modulated synthetic RR ----
function startSim() {
  stop(); mode = 'sim'; setRunning(true);
  const t0 = performance.now();
  setStatus('Simulating a synthetic RR stream (0.10 Hz + 0.25 Hz modulation).');
  const tick = () => {
    const t = (performance.now() - t0) / 1000;
    let rrMs = 60000 / 64 + 60 * Math.sin(2 * Math.PI * 0.10 * t) + 40 * Math.sin(2 * Math.PI * 0.25 * t) + (Math.random() - 0.5) * 30;
    if (Math.random() < 0.004) rrMs = 1800 + Math.random() * 1600; // occasional artifact -> correction gate
    onBeat(rrMs, Math.round(60000 / rrMs));
    simTimer = setTimeout(tick, Math.max(250, rrMs));
  };
  tick();
}
function stop() {
  if (simTimer) { clearTimeout(simTimer); simTimer = null; }
  if (viewSock) { try { viewSock.close(); } catch {} viewSock = null; }
  setRunning(false);
}
function reset() { stop();
  if (shareSock) { try { shareSock.close(); } catch {} shareSock = null; $('wsshare').textContent = 'Share to bridge'; }
  rr.length = 0; hrInstant = null; rrWarned = false; mode = null; updateHero(); drawTachogram();
  ['valid','sdnn','rmssd','pnn50','lrsa','vq','lfhf','vitpot','vitidx'].forEach(id => $(id).textContent = '—');
  $('lfhfsplit').textContent = '—'; $('vqchip').className = 'chip'; $('vqstate').textContent = '—';
  setStatus('Reset.'); }

function setRunning(on) { $('stop').disabled = !on; $('wsshare').disabled = !(on && (mode === 'ble' || mode === 'sim')); }

// ---- WebSocket bridge (for browsers without Web Bluetooth) ----
function wsUrl() {
  const q = new URLSearchParams(location.search).get('ws');
  if (q) return q;
  return (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host;
}
function connectView() {
  stop();
  const override = new URLSearchParams(location.search).get('ws');
  let url = override || wsUrl();
  // An HTTPS static host (GitHub Pages) has no same-origin bridge and can't use ws:// — ask for a wss URL.
  if (!override && location.protocol === 'https:') {
    const entered = prompt('WebSocket bridge URL (wss://host) — run web/bridge-tunnel.sh or deploy web/fly.toml:', 'wss://');
    if (!entered || !/^wss?:\/\/.+/.test(entered)) { setStatus('Need a <code>wss://</code> bridge URL (see the README: Fly.io or a cloudflared tunnel).'); return; }
    url = entered;
  }
  setStatus(`Connecting to bridge <b>${url}</b>…`);
  try { viewSock = new WebSocket(url); } catch (e) { setStatus('<span class="warn">Bad WebSocket URL:</span> ' + e.message); return; }
  mode = 'ws';
  viewSock.onopen = () => { setRunning(true); setStatus(`Receiving RR over WebSocket (<b>${url}</b>).`); };
  viewSock.onmessage = e => { try { const m = JSON.parse(e.data); if (m.t === 'rr' && Array.isArray(m.rr)) for (const v of m.rr) onBeat(v, m.hr); } catch {} };
  viewSock.onclose = () => { if (mode === 'ws') setStatus('WebSocket closed.'); setRunning(false); };
  viewSock.onerror = () => setStatus(location.protocol === 'https:'
    ? '<span class="warn">WebSocket error</span> — a static host (e.g. GitHub Pages) can’t run the bridge. Point <code>?ws=wss://your-bridge</code> at a hosted bridge, or use <b>Simulate</b> / <b>Connect sensor</b> (Chrome/Edge).'
    : '<span class="warn">WebSocket error</span> — is the bridge running? <code>node web/bridge.mjs --simulate</code>');
}
function toggleShare() {
  if (shareSock) { try { shareSock.close(); } catch {} shareSock = null; $('wsshare').textContent = 'Share to bridge'; setStatus('Stopped sharing.'); return; }
  const url = wsUrl(); shareSock = new WebSocket(url);
  shareSock.onopen = () => { $('wsshare').textContent = 'Stop sharing'; setStatus(`Sharing RR to the bridge (<b>${url}</b>) — other browsers can now Receive.`); };
  shareSock.onclose = () => { shareSock = null; $('wsshare').textContent = 'Share to bridge'; };
  shareSock.onerror = () => setStatus('<span class="warn">Share failed</span> — start the bridge first: <code>node web/bridge.mjs</code>');
}

// ---- wire up ----
$('connect').addEventListener('click', connect);
$('simulate').addEventListener('click', startSim);
$('wsview').addEventListener('click', connectView);
$('wsshare').addEventListener('click', toggleShare);
$('stop').addEventListener('click', stop);
$('reset').addEventListener('click', reset);
if (!navigator.bluetooth) $('connect').title = 'Web Bluetooth needs Chrome/Edge over https or localhost';

loadWasm().then(() => setStatus('Ready. Connect a Bluetooth HR strap, or press <b>Simulate</b>.'))
  .catch(e => setStatus('<span class="warn">Failed to load hrv_core.wasm:</span> ' + e.message + ' — are you serving over http(s)?'));
