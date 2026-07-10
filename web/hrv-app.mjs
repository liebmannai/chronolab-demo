// hrv-app.mjs -- unified HRV app: "Analyse recording" + "Live (Bluetooth)" tabs sharing one
// eval-core wasm engine, one metrics panel, and one tachogram. Reuses the validated modules.
import { parseHeartBalanceRR } from './hbimport.mjs';
import { reconstructMissedBeats } from './reconstruct.mjs';
import { parseHeartRateMeasurement } from './hrm.mjs';
import { MS_SERVICE, MS_WRITE, MS_NOTIFY, HR_PATH, subscribeCmd, parseMovesenseHr } from './movesense-ble.mjs';

const KEYS = ["beats_in","beats_kept","kept_pct","duration_h","blocks","HR_sgolay","SDNN_pop","RMSSD",
  "pNN50_pct","IRRR","MADRR","TINN","HRVi","LF_ms2","HF_ms2","TOT_ms2","VQ","VitalesPotential","VitalitaetsIndex"];
const $ = id => document.getElementById(id);
const root = document.querySelector('.viz-root');
const cssVar = n => getComputedStyle(root).getPropertyValue(n).trim();
const setStatus = h => $('status').innerHTML = h;
const f = (x, d = 0) => (x == null || Number.isNaN(x)) ? '—' : x.toFixed(d);

let tab = 'analyze';
let reconstructOn = false;

// per-tab state
const A = { rr: [], parsed: null };
const L = { rr: [], hrInstant: null, mode: null, srcLabel: '—', sim: null, server: null, notify: null, logged: 0, dirty: false, viewSock: null, shareSock: null };

// ---- wasm (eval-core) --------------------------------------------------------------
const CAP = 300000;
let W = null, inPtr = 0, outPtr = 0;
async function loadWasm() {
  const { instance } = await WebAssembly.instantiate(await (await fetch(new URL('../wasm/hrv_core.wasm', import.meta.url))).arrayBuffer(), {});
  W = instance.exports; inPtr = W.alloc_f64(CAP); outPtr = W.alloc_f64(KEYS.length);
}
// Returns { m, inserted, series } where `series` is the (optionally reconstructed) data actually analysed.
function compute(rawSeries) {
  let src = rawSeries.length > CAP ? rawSeries.slice(rawSeries.length - CAP) : rawSeries.slice();
  let inserted = 0;
  if (reconstructOn) { const r = reconstructMissedBeats(src); src = r.rr; inserted = r.inserted; }
  if (src.length > CAP) src = src.slice(src.length - CAP);
  new Float64Array(W.memory.buffer, inPtr, src.length).set(src);
  W.hrv_eval_run(inPtr, src.length, outPtr);
  const out = new Float64Array(W.memory.buffer, outPtr, KEYS.length);
  const m = {}; KEYS.forEach((k, i) => m[k] = out[i]);
  return { m, inserted, series: src };
}

// ---- shared rendering --------------------------------------------------------------
const fmtDur = secs => secs >= 3600
  ? `${(secs / 3600).toFixed(2)} h`
  : `${Math.floor(secs / 60)}:${String(Math.floor(secs % 60)).padStart(2, '0')} min`;

function renderTiles(m) {
  $('hrsg').textContent = f(m.HR_sgolay, 1); $('sdnn').textContent = f(m.SDNN_pop, 1); $('rmssd').textContent = f(m.RMSSD, 1);
  $('pnn50').textContent = f(m.pNN50_pct, 1); $('irrr').textContent = f(m.IRRR, 1); $('madrr').textContent = f(m.MADRR, 1);
  $('tinn').textContent = f(m.TINN, 1); $('hrvi').textContent = f(m.HRVi, 1); $('vq').textContent = f(m.VQ, 2);
  $('bkept').textContent = f(m.beats_kept, 0); $('bpct').textContent = f(m.kept_pct, 0); $('blocks').textContent = f(m.blocks, 0);
  const lf = m.LF_ms2, hf = m.HF_ms2;
  $('lfhf').textContent = (Number.isNaN(lf) || Number.isNaN(hf) || hf === 0) ? '—' : (lf / hf).toFixed(2);
  $('lfhfsplit').textContent = (Number.isNaN(lf) || Number.isNaN(hf)) ? '—' : `LF ${lf.toFixed(0)} · HF ${hf.toFixed(0)} ms²`;
  $('vitpot').textContent = f(m.VitalesPotential, 0); $('vitidx').textContent = f(m.VitalitaetsIndex, 0);
  const chip = $('vqchip'), state = $('vqstate');
  if (Number.isNaN(m.VQ)) { chip.className = 'chip'; state.textContent = '—'; }
  else if (m.VQ > 0) { chip.className = 'chip act'; state.textContent = 'activation'; }
  else { chip.className = 'chip rec'; state.textContent = 'recovery'; }
}

