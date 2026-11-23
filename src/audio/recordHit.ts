/**
 * Records a single drum hit from a microphone or audio interface with MediaRecorder.
 * Echo cancellation, noise suppression and auto-gain are switched off so the transient and dynamics are
 * captured as played. Leading silence is removed later, when the sample is decoded (see trimSilence.ts).
 */

export interface RecordedHit {
  arrayBuffer: ArrayBuffer;
  mimeType: string;
}

export interface HitRecorder {
  /** Stops recording and returns the encoded audio. */
  stop(): Promise<RecordedHit>;
  /** Stops and discards the recording. */
  cancel(): void;
  /** Current input peak level, 0–1 (for a level meter). */
  level(): number;
  readonly startedAt: number;
}

const MIME_CANDIDATES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];

export function micRecordingSupported(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== 'undefined';
}

export function extensionForMime(mime: string): string {
  if (mime.includes('ogg')) return 'ogg';
  if (mime.includes('mp4')) return 'm4a';
  return 'webm';
}

function friendlyError(err: unknown): Error {
  const name = err instanceof DOMException ? err.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return new Error('Microphone access was denied. Allow microphone access for RiffForge and try again.');
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return new Error('No microphone or audio input was found.');
  if (name === 'NotReadableError') return new Error('The audio input is in use by another application.');
  return err instanceof Error ? err : new Error(String(err));
}

/**
 * Starts recording. `onAutoStop` fires when `maxSeconds` is reached; call `stop()` then to collect the audio.
 */
export async function startHitRecording(maxSeconds: number, onAutoStop: () => void): Promise<HitRecorder> {
  if (!micRecordingSupported()) throw new Error('Recording is not supported in this WebView.');
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
  } catch (err) {
    throw friendlyError(err);
  }

  const mimeType = MIME_CANDIDATES.find((m) => MediaRecorder.isTypeSupported(m)) ?? '';
  const recorder = new MediaRecorder(stream, mimeType ? { mimeType, audioBitsPerSecond: 256_000 } : undefined);
  const chunks: Blob[] = [];
  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  };

  // Input level meter (separate, short-lived context; nothing is routed to the speakers).
  let meterCtx: AudioContext | null = null;
  let analyser: AnalyserNode | null = null;
  let meterBuf: Float32Array<ArrayBuffer> | null = null;
  try {
    meterCtx = new AudioContext();
    const source = meterCtx.createMediaStreamSource(stream);
    analyser = meterCtx.createAnalyser();
    analyser.fftSize = 1024;
    meterBuf = new Float32Array(analyser.fftSize);
    source.connect(analyser);
  } catch {
    meterCtx = null;
  }

  const cleanup = () => {
    window.clearTimeout(timer);
    stream.getTracks().forEach((t) => t.stop());
    void meterCtx?.close().catch(() => undefined);
  };

  recorder.start();
  const startedAt = performance.now();
  const timer = window.setTimeout(onAutoStop, maxSeconds * 1000);
  let finished = false;

  return {
    startedAt,
    level() {
      if (!analyser || !meterBuf) return 0;
      analyser.getFloatTimeDomainData(meterBuf);
      let peak = 0;
      for (const v of meterBuf) peak = Math.max(peak, Math.abs(v));
      return Math.min(1, peak);
    },
    cancel() {
      if (finished) return;
      finished = true;
      if (recorder.state !== 'inactive') recorder.stop();
      cleanup();
    },
    stop() {
      if (finished) return Promise.reject(new Error('Recording already finished'));
      finished = true;
      return new Promise<RecordedHit>((resolve, reject) => {
        recorder.onstop = () => {
          cleanup();
          const type = recorder.mimeType || mimeType || 'audio/webm';
          new Blob(chunks, { type })
            .arrayBuffer()
            .then((arrayBuffer) => {
              if (arrayBuffer.byteLength === 0) reject(new Error('Nothing was recorded — check the input device.'));
              else resolve({ arrayBuffer, mimeType: type });
            })
            .catch(reject);
        };
        recorder.onerror = () => {
          cleanup();
          reject(new Error('Recording failed'));
        };
        if (recorder.state !== 'inactive') recorder.stop();
      });
    },
  };
}
