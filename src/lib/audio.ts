/**
 * Speech measurement.
 *
 * WebRTC carries the microphone and the interviewee's voice natively, so this
 * file no longer encodes, decodes or schedules any audio — the PCM helpers and
 * the hand-rolled player that the Gemini build needed are gone.
 *
 * What remains is measurement. Speaking time must never be derived from
 * transcript timestamps: that produced a permanent 0:00 for the student and a
 * 0%/100% talk ratio. Both sides are measured from their audio instead, with
 * the same energy gate, so the two numbers are comparable.
 */

// Amplitude above which a frame counts as speech, and how long speech keeps
// counting after energy drops, so gaps between words inside one sentence are
// not shaved off.
const VOICE_RMS_THRESHOLD = 0.015;
const VOICE_HANGOVER_MS = 400;
const SAMPLE_INTERVAL_MS = 50;

export function rms(samples: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / samples.length);
}

export interface SpeechMeter {
  /** Total voiced milliseconds observed on this stream so far. */
  readonly speechMs: number;
  readonly speaking: boolean;
  stop(): void;
}

/**
 * Watch a MediaStream and accumulate how long it carried speech. Used for both
 * the local microphone and the remote track.
 *
 * Note for the remote stream: the track must also be attached to an <audio>
 * element or Chrome delivers no samples to the Web Audio graph, and this meter
 * silently reads zero.
 */
export function createSpeechMeter(
  stream: MediaStream,
  onSpeakingChange?: (speaking: boolean) => void
): SpeechMeter {
  const AudioCtxClass = window.AudioContext || (window as any).webkitAudioContext;
  const ctx: AudioContext = new AudioCtxClass();
  const source = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  source.connect(analyser);

  const buf = new Float32Array(analyser.fftSize);
  let speechMs = 0;
  let speaking = false;
  let msSinceVoice = Infinity;
  let stopped = false;

  const setSpeaking = (next: boolean) => {
    if (speaking === next) return;
    speaking = next;
    onSpeakingChange?.(next);
  };

  const timer = setInterval(() => {
    if (stopped) return;
    analyser.getFloatTimeDomainData(buf);
    if (rms(buf) >= VOICE_RMS_THRESHOLD) {
      msSinceVoice = 0;
      speechMs += SAMPLE_INTERVAL_MS;
      setSpeaking(true);
    } else {
      msSinceVoice += SAMPLE_INTERVAL_MS;
      if (msSinceVoice < VOICE_HANGOVER_MS) speechMs += SAMPLE_INTERVAL_MS;
      else setSpeaking(false);
    }
  }, SAMPLE_INTERVAL_MS);

  return {
    get speechMs() {
      return speechMs;
    },
    get speaking() {
      return speaking;
    },
    stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      setSpeaking(false);
      try {
        source.disconnect();
      } catch {
        // ignore
      }
      void ctx.close().catch(() => {});
    },
  };
}
