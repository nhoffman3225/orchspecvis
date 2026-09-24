// Preset stops for the "+ harmonics >= X dB" slider.
// Slider value: 0 = off, 1 = 0 dB, 2 = -1 dB, ... 97 = -96 dB.

export const HARM_PRESETS: readonly (number | null)[] = [null, 0, -6, -12, -20, -30, -40, -60];

export const harmSliderValue = (db: number | null): number => (db === null ? 0 : 1 - db);

/** Snap to a preset when within `radius` slider steps of it (never snaps away from off). */
export function snapHarm(v: number, radius = 1): number {
  for (const p of HARM_PRESETS) {
    const pv = harmSliderValue(p);
    if (Math.abs(v - pv) <= radius && !(p === null && v !== 0)) return pv;
  }
  return v;
}
