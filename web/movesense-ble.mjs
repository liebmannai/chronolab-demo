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