function renderHero(m, st) {
  $('beats').textContent = st.rr.length;
  $('dur').textContent = fmtDur(st.rr.reduce((a, b) => a + b, 0) / 1000);
  if (tab === 'analyze') {
    $('hr').textContent = f(m.HR_sgolay, 0);
    $('src').textContent = A.parsed?.source ?? '—';
    const md = A.parsed?.meta || {}, bits = [];
    if (md.utc) bits.push(new Date(md.utc * 1000).toLocaleString());
    if (md.battery_level != null) bits.push(`battery ${md.battery_level}%`);
    $('metaline').textContent = bits.join(' · ');
  } else {
    $('hr').textContent = L.hrInstant ?? '—';
    $('src').textContent = L.srcLabel;
    $('metaline').textContent = '';
  }
}

// tachogram: whole-recording (downsampled) for analyse, rolling last-150 for live
const canvas = $('tach');
function drawTachogram(series, rolling) {
  const ctx = canvas.getContext('2d'), dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight || 150;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, w, h);
  let data;
  if (rolling) { data = series.slice(-150); }
  else {
    const N = Math.min(series.length, Math.max(200, Math.floor(w)));
    const step = series.length / N; data = [];
    for (let i = 0; i < N; i++) data.push(series[Math.floor(i * step)]);
  }
  if (data.length < 2) return;
  const pad = 10, lo = Math.min(...data), hi = Math.max(...data), ymin = lo - 15, ymax = hi + 15, span = (ymax - ymin) || 1;
  const X = i => pad + (w - 2 * pad) * (i / (data.length - 1)), Y = v => (h - pad) - (h - 2 * pad) * ((v - ymin) / span);
  const s = [...data].sort((a, b) => a - b), med = s[Math.floor(s.length / 2)];
  ctx.strokeStyle = cssVar('--baseline'); ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(pad, Y(med)); ctx.lineTo(w - pad, Y(med)); ctx.stroke();
  ctx.strokeStyle = cssVar('--series'); ctx.lineWidth = rolling ? 2 : 1.5; ctx.lineJoin = 'round'; ctx.lineCap = 'round'; ctx.beginPath();
  data.forEach((v, i) => i ? ctx.lineTo(X(i), Y(v)) : ctx.moveTo(X(i), Y(v))); ctx.stroke();
  if (rolling) {
    const ex = X(data.length - 1), ey = Y(data[data.length - 1]);
    ctx.fillStyle = cssVar('--surface'); ctx.beginPath(); ctx.arc(ex, ey, 5.5, 0, 7); ctx.fill();
    ctx.fillStyle = cssVar('--series'); ctx.beginPath(); ctx.arc(ex, ey, 3.5, 0, 7); ctx.fill();
  }
}

// re-render the active tab from its current data
function refresh() {
  const st = tab === 'analyze' ? A : L;
  if (!W || !st.rr || st.rr.length < 2) { $('results').style.display = 'none'; return; }
  $('results').style.display = 'block';
  const { m, inserted, series } = compute(st.rr);
  renderTiles(m); renderHero(m, st); drawTachogram(series, tab === 'live');
  $(tab === 'analyze' ? 'recount-a' : 'recount-l').textContent = (reconstructOn && inserted) ? `(${inserted} recovered)` : '';
  $('dlRr').disabled = $('dlCsv').disabled = false;
}
window.addEventListener('resize', () => { if ($('results').style.display === 'block') refresh(); });

