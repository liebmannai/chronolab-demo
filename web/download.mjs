// download.mjs -- connect a Movesense/HeartBalance sensor and capture its on-device data over BLE
// (Whiteboard over Nordic UART Service). Enumerates GATT, sends candidate commands, logs raw frames,
// accumulates payloads, and downloads them. Experimental: framing is being reverse-engineered.
import { MS_SERVICE, MS_WRITE, MS_NOTIFY, subscribeCmd, unsubscribeCmd, PROBE_SERVICES } from './movesense-ble.mjs';

const $ = id => document.getElementById(id);
const setStatus = h => $('status').innerHTML = h;
const hex = u8 => [...u8].map(b => b.toString(16).padStart(2, '0')).join(' ');
const ascii = u8 => [...u8].map(b => (b >= 32 && b < 127) ? String.fromCharCode(b) : '·').join('');

let rx = null, tx = null, ref = 10, frames = 0;
let payload = [];                 // accumulated data-frame payloads (bytes after [respType, ref])
let logLines = [];

function log(s) { logLines.push(s); if (logLines.length > 400) logLines.shift(); $('log').textContent = logLines.join('\n'); $('log').scrollTop = $('log').scrollHeight; $('dlLog').disabled = false; }

async function connect() {
  if (!navigator.bluetooth) { setStatus('<span class="warn">Web Bluetooth unavailable</span> — Chrome/Edge over https or localhost.'); return; }
  try {
    setStatus('Pick your Movesense / HeartBalance sensor…');
    const dev = await navigator.bluetooth.requestDevice({ acceptAllDevices: true, optionalServices: PROBE_SERVICES });
    dev.addEventListener('gattserverdisconnected', () => setStatus('Disconnected.'));
    setStatus(`Connecting to <b>${dev.name || 'sensor'}</b>…`);
    const server = await dev.gatt.connect();
    await enumerate(server);
    // wire the Nordic UART Service (Whiteboard transport) if present
    try {
      const svc = await server.getPrimaryService(MS_SERVICE);
      rx = await svc.getCharacteristic(MS_WRITE);
      tx = await svc.getCharacteristic(MS_NOTIFY);
      await tx.startNotifications();
      tx.addEventListener('characteristicvaluechanged', onData);
      enableCmds(true);
      setStatus(`Connected: <b>${dev.name || 'sensor'}</b>. NUS ready — send a command (try <b>Status</b> first).`);
    } catch (e) {
      setStatus(`Connected: <b>${dev.name || 'sensor'}</b>, but the Nordic UART Service wasn't found. See the GATT list — send me it.`);
    }
    $('clear').disabled = false;
  } catch (err) { setStatus('<span class="warn">Connect failed:</span> ' + err.message); }
}

async function enumerate(server) {
  const lines = [];
  let svcs = [];
  try { svcs = await server.getPrimaryServices(); } catch {}
  for (const s of svcs) {
    let line = s.uuid;
    try {
      const chars = await s.getCharacteristics();
      line += '\n   ' + chars.map(c => {
        const p = c.properties, f = [p.read && 'R', p.write && 'W', p.writeWithoutResponse && 'w', p.notify && 'N', p.indicate && 'I'].filter(Boolean).join('');
        return `${c.uuid.slice(4, 8)} [${f}]`;
      }).join('  ');
    } catch {}
    lines.push(line);
  }
  $('svcs').textContent = lines.length ? lines.join('\n') : '(no probed services present — send me the device name)';
}

function onData(e) {
  const u8 = new Uint8Array(e.target.value.buffer);
  frames++;
  if (frames <= 200) log(`#${frames} (${u8.length}B)  ${hex(u8.slice(0, 20))}${u8.length > 20 ? ' …' : ''}   "${ascii(u8.slice(0, 24))}"`);
  // data frame = [respType, ref, ...payload]; accumulate payload for reassembly
  const body = u8.length >= 2 ? u8.slice(2) : u8;
  for (const b of body) payload.push(b);
  updateCapture();
}

function updateCapture() {
  $('capsum').textContent = `— ${frames} frames, ${payload.length} payload bytes`;
  const bytes = new Uint8Array(payload);
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  $('preview').textContent = text.slice(0, 800) || '—';
  $('dlData').disabled = payload.length === 0;
  // try to parse as the HeartBalance JSON recording
  try {
    const d = JSON.parse(text);
    const peaks = (d.HeartBalance && d.HeartBalance.PeakData) || d.PeakData;
    if (Array.isArray(peaks)) { $('parsed').textContent = `✓ parsed HeartBalance JSON — ${peaks.length} peaks`; }
  } catch { $('parsed').textContent = ''; }
}

async function sendCmd(bytes) {
  if (!rx) { setStatus('<span class="warn">No command channel (NUS not connected).</span>'); return; }
  try { await rx.writeValueWithoutResponse(bytes); } catch { try { await rx.writeValueWithResponse(bytes); } catch (e) { setStatus('<span class="warn">Write failed:</span> ' + e.message); return; } }
  log(`» sent  ${hex(bytes)}   "${ascii(bytes)}"`);
}
function subscribe(path) { const r = ref++; setStatus(`Subscribing <code>${path}</code> (ref ${r})…`); sendCmd(subscribeCmd(path, r)); }

function enableCmds(on) {
  document.querySelectorAll('#cmds button[data-path]').forEach(b => b.disabled = !on);
  $('unsub').disabled = $('raw').disabled = $('sendRaw').disabled = !on;
}

function download(name, data, mime) {
  const url = URL.createObjectURL(new Blob([data], { type: mime }));
  const a = document.createElement('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---- wiring ----
$('connect').addEventListener('click', connect);
$('clear').addEventListener('click', () => { payload = []; frames = 0; logLines = []; $('log').textContent = '—'; $('preview').textContent = '—'; $('capsum').textContent = ''; $('logsum').textContent = ''; $('parsed').textContent = ''; $('dlData').disabled = $('dlLog').disabled = true; });
document.querySelectorAll('#cmds button[data-path]').forEach(b => b.addEventListener('click', () => subscribe(b.dataset.path)));
$('unsub').addEventListener('click', () => sendCmd(unsubscribeCmd(ref - 1)));
$('sendRaw').addEventListener('click', () => {
  const bytes = ($('raw').value.match(/[0-9a-fA-F]{2}/g) || []).map(h => parseInt(h, 16));
  if (bytes.length) sendCmd(new Uint8Array(bytes));
});
$('dlData').addEventListener('click', () => {
  const bytes = new Uint8Array(payload);
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  const looksJson = text.trim()[0] === '{' || text.trim()[0] === '[';
  download(looksJson ? 'movesense-recording.json' : 'movesense-capture.bin', looksJson ? text : bytes, looksJson ? 'application/json' : 'application/octet-stream');
});
$('dlLog').addEventListener('click', () => download('movesense-ble-log.txt', logLines.join('\n') + '\n', 'text/plain'));
if (!navigator.bluetooth) setStatus('<span class="warn">Web Bluetooth unavailable</span> — Chrome/Edge over https or localhost.');
