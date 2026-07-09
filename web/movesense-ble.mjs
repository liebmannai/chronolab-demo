// movesense-ble.mjs -- Movesense "Whiteboard over BLE" protocol. On this device (HeartBalance
// custom firmware, verified from HeartBalance_FW_0.8/Movesense.bin) the Whiteboard runs over the
// Nordic UART Service (NUS) — the firmware string `BleNordicUART`, the NUS base UUID in the binary,
// and NO standard 0x2A37 HR characteristic. So RR comes via the Whiteboard resource /Meas/HR.
//
// Protocol: write [op, ref, ...utf8(path)] to the NUS RX characteristic; data arrives on the NUS TX
// characteristic as [respType, ref, ...payload]. op 1 = GET+SUBSCRIBE, 2 = UNSUBSCRIBE; respType 2 =
// data. For /Meas/HR the payload is float32 `average` then uint16[] `rrData` (ms).

export const MS_SERVICE = '6e400001-b5a3-f393-e0a9-e50e24dcca9e'; // Nordic UART Service
export const MS_WRITE   = '6e400002-b5a3-f393-e0a9-e50e24dcca9e'; // NUS RX (write commands)
export const MS_NOTIFY  = '6e400003-b5a3-f393-e0a9-e50e24dcca9e'; // NUS TX (notify data)
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
  '6e400001-b5a3-f393-e0a9-e50e24dcca9e', // Nordic UART Service (Movesense Whiteboard transport)
  '34802252-7185-4d5d-b431-630e7050e8f0', // legacy Movesense sensor-data service
  '0000fe59-0000-1000-8000-00805f9b34fb', // Nordic DFU
  '0000180a-0000-1000-8000-00805f9b34fb', // Device Information
  '0000180f-0000-1000-8000-00805f9b34fb', // Battery
  '0000180d-0000-1000-8000-00805f9b34fb', // Heart Rate
];

export function subscribeCmd(path, ref = MS_REF_HR) {
  return new Uint8Array([1, ref, ...new TextEncoder().encode(path)]);
}
export function unsubscribeCmd(ref = MS_REF_HR) {
  return new Uint8Array([2, ref]);
}

// Parse a Movesense notification for the HR resource (/Meas/HR).
// -> { respType, ref, average, rr:[ms,...] }  (rr empty for non-data / command responses)
export function parseMovesenseHr(dv) {
  if (dv.byteLength < 2) return null;
  const respType = dv.getUint8(0), ref = dv.getUint8(1);
  if (respType !== 2 || dv.byteLength < 6) return { respType, ref, average: NaN, rr: [] };
  const average = dv.getFloat32(2, true);
  const rr = [];
  for (let i = 6; i + 2 <= dv.byteLength; i += 2) {
    const v = dv.getUint16(i, true);
    if (v > 0 && v < 4000) rr.push(v); // rrData is in ms
  }
  return { respType, ref, average, rr };
}