// ---- ANALYSE tab -------------------------------------------------------------------
async function handleFile(file) {
  try {
    setStatus(`Reading <b>${file.name}</b>…`);
    A.parsed = parseHeartBalanceRR(await file.text(), file.name);
    A.rr = A.parsed.rr.filter(v => Number.isFinite(v) && v > 0);
    if (!A.rr.length) throw new Error('no RR intervals found');
    if (tab !== 'analyze') selectTab('analyze');
    refresh();
    setStatus(`Analysed <b>${A.parsed.name || 'recording'}</b> — ${A.rr.length} beats.`);
  } catch (e) { setStatus('<span class="warn">Could not read that file:</span> ' + e.message); }
}

// ---- LIVE tab ----------------------------------------------------------------------
function onBeat(rrMs, hr) {
  L.rr.push(rrMs); L.hrInstant = hr ?? Math.round(60000 / rrMs); L.dirty = true;
  if (L.shareSock && L.shareSock.readyState === 1) L.shareSock.send(JSON.stringify({ t: 'rr', rr: [rrMs], hr: L.hrInstant }));
  if (tab === 'live') { // cheap immediate feedback; full metrics recompute on the 1 s tick
    $('hr').textContent = L.hrInstant; $('beats').textContent = L.rr.length;
    $('dur').textContent = fmtDur(L.rr.reduce((a, b) => a + b, 0) / 1000);
    drawTachogram(reconstructOn ? reconstructMissedBeats(L.rr.slice(-400)).rr : L.rr, true);
    $('results').style.display = 'block';
  }
}
setInterval(() => { if (tab === 'live' && L.dirty) { L.dirty = false; refresh(); } }, 1000);

async function connect() {
  if (!navigator.bluetooth) { setStatus('<span class="warn">Web Bluetooth unavailable</span> — use Chrome/Edge over https or localhost. You can still press <b>Simulate</b>.'); return; }
  try {
    setStatus('Pick your sensor (Polar H10 / Movesense)…');
    const dev = await navigator.bluetooth.requestDevice({ acceptAllDevices: true, optionalServices: ['heart_rate', MS_SERVICE] });
    dev.addEventListener('gattserverdisconnected', () => { setStatus('Disconnected.'); setRunning(false); });
    setStatus('Connecting…');
    L.server = await dev.gatt.connect();
    $('msapi').disabled = false;
    try {
      const ch = await (await L.server.getPrimaryService('heart_rate')).getCharacteristic('heart_rate_measurement');
      await ch.startNotifications();
      ch.addEventListener('characteristicvaluechanged', ev => {
        const { hr, rr } = parseHeartRateMeasurement(ev.target.value);
        if (rr.length) for (const v of rr) onBeat(v, hr); else { L.hrInstant = hr; if (tab === 'live') $('hr').textContent = hr; }
      });
      L.mode = 'ble'; L.srcLabel = 'standard HR service'; setRunning(true);
      setStatus(`Connected: <b>${dev.name || 'sensor'}</b> via the standard Heart-Rate service. Streaming…`);
      setTimeout(() => { if (L.mode === 'ble' && L.rr.length === 0) setStatus(`Connected to <b>${dev.name || 'sensor'}</b> but no RR yet. If none appear, try <b>Use Movesense API</b>.`); }, 8000);
    } catch {
      setStatus(`Connected: <b>${dev.name || 'sensor'}</b> — no standard HR service; trying the Movesense Whiteboard…`);
      await connectMovesenseApi();
    }
  } catch (err) { setStatus('<span class="warn">Connect failed:</span> ' + err.message); }
}

