// record.mjs -- capture Polar H10 ECG (PMD 130 Hz) + RR (HRS) and download them.
import { parseHeartRateMeasurement } from './hrm.mjs';
import { PMD_SERVICE, PMD_CONTROL, PMD_DATA, ECG_START, ECG_STOP, ECG_SAMPLE_RATE,
         parseEcgFrame, parseControlResponse, PMD_STATUS } from './pmd.mjs';

const $ = id => document.getElementById(id);
const root = document.querySelector('.viz-root');
const cssVar = n => getComputedStyle(root).getPropertyValue(n).trim();
const setStatus = h => $('status').innerHTML = h;

// ---- captured data ----
const ecg = [];              // µV samples @ 130 Hz
const rrMs = [];             // RR intervals (ms)
let hrInstant = null, deviceName = '(unknown)', startedISO = null;
let cpChar = null, dataChar = null, hrmChar = null;
let ecgOn = false, rrOn = false;

// ---- BLE connect ----
async function connect() {
  if (!navigator.bluetooth) { setStatus('<span class="warn">Web Bluetooth unavailable</span> — use Chrome/Edge over https or http://localhost.'); return; }
  try {
    setStatus('Requesting device…');
    const dev = await navigator.bluetooth.requestDevice({
      filters: [{ services: ['heart_rate'] }],
      optionalServices: ['heart_rate', PMD_SERVICE],
    });
    deviceName = dev.name || '(unnamed)';
    dev.addEventListener('gattserverdisconnected', () => setStatus('Disconnected.'));
    setStatus('Connecting…');
    const server = await dev.gatt.connect();
    startedISO = new Date().toISOString();

    // Heart Rate service (RR) — always present
    try {
      const hrs = await server.getPrimaryService('heart_rate');
      hrmChar = await hrs.getCharacteristic('heart_rate_measurement');
      $('rrStart').disabled = false;
    } catch { setStatus('No Heart Rate service (unexpected for an H10).'); }

    // Polar Measurement Data service (ECG)
    try {
      const pmd = await server.getPrimaryService(PMD_SERVICE);
      cpChar = await pmd.getCharacteristic(PMD_CONTROL);
      dataChar = await pmd.getCharacteristic(PMD_DATA);
      await cpChar.startNotifications();
      cpChar.addEventListener('characteristicvaluechanged', onControl);
      await dataChar.startNotifications();
      dataChar.addEventListener('characteristicvaluechanged', onData);
      $('ecgStart').disabled = false;
    } catch { setStatus(s => s); /* ECG unavailable */ $('ecgStart').title = 'PMD/ECG not available on this device'; }

    $('reset').disabled = false;
    setStatus(`Connected: <b>${deviceName}</b>. Start ECG and/or RR capture.` + (cpChar ? '' : ' <span class="warn">(ECG/PMD not found — RR only)</span>'));
  } catch (err) { setStatus('<span class="warn">Connect failed:</span> ' + err.message); }
}

// ---- ECG (PMD) ----
async function startEcg() {
  if (!cpChar) return;
  try { await cpChar.writeValueWithResponse(ECG_START); ecgOn = true; $('ecgStart').disabled = true; $('ecgStop').disabled = false; setStatus('Recording ECG @130 Hz…'); }
  catch (e) { setStatus('<span class="warn">ECG start failed:</span> ' + e.message); }
}
async function stopEcg() {
  if (!cpChar) return;
  try { await cpChar.writeValueWithResponse(ECG_STOP); } catch {}
  ecgOn = false; $('ecgStart').disabled = false; $('ecgStop').disabled = true; setStatus('ECG stopped.');
}
function onControl(e) {
  const r = parseControlResponse(e.target.value);
  if (r && !r.ok) setStatus(`<span class="warn">ECG error:</span> ${PMD_STATUS[r.status] || 'status ' + r.status}`);
}
function onData(e) {
  const f = parseEcgFrame(e.target.value);
  if (!f || !f.samples.length) return;
  for (const s of f.samples) ecg.push(s);
  $('ecgN').textContent = ecg.length;
  $('ecgDur').textContent = (ecg.length / ECG_SAMPLE_RATE).toFixed(1);
  $('dlEcgCsv').disabled = ecg.length === 0;
  drawEcg();
}

