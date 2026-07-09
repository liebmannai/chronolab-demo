// movesense-ble.mjs -- Movesense "Whiteboard over BLE" protocol (custom sensor-data service).
// Used as a fallback/native path for the Movesense HR2; the standard Heart Rate service (0x2A37,
// parsed by hrm.mjs) is the primary path. Refs: Movesense mobile lib / community BLE examples.
//
// Protocol: write [op, ref, ...utf8(path)] to the command characteristic; data arrives on the
// notify characteristic as [respType, ref, ...payload]. op 1 = GET+SUBSCRIBE, 2 = UNSUBSCRIBE;
// respType 2 = data. For /Meas/HR the payload is float32 `average` then uint16[] `rrData` (ms).

export const MS_SERVICE = '34802252-7185-4d5d-b431-630e7050e8f0';
export const MS_WRITE   = '34800001-7185-4d5d-b431-630e7050e8f0'; // commands (write)
export const MS_NOTIFY  = '34800002-7185-4d5d-b431-630e7050e8f0'; // data (notify)
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
