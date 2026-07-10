// movesense-ble.mjs -- Movesense "Whiteboard over BLE" protocol. The device exposes its data over
// the Movesense service (nRF Connect scan of "Movesense 242930002155": service 0xFDF3 with a 128-bit
// command/notify pair 6B20000{1,2}-FF4E-4979-8186-FB7BA486FCD7). No standard 0x2A37 HR characteristic.
//
// Protocol: write [op, ref, ...utf8(path)] to the command characteristic; data arrives on the notify
// characteristic as [respType, ref, ...payload]. op 1 = GET+SUBSCRIBE, 2 = UNSUBSCRIBE; respType 2 =
// data. For /Meas/HR the payload is float32 `average` then uint16[] `rrData` (ms).

export const MS_SERVICE = '0000fdf3-0000-1000-8000-00805f9b34fb'; // Movesense data service ("FDF3")
export const MS_WRITE   = '6b200001-ff4e-4979-8186-fb7ba486fcd7'; // command (write / write-no-response)
export const MS_NOTIFY  = '6b200002-ff4e-4979-8186-fb7ba486fcd7'; // data (notify)
export const HR_PATH      = '/Meas/HR';              // Movesense HR resource (average + rrData ms)
export const HB_PEAK_PATH = '/HeartBalance/PeakData';// custom HeartBalance recording peaks (rr, amplitude)
export const HB_META_PATH = '/HeartBalance/MetaData';// battery/event/timestamp
export const HB_ACC_PATH  = '/HeartBalance/AccData'; // accelerometer x/y/z
export const HB_STATUS_PATH = '/HeartBalance/Status';// recording state / length
export const INFO_PATH    = '/Info';                 // device info
export const MS_REF_HR  = 99;

// Web Bluetooth only exposes services declared up-front, so probe a candidate list to see what the
// device actually has (this also reveals whether NUS is the exposed transport).
export const PROBE_SERVICES = [
  '0000fdf3-0000-1000-8000-00805f9b34fb', // Movesense data service ("FDF3") — the real one
  '6e400001-b5a3-f393-e0a9-e50e24dcca9e', // Nordic UART Service
  '34802252-7185-4d5d-b431-630e7050e8f0', // legacy Movesense sensor-data service
  '0000fe59-0000-1000-8000-00805f9b34fb', // Nordic DFU
  '0000180a-0000-1000-8000-00805f9b34fb', // Device Information
  '0000180f-0000-1000-8000-00805f9b34fb', // Battery
  '0000180d-0000-1000-8000-00805f9b34fb', // Heart Rate
];

// Movesense GATT SensorData Protocol (GSP) command opcodes.
export const GSP = { HELLO: 0x00, SUBSCRIBE: 0x01, UNSUBSCRIBE: 0x02, FETCH_LOG: 0x03, GET: 0x04, CLEAR_LOGBOOK: 0x05 };
const enc = new TextEncoder();
// command = [opcode, reference, ...data]. SUBSCRIBE/GET take a NULL-TERMINATED utf-8 path.
export const helloCmd       = (ref = MS_REF_HR) => new Uint8Array([GSP.HELLO, ref]);
export const subscribeCmd   = (path, ref = MS_REF_HR) => new Uint8Array([GSP.SUBSCRIBE, ref, ...enc.encode(path), 0]);
export const unsubscribeCmd = (ref = MS_REF_HR) => new Uint8Array([GSP.UNSUBSCRIBE, ref]);
export const getCmd         = (path, ref = MS_REF_HR) => new Uint8Array([GSP.GET, ref, ...enc.encode(path), 0]);
export const clearLogbookCmd = (ref = MS_REF_HR) => new Uint8Array([GSP.CLEAR_LOGBOOK, ref]);
export function fetchLogCmd(logId, ref = MS_REF_HR) {
  const b = new Uint8Array([GSP.FETCH_LOG, ref, 0, 0, 0, 0]);
  new DataView(b.buffer).setUint32(2, logId >>> 0, true); // uint32 LE logID
  return b;
}

// ── Movesense Whiteboard protocol_v9 HELLO handshake ─────────────────────────────────
// Reverse-engineered from MdsLib (mikkojeronen/MovesenseMds-iOS → MdsLib.xcframework, unstripped):
//   whiteboard::WhiteboardCommunication::sendHandshake / handleHelloMessage.
// The FDF3 service speaks the full Whiteboard protocol; the sensor answers NOTHING until it
// receives a HELLO that establishes a route ("Connection timeout ... waiting hello").
//
// On-wire whiteboard message = [6-byte DataMessageHeader][32-byte HELLO payload], written to 6b200001.
//   VALIDATED from the binary:
//     • message type HELLO = 0x12 (ack 0x13); header byte[1] = (flag<<7)|(type&0x7f)  → 0x12
//     • base header length = 6 (getHeaderLength(false)=6; +0x19 with routing)
//     • payload[0]=0x09, payload[1]=0x09  (commVersion / minCommVersion = 9; parser does cmp $0x9)
//   BEST-GUESS (not yet verified against hardware — iterate if the sensor stays silent):
//     • header[0], and the two header uint16s at [2..3]/[4..5] (length + MessageType)
//     • payload[2]=routeId(0), [3..14]=12-byte SuuntoSerial, [15..22]=WhiteboardVersion(0),
//       [23]=capability flags(0), [24..31]=0
export const WB_MSG = { HELLO: 0x12, HELLO_ACK: 0x13 };
export function helloWbCmd(serial = '000000000001', opt = {}) {
  const payload = new Uint8Array(32);
  payload[0] = 0x09; payload[1] = 0x09;                 // commVersion / minCommVersion  (VALIDATED)
  payload[2] = opt.routeId ?? 0;
  const s = enc.encode(String(serial).replace(/\D/g, '').padEnd(12, '0').slice(0, 12));
  payload.set(s.slice(0, 12), 3);                       // [3..14] 12-byte serial
  // [15..22] WhiteboardVersion, [23] flags, [24..31] left 0
  const header = new Uint8Array(6);
  const dv = new DataView(header.buffer);
  header[0] = opt.h0 ?? 0x00;
  header[1] = WB_MSG.HELLO;                             // type|flag  (VALIDATED: 0x12)
  dv.setUint16(2, opt.lenField ?? payload.length, true); // guess: payload length (LE)
  dv.setUint16(4, opt.typeField ?? WB_MSG.HELLO, true);  // guess: MessageType (LE)
  const msg = new Uint8Array(header.length + payload.length);
  msg.set(header, 0); msg.set(payload, 6);
  return msg;
}

// Parse a GSP DATA notification (opcode 0x02) for the HR resource (/Meas/HR). SBEM: float32 average
// then a uint8-length-prefixed uint16[] rrData (ms). -> { respType, ref, average, rr:[ms,...] }.
export function parseMovesenseHr(dv) {
  if (dv.byteLength < 2) return null;
  const respType = dv.getUint8(0), ref = dv.getUint8(1);
  if (respType !== 0x02 || dv.byteLength < 6) return { respType, ref, average: NaN, rr: [] };
  const average = dv.getFloat32(2, true);
  const rr = [];
  let i = 6;
  const remU16 = Math.floor((dv.byteLength - 7) / 2);
  if (i < dv.byteLength && dv.getUint8(i) === remU16 && remU16 >= 0) i += 1; // consume SBEM array length byte if present
  for (; i + 2 <= dv.byteLength; i += 2) { const v = dv.getUint16(i, true); if (v > 0 && v < 4000) rr.push(v); }
  return { respType, ref, average, rr };
}