async function connectMovesenseApi() {
  if (!L.server) { setStatus('Connect first.'); return; }
  try {
    const svc = await L.server.getPrimaryService(MS_SERVICE);
    const wr = await svc.getCharacteristic(MS_WRITE);
    L.notify = await svc.getCharacteristic(MS_NOTIFY);
    await L.notify.startNotifications();
    L.notify.addEventListener('characteristicvaluechanged', onMovesenseData);
    try { await wr.writeValueWithoutResponse(subscribeCmd(HR_PATH)); } catch { await wr.writeValueWithResponse(subscribeCmd(HR_PATH)); }
    L.mode = 'msapi'; L.srcLabel = 'Movesense Whiteboard'; setRunning(true);
    setStatus('Subscribed to Movesense <code>/Meas/HR</code>. Waiting for data — note this only works if the firmware exposes it (HeartBalance firmware won’t).');
  } catch (e) { setStatus('<span class="warn">Movesense connect failed:</span> ' + e.message); }
}
function onMovesenseData(e) {
  if (L.logged < 3) { const hex = [...new Uint8Array(e.target.value.buffer)].slice(0, 16).map(b => b.toString(16).padStart(2, '0')).join(' '); console.log('Movesense frame:', hex); L.logged++; }
  const r = parseMovesenseHr(e.target.value);
  if (r && r.rr.length) for (const v of r.rr) onBeat(v, r.average ? Math.round(r.average) : null);
}

function startSim() {
  stop(); if (tab !== 'live') selectTab('live');
  L.mode = 'sim'; L.srcLabel = 'simulated'; setRunning(true);
  const t0 = performance.now();
  setStatus('Simulating a synthetic RR stream (0.10 Hz + 0.25 Hz modulation).');
  const tick = () => {
    const t = (performance.now() - t0) / 1000;
    let rrMs = 60000 / 64 + 60 * Math.sin(2 * Math.PI * 0.10 * t) + 40 * Math.sin(2 * Math.PI * 0.25 * t) + (Math.random() - 0.5) * 30;
    if (Math.random() < 0.004) rrMs = 1800 + Math.random() * 1600;
    onBeat(rrMs, Math.round(60000 / rrMs));
    L.sim = setTimeout(tick, Math.max(250, rrMs));
  };
  tick();
}
function stop() {
  if (L.sim) { clearTimeout(L.sim); L.sim = null; }
  if (L.viewSock) { try { L.viewSock.close(); } catch {} L.viewSock = null; }
  setRunning(false);
}
function resetLive() {
  stop();
  if (L.shareSock) { try { L.shareSock.close(); } catch {} L.shareSock = null; $('wsshare').textContent = 'Share to bridge'; }
  L.rr.length = 0; L.hrInstant = null; L.mode = null; L.srcLabel = '—';
  if (tab === 'live') { $('results').style.display = 'none'; }
  setStatus('Reset.');
}
function setRunning(on) { $('stop').disabled = !on; $('wsshare').disabled = !(on && (L.mode === 'ble' || L.mode === 'sim' || L.mode === 'msapi')); }

