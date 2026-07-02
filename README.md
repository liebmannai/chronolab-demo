# ChronoLab — Live HRV demo

Compute **heart-rate variability (HRV)** live in the browser from a Bluetooth heart-rate strap —
entirely client-side, no server. A small **Rust → WebAssembly** core (~60 KB) does the maths and
**Web Bluetooth** reads the sensor. Includes a hardware-free **Simulate** mode.

**▶ Live: https://liebmannai.github.io/chronolab-demo/**

## Use it

- **Chrome / Edge** — *Connect sensor* (needs a strap that reports RR intervals, e.g. Polar H10),
  or *Simulate*.
- **Any browser (incl. Firefox / Safari)** — *Simulate*. Live sensor input needs Web Bluetooth,
  which today is Chrome/Edge only.

It shows heart rate, a live RR-interval tachogram, and time- & frequency-domain HRV — SDNN, RMSSD,
pNN50, LRSA, LF/HF, the vegetative quotient (VQ), and composite vitality indices.

## Notes

- Everything runs on your device; RR data never leaves the browser.
- Metrics stabilise as data accumulates (the frequency-domain ones need ~1–5 minutes).
- Research / educational demo — **not a medical device**.
