/**
 * Utility functions for browser audio recording (16kHz PCM)
 * and low-latency gapless playback (24kHz PCM).
 */

// Convert Float32Array mic samples to 16-bit Int16 PCM Base64
export function pcmFloat32ToBase64(float32Array: Float32Array): string {
  const buffer = new ArrayBuffer(float32Array.length * 2);
  const view = new DataView(buffer);
  for (let i = 0; i < float32Array.length; i++) {
    const s = Math.max(-1, Math.min(1, float32Array[i]));
    // 16-bit signed PCM
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  let binary = "";
  const bytes = new Uint8Array(buffer);
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

// Convert Base64 16-bit PCM (24kHz or 16kHz) to Float32Array for Web Audio API
export function base64ToFloat32Pcm(base64: string): Float32Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  const int16Array = new Int16Array(bytes.buffer);
  const float32Array = new Float32Array(int16Array.length);
  for (let i = 0; i < int16Array.length; i++) {
    float32Array[i] = int16Array[i] / 32768.0;
  }
  return float32Array;
}

// Duration in ms of a base64-encoded 16-bit mono PCM chunk.
// base64 length * 3/4 bytes, 2 bytes per sample.
export function base64PcmDurationMs(base64: string, sampleRate: number): number {
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  const bytes = (base64.length * 3) / 4 - padding;
  const samples = bytes / 2;
  return (samples / sampleRate) * 1000;
}

// Audio Player Manager for 24kHz audio streams
export class PcmAudioPlayer {
  private audioCtx: AudioContext | null = null;
  private nextStartTime = 0;

  constructor(private sampleRate = 24000) {}

  public init() {
    if (!this.audioCtx) {
      const AudioCtxClass = window.AudioContext || (window as any).webkitAudioContext;
      this.audioCtx = new AudioCtxClass({ sampleRate: this.sampleRate });
    }
    if (this.audioCtx!.state === "suspended") {
      this.audioCtx!.resume();
    }
  }

  public playChunk(base64Pcm: string) {
    this.init();
    if (!this.audioCtx) return;

    try {
      const pcmData = base64ToFloat32Pcm(base64Pcm);
      if (pcmData.length === 0) return;

      const buffer = this.audioCtx.createBuffer(1, pcmData.length, this.sampleRate);
      buffer.getChannelData(0).set(pcmData);

      const source = this.audioCtx.createBufferSource();
      source.buffer = buffer;
      source.connect(this.audioCtx.destination);

      const currentTime = this.audioCtx.currentTime;
      if (this.nextStartTime < currentTime) {
        this.nextStartTime = currentTime;
      }

      source.start(this.nextStartTime);
      this.nextStartTime += buffer.duration;
    } catch (err) {
      console.error("Error playing PCM chunk:", err);
    }
  }

  public stop() {
    if (this.audioCtx) {
      try {
        this.audioCtx.close();
      } catch {
        // ignore
      }
      this.audioCtx = null;
    }
    this.nextStartTime = 0;
  }

  public isCurrentlyPlaying(): boolean {
    return this.audioCtx ? this.audioCtx.currentTime < this.nextStartTime : false;
  }
}