// ---- WebSocket bridge (ported from the retired eval.html): relay RR when Web Bluetooth isn't available ----
function wsUrl() { const q = new URLSearchParams(location.search).get('ws'); return q || ((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host); }
function connectView() {
  stop(); if (tab !== 'live') selectTab('live');
  const override = new URLSearchParams(location.search).get('ws'); let url = override || wsUrl();
  if (!override && location.protocol === 'https:') {
    const entered = prompt('WebSocket bridge URL (wss://host) — run web/bridge.mjs behind a wss tunnel:', 'wss://');
    if (!entered || !/^wss?:\/\/.+/.test(entered)) { setStatus('Need a <code>wss://</code> bridge URL (see web/README).'); return; }
    url = entered;
  }
  setStatus(`Connecting to bridge <b>${url}</b>…`);
  try { L.viewSock = new WebSocket(url); } catch (e) { setStatus('<span class="warn">Bad WebSocket URL:</span> ' + e.message); return; }
  L.mode = 'ws'; L.srcLabel = 'WebSocket bridge';
  L.viewSock.onopen = () => { setRunning(true); setStatus(`Receiving RR over WebSocket (<b>${url}</b>).`); };
  L.viewSock.onmessage = e => { try { const m = JSON.parse(e.data); if (m.t === 'rr' && Array.isArray(m.rr)) for (const v of m.rr) onBeat(v, m.hr); } catch {} };
  L.viewSock.onclose = () => { if (L.mode === 'ws') setStatus('WebSocket closed.'); setRunning(false); };
  L.viewSock.onerror = () => setStatus(location.protocol === 'https:'
    ? '<span class="warn">WebSocket error</span> — point <code>?ws=wss://your-bridge</code> at a hosted bridge, or use Simulate.'
    : '<span class="warn">WebSocket error</span> — is the bridge running? <code>node web/bridge.mjs --simulate</code>');
}
function toggleShare() {
  if (L.shareSock) { try { L.shareSock.close(); } catch {} L.shareSock = null; $('wsshare').textContent = 'Share to bridge'; setStatus('Stopped sharing.'); return; }
  const url = wsUrl(); L.shareSock = new WebSocket(url);
  L.shareSock.onopen = () => { $('wsshare').textContent = 'Stop sharing'; setStatus(`Sharing RR to the bridge (<b>${url}</b>).`); };
  L.shareSock.onclose = () => { L.shareSock = null; $('wsshare').textContent = 'Share to bridge'; };
  L.shareSock.onerror = () => setStatus('<span class="warn">Share failed</span> — start the bridge: <code>node web/bridge.mjs</code>');
}

// ---- downloads (active tab's raw RR) -----------------------------------------------
function download(name, text, mime = 'text/plain') {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
const activeRr = () => (tab === 'analyze' ? A.rr : L.rr);
const baseName = () => tab === 'analyze' ? (A.parsed?.name || 'recording').replace(/\.[^.]+$/, '') : 'live-hrv';
$('dlRr').addEventListener('click', () => download(`${baseName()}_rr.txt`, activeRr().map(x => x.toFixed(1)).join('\n') + '\n'));
$('dlCsv').addEventListener('click', () => {
  const rr = activeRr(); let s = 'index,rr_ms,t_s\n', t = 0;
  for (let i = 0; i < rr.length; i++) { t += rr[i] / 1000; s += `${i + 1},${rr[i].toFixed(1)},${t.toFixed(3)}\n`; }
  download(`${baseName()}_rr.csv`, s, 'text/csv');
});

// ---- tabs + wiring -----------------------------------------------------------------
function selectTab(t) {
  tab = t;
  $('tab-analyze').setAttribute('aria-selected', String(t === 'analyze'));
  $('tab-live').setAttribute('aria-selected', String(t === 'live'));
  $('panel-analyze').classList.toggle('active', t === 'analyze');
  $('panel-live').classList.toggle('active', t === 'live');
  refresh();
}
$('tab-analyze').addEventListener('click', () => selectTab('analyze'));
$('tab-live').addEventListener('click', () => selectTab('live'));

const drop = $('drop');
$('file').addEventListener('change', e => { if (e.target.files[0]) handleFile(e.target.files[0]); });
['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', e => { const file = e.dataTransfer.files[0]; if (file) handleFile(file); });

$('connect').addEventListener('click', connect);
$('simulate').addEventListener('click', startSim);
$('msapi').addEventListener('click', connectMovesenseApi);
$('stop').addEventListener('click', stop);
$('reset').addEventListener('click', resetLive);
$('wsview').addEventListener('click', connectView);
$('wsshare').addEventListener('click', toggleShare);

// reconstruct toggle (two checkboxes, one setting)
reconstructOn = localStorage.getItem('hrvReconstruct') === '1';
for (const id of ['reconstruct-a', 'reconstruct-l']) {
  const c = $(id); c.checked = reconstructOn;
  c.addEventListener('change', () => {
    reconstructOn = c.checked; localStorage.setItem('hrvReconstruct', reconstructOn ? '1' : '0');
    $('reconstruct-a').checked = $('reconstruct-l').checked = reconstructOn;
    refresh();
  });
}
if (!navigator.bluetooth) $('connect').title = 'Web Bluetooth needs Chrome/Edge over https or localhost';
if (location.hash.replace('#', '').toLowerCase().startsWith('live')) selectTab('live'); // deep link from retired movesense.html

loadWasm().then(() => setStatus('Ready — drop a recording, or open the <b>Live</b> tab to connect a sensor.'))
  .catch(e => setStatus('<span class="warn">Failed to load hrv_core.wasm:</span> ' + e.message));
