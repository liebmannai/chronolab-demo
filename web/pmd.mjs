// pmd.mjs -- Polar Measurement Data (PMD) service: raw ECG streaming from a Polar H10.
// PMD is Polar's proprietary GATT service; the H10 streams 130 Hz ECG (microvolts) over it.
// This module holds the UUIDs, the ECG start/stop control-point commands, and the data-frame
// parser (the BLE plumbing lives in record.mjs). Refs: Polar BLE SDK; widely-used community format.

export const PMD_SERVICE = 'fb005c80-02e7-f387-1cad-8acd2d8df0c8';
export const PMD_CONTROL = 'fb005c81-02e7-f387-1cad-8acd2d8df0c8'; // write + indicate
export const PMD_DATA    = 'fb005c82-02e7-f387-1cad-8acd2d8df0c8'; // notify

export const ECG_SAMPLE_RATE = 130; // Hz (H10)

// Control-point: START_MEASUREMENT(0x02), type ECG(0x00), setting SAMPLE_RATE(0x00)=130, RESOLUTION(0x01)=14
export const ECG_START = new Uint8Array([0x02, 0x00, 0x00, 0x01, 0x82, 0x00, 0x01, 0x01, 0x0e, 0x00]);
export const ECG_STOP  = new Uint8Array([0x03, 0x00]); // STOP_MEASUREMENT, type ECG

// Sign-extend a 24-bit little-endian value (Polar ECG samples are int24 microvolts).
export function int24(b0, b1, b2) {
  let v = b0 | (b1 << 8) | (b2 << 16);
  if (v & 0x800000) v -= 0x1000000;
  return v;
}

// Parse a PMD ECG data frame (DataView) -> { timestampNs, frameType, samples:[µV,...] } or null.
// Layout: [0]=measurement type (0x00 ECG); [1..8]=timestamp uint64 LE (ns); [9]=frame type
// (0 = raw int24); [10..]=samples, 3 bytes signed LE each.
export function parseEcgFrame(dv) {
  if (dv.byteLength < 10 || dv.getUint8(0) !== 0x00) return null;
  const timestampNs = dv.getBigUint64(1, true);
  const frameType = dv.getUint8(9);
  const samples = [];
  if (frameType === 0) {
    for (let i = 10; i + 3 <= dv.byteLength; i += 3) {
      samples.push(int24(dv.getUint8(i), dv.getUint8(i + 1), dv.getUint8(i + 2)));
    }
  }
  return { timestampNs, frameType, samples };
}

// Parse a PMD control-point response (indication) -> { opCode, measType, status, ok }.
export function parseControlResponse(dv) {
  if (dv.byteLength < 4 || dv.getUint8(0) !== 0xf0) return null; // 0xF0 = control-point response
  const opCode = dv.getUint8(1), measType = dv.getUint8(2), status = dv.getUint8(3);
  return { opCode, measType, status, ok: status === 0x00 };
}
export const PMD_STATUS = {
  0x00: 'success', 0x01: 'invalid op code', 0x02: 'invalid measurement type',
  0x03: 'not supported', 0x04: 'invalid length', 0x05: 'invalid parameter',
  0x06: 'already in state', 0x07: 'invalid resolution', 0x08: 'invalid sample rate',
  0x09: 'invalid range', 0x0a: 'invalid MTU', 0x0b: 'invalid number of channels',
  0x0c: 'invalid state', 0x0d: 'device in charger',
};
