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
export const MS_REF_HR  = 99;

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
