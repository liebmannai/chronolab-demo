// hrm.mjs -- parse the Bluetooth SIG "Heart Rate Measurement" characteristic (0x2A37).
// Spec: byte0 = flags; bit0 HR format (0=uint8,1=uint16); bit3 energy-expended present;
// bit4 RR-interval present. RR intervals are uint16 little-endian in units of 1/1024 s.
// Returns { hr: bpm, rr: [ms, ...], contact: bool|null }.

export function parseHeartRateMeasurement(dv) {
  const flags = dv.getUint8(0);
  const hr16 = (flags & 0x01) !== 0;
  const contactSupported = (flags & 0x04) !== 0;
  const contact = contactSupported ? (flags & 0x02) !== 0 : null;
  const energyPresent = (flags & 0x08) !== 0;
  const rrPresent = (flags & 0x10) !== 0;

  let i = 1;
  let hr;
  if (hr16) { hr = dv.getUint16(i, true); i += 2; }
  else { hr = dv.getUint8(i); i += 1; }
  if (energyPresent) i += 2; // skip energy expended (uint16)

  const rr = [];
  if (rrPresent) {
    for (; i + 2 <= dv.byteLength; i += 2) {
      rr.push(dv.getUint16(i, true) * 1000 / 1024); // 1/1024 s -> ms
    }
  }
  return { hr, rr, contact };
}