// ---- RR (HRS) ----
async function startRr() {
  if (!hrmChar) return;
  await hrmChar.startNotifications();
  hrmChar.addEventListener('characteristicvaluechanged', onHrm);
  rrOn = true; $('rrStart').disabled = true; $('rrStop').disabled = false;
}
async function stopRr() {
  if (!hrmChar) return;
  try { await hrmChar.stopNotifications(); } catch {}
  hrmChar.removeEventListener('characteristicvaluechanged', onHrm);
  rrOn = false; $('rrStart').disabled = false; $('rrStop').disabled = true;
}
function onHrm(e) {
  const { hr, rr } = parseHeartRateMeasurement(e.target.value);
  hrInstant = hr;
  for (const v of rr) rrMs.push(v);
  $('rrN').textContent = rrMs.length;
  $('rrHr').textContent = hr ?? '—';
  const secs = rrMs.reduce((a, b) => a + b, 0) / 1000;
  $('rrDur').textContent = `${Math.floor(secs / 60)}:${String(Math.floor(secs % 60)).padStart(2, '0')}`;
  $('dlRrTxt').disabled = $('dlRrCsv').disabled = $('dlJson').disabled = rrMs.length === 0 && ecg.length === 0;
  drawRr();
}

// ---- live traces ----
function trace(canvas, data, color) {
  const ctx = canvas.getContext('2d'), dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight || 150;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, w, h);
  if (data.length < 2) return;
  const pad = 8, lo = Math.min(...data), hi = Math.max(...data), span = (hi - lo) || 1;
  const X = i => pad + (w - 2 * pad) * (i / (data.length - 1));
  const Y = v => (h - pad) - (h - 2 * pad) * ((v - lo) / span);
  ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.lineJoin = 'round'; ctx.lineCap = 'round'; ctx.beginPath();
  data.forEach((v, i) => i ? ctx.lineTo(X(i), Y(v)) : ctx.moveTo(X(i), Y(v))); ctx.stroke();
}
const drawEcg = () => trace($('ecg'), ecg.slice(-Math.round(2.5 * ECG_SAMPLE_RATE)), cssVar('--series'));
const drawRr = () => trace($('rr'), rrMs.slice(-150), cssVar('--series2'));
window.addEventListener('resize', () => { drawEcg(); drawRr(); });

// ---- downloads ----
function download(name, text, mime = 'text/plain') {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement('a'); a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
const stamp = () => (startedISO || new Date().toISOString()).replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
function ecgCsv() { let s = 't_s,ecg_uV\n'; const dt = 1 / ECG_SAMPLE_RATE; for (let i = 0; i < ecg.length; i++) s += `${(i * dt).toFixed(6)},${ecg[i]}\n`; return s; }
function rrTxtStr() { return rrMs.map(x => x.toFixed(1)).join('\n') + '\n'; }
function rrCsv() { let s = 'index,rr_ms,t_s\n', t = 0; for (let i = 0; i < rrMs.length; i++) { t += rrMs[i] / 1000; s += `${i + 1},${rrMs[i].toFixed(1)},${t.toFixed(3)}\n`; } return s; }
function sessionJson() {
  return JSON.stringify({
    device: deviceName, started: startedISO, exported: new Date().toISOString(),
    ecg: { sample_rate_hz: ECG_SAMPLE_RATE, unit: 'uV', n: ecg.length, samples: ecg },
    rr: { unit: 'ms', n: rrMs.length, intervals: rrMs.map(x => +x.toFixed(1)) },
  });
}

// ---- reset ----
function reset() {
  ecg.length = 0; rrMs.length = 0; hrInstant = null;
  $('ecgN').textContent = '0'; $('ecgDur').textContent = '0.0'; $('rrN').textContent = '0'; $('rrDur').textContent = '0:00'; $('rrHr').textContent = '—';
  ['dlEcgCsv', 'dlRrTxt', 'dlRrCsv', 'dlJson'].forEach(id => $(id).disabled = true);
  drawEcg(); drawRr(); setStatus('Captured data cleared.');
}

// ---- wire up ----
$('connect').addEventListener('click', connect);
$('ecgStart').addEventListener('click', startEcg);
$('ecgStop').addEventListener('click', stopEcg);
$('rrStart').addEventListener('click', startRr);
$('rrStop').addEventListener('click', stopRr);
$('reset').addEventListener('click', reset);
$('dlEcgCsv').addEventListener('click', () => download(`polar-h10-ecg_${stamp()}.csv`, ecgCsv(), 'text/csv'));
$('dlRrTxt').addEventListener('click', () => download(`polar-h10-rr_${stamp()}.txt`, rrTxtStr()));
$('dlRrCsv').addEventListener('click', () => download(`polar-h10-rr_${stamp()}.csv`, rrCsv(), 'text/csv'));
$('dlJson').addEventListener('click', () => download(`polar-h10-session_${stamp()}.json`, sessionJson(), 'application/json'));
if (!navigator.bluetooth) setStatus('<span class="warn">Web Bluetooth unavailable</span> — use Chrome/Edge over https or http://localhost.');
