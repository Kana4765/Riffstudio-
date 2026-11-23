/** Level below which leading audio counts as silence. */
export const TRIM_THRESHOLD_DB = -48;
/** Fade-in applied to the kept pre-roll so the cut never clicks. */
export const TRIM_FADE_MS = 2;

export interface TrimResult {
  buffer: AudioBuffer;
  /** Seconds removed from the start. */
  trimmedSeconds: number;
}

/**
 * Removes leading silence (below -48 dBFS on every channel) so user recordings and uploads start on the hit
 * and never sound behind the beat. Up to 2 ms before the onset are kept and faded in from zero, so the cut
 * can't click and the transient itself is never touched.
 */
export function trimLeadingSilence(
  ctx: BaseAudioContext,
  input: AudioBuffer,
  thresholdDb = TRIM_THRESHOLD_DB,
  fadeMs = TRIM_FADE_MS,
): TrimResult {
  const threshold = Math.pow(10, thresholdDb / 20);
  const channels = Array.from({ length: input.numberOfChannels }, (_, c) => input.getChannelData(c));
  let onset = -1;
  for (let i = 0; i < input.length && onset < 0; i++) {
    for (const data of channels) {
      if (Math.abs(data[i]) >= threshold) {
        onset = i;
        break;
      }
    }
  }
  if (onset < 0) return { buffer: input, trimmedSeconds: 0 };
  const fadeSamples = Math.max(1, Math.round((fadeMs / 1000) * input.sampleRate));
  const start = Math.max(0, onset - fadeSamples);
  if (start === 0) return { buffer: input, trimmedSeconds: 0 };
  const length = input.length - start;
  const out = ctx.createBuffer(input.numberOfChannels, length, input.sampleRate);
  for (let c = 0; c < input.numberOfChannels; c++) {
    const src = channels[c];
    const dst = out.getChannelData(c);
    dst.set(src.subarray(start));
    // Fade only the kept pre-roll (onset - start samples); a file that already starts on the hit is untouched.
    const fade = Math.min(onset - start, length);
    for (let i = 0; i < fade; i++) dst[i] *= i / fade;
  }
  return { buffer: out, trimmedSeconds: start / input.sampleRate };
}
