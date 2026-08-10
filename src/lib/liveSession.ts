import { GoogleGenAI, Modality, LiveServerMessage, Session } from "@google/genai";
import { Persona, SessionResult, Speaker, TranscriptEntry } from "../types";
import { PcmAudioPlayer, base64PcmDurationMs, pcmFloat32ToBase64, rms } from "./audio";

const LIVE_MODEL = "gemini-3.1-flash-live-preview";
// Consecutive transcription chunks from the same speaker closer together
// than this are merged into one transcript entry (one "turn").
const TURN_GAP_MS = 2000;

// Local voice-activity gate on the microphone. Gemini delivers the student's
// input transcription as a single blob once they stop talking, so transcript
// timestamps cannot tell us how long they spoke — every turn would measure
// 0 ms. Measuring the mic directly is both accurate and instant, which is
// also what drives the live "you are speaking" indicator.
const VOICE_RMS_THRESHOLD = 0.015;
// Keep counting as speech for a moment after energy drops, so the natural
// gaps between words inside one sentence are not shaved off.
const VOICE_HANGOVER_MS = 400;

export type SessionStatus = "connecting" | "live" | "speaking" | "closed";

export interface InterviewSessionOptions {
  apiKey: string;
  persona: Persona;
  onTranscript: (entries: TranscriptEntry[]) => void;
  onStatus: (status: SessionStatus) => void;
  /**
   * Fires the instant mic energy crosses the voice gate, long before Gemini
   * returns any text. The interview screen uses it to show that the student
   * is being heard while their transcription is still pending.
   */
  onStudentSpeaking: (speaking: boolean) => void;
  onFatalError: (message: string) => void;
}

export class InterviewSession {
  private opts: InterviewSessionOptions;
  private session: Session | null = null;
  private mediaStream: MediaStream | null = null;
  private audioCtx: AudioContext | null = null;
  private processor: ScriptProcessorNode | null = null;
  private player = new PcmAudioPlayer(24000);

  private muted = false;
  private stopped = false;
  private receivedAnyMessage = false;

  private t0 = 0;
  private startedAt = 0;
  private intervieweeAudioMs = 0;

  // Voiced-audio accounting. Each side's speech is measured as it happens and
  // banked here; when a transcript entry for that side appears, everything
  // banked since the last hand-off is attributed to it. This works even
  // though text and audio arrive out of step with each other.
  private studentVoicedMs = 0;
  private studentVoicedMsAssigned = 0;
  private intervieweeAudioMsAssigned = 0;
  private lastVoiceMs = -Infinity;
  private studentSpeaking = false;

  private entries: TranscriptEntry[] = [];
  private openEntry: { student: TranscriptEntry | null; interviewee: TranscriptEntry | null } = {
    student: null,
    interviewee: null,
  };

  constructor(opts: InterviewSessionOptions) {
    this.opts = opts;
  }

  async start(): Promise<void> {
    this.opts.onStatus("connecting");

    // 1. Microphone first — fail fast before any network work.
    try {
      this.mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      throw new Error(
        "Microphone access is required for a voice interview. Please allow microphone access and try again."
      );
    }

    // 2 + 3. Connect to Gemini Live directly from the browser.
    const ai = new GoogleGenAI({ apiKey: this.opts.apiKey });
    try {
      this.session = await ai.live.connect({
        model: LIVE_MODEL,
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: this.opts.persona.voiceName } },
          },
          systemInstruction: this.opts.persona.systemInstruction,
          inputAudioTranscription: {},
          outputAudioTranscription: {},
        },
        callbacks: {
          onmessage: (msg: LiveServerMessage) => this.handleMessage(msg),
          onerror: () => this.handleClose(),
          onclose: () => this.handleClose(),
        },
      });
    } catch {
      this.cleanupMedia();
      throw new Error("Could not connect to Gemini — please check your API key.");
    }

    if (this.stopped) return; // stopped while connecting

    // 4. Mic capture chain: 16kHz PCM in ~128ms chunks for low latency.
    this.t0 = performance.now();
    this.startedAt = Date.now();
    const AudioCtxClass = window.AudioContext || (window as any).webkitAudioContext;
    this.audioCtx = new AudioCtxClass({ sampleRate: 16000 });
    const source = this.audioCtx!.createMediaStreamSource(this.mediaStream!);
    this.processor = this.audioCtx!.createScriptProcessor(2048, 1, 1);
    this.processor.onaudioprocess = (e) => {
      if (this.stopped || this.muted || !this.session) return;
      const chunk = e.inputBuffer.getChannelData(0);
      this.measureStudentVoice(chunk, (chunk.length / 16000) * 1000);
      try {
        this.session.sendRealtimeInput({
          audio: { data: pcmFloat32ToBase64(chunk), mimeType: "audio/pcm;rate=16000" },
        });
      } catch {
        // Session already closed; handleClose deals with the rest.
      }
    };
    source.connect(this.processor);
    this.processor.connect(this.audioCtx!.destination);

    this.opts.onStatus("live");
  }

  setMuted(muted: boolean) {
    this.muted = muted;
    if (muted) this.setStudentSpeaking(false);
  }

  // Called for every mic buffer (~128 ms). Counts the buffer as speech if it
  // is above the energy gate, or within the hangover window after speech.
  private measureStudentVoice(chunk: Float32Array, bufferMs: number) {
    const now = performance.now() - this.t0;
    if (rms(chunk) >= VOICE_RMS_THRESHOLD) {
      this.lastVoiceMs = now;
      this.studentVoicedMs += bufferMs;
      this.setStudentSpeaking(true);
    } else if (now - this.lastVoiceMs < VOICE_HANGOVER_MS) {
      this.studentVoicedMs += bufferMs;
    } else {
      this.setStudentSpeaking(false);
    }
  }

  private setStudentSpeaking(speaking: boolean) {
    if (this.studentSpeaking === speaking) return;
    this.studentSpeaking = speaking;
    this.opts.onStudentSpeaking(speaking);
  }

  /** Voiced ms banked for `speaker` since the last time it was handed off. */
  private takeSpeechMs(speaker: Speaker): number {
    if (speaker === "student") {
      const ms = this.studentVoicedMs - this.studentVoicedMsAssigned;
      this.studentVoicedMsAssigned = this.studentVoicedMs;
      return Math.max(0, ms);
    }
    const ms = this.intervieweeAudioMs - this.intervieweeAudioMsAssigned;
    this.intervieweeAudioMsAssigned = this.intervieweeAudioMs;
    return Math.max(0, ms);
  }

  stop(): SessionResult {
    const wasStopped = this.stopped;
    this.stopped = true;
    this.cleanupMedia();
    this.player.stop();
    if (this.session) {
      try {
        this.session.close();
      } catch {
        // ignore
      }
      this.session = null;
    }
    if (!wasStopped) this.opts.onStatus("closed");
    this.closeOpenEntries();
    return {
      transcript: [...this.entries],
      startedAt: this.startedAt || Date.now(),
      endedAt: Date.now(),
      intervieweeAudioMs: Math.round(this.intervieweeAudioMs),
      studentSpeechMs: Math.round(this.studentVoicedMs),
    };
  }

  get transcript(): TranscriptEntry[] {
    return [...this.entries];
  }

  private handleMessage(msg: LiveServerMessage) {
    if (this.stopped) return;
    this.receivedAnyMessage = true;
    const content = msg.serverContent;
    if (!content) return;

    const parts = content.modelTurn?.parts ?? [];
    for (const part of parts) {
      const data = part.inlineData?.data;
      if (data) {
        this.player.playChunk(data);
        this.intervieweeAudioMs += base64PcmDurationMs(data, 24000);
        this.opts.onStatus("speaking");
      }
    }

    if (content.inputTranscription?.text) {
      this.appendChunk("student", content.inputTranscription.text);
    }
    if (content.outputTranscription?.text) {
      this.appendChunk("interviewee", content.outputTranscription.text);
    }

    if (content.interrupted) {
      // Student spoke over the interviewee: cut playback immediately.
      this.player.stop();
      this.openEntry.interviewee = null;
      this.opts.onStatus("live");
    }
    if (content.turnComplete) {
      this.openEntry.interviewee = null;
      this.opts.onStatus("live");
    }
  }

  private appendChunk(speaker: Speaker, text: string) {
    const now = performance.now() - this.t0;
    const speechMs = this.takeSpeechMs(speaker);
    const open = this.openEntry[speaker];
    if (open && now - open.tEnd < TURN_GAP_MS) {
      open.text = (open.text + text).trimStart();
      open.tEnd = now;
      open.speechMs += speechMs;
    } else {
      // The student's text arrives only once they have stopped talking, so
      // date the turn back to when they actually started speaking rather
      // than to the moment the transcription landed.
      const tStart = speaker === "student" ? Math.max(0, now - speechMs) : now;
      const entry: TranscriptEntry = {
        speaker,
        text: text.trimStart(),
        tStart,
        tEnd: now,
        speechMs,
      };
      this.entries.push(entry);
      this.openEntry[speaker] = entry;
    }
    this.opts.onTranscript([...this.entries]);
  }

  private closeOpenEntries() {
    this.openEntry.student = null;
    this.openEntry.interviewee = null;
    // Drop empty entries (can occur from whitespace-only transcription chunks).
    this.entries = this.entries.filter((e) => e.text.trim().length > 0);
  }

  private handleClose() {
    if (this.stopped) return;
    this.stopped = true;
    this.cleanupMedia();
    this.player.stop();
    this.session = null;
    this.opts.onStatus("closed");
    if (!this.receivedAnyMessage) {
      this.opts.onFatalError("Could not connect to Gemini — please check your API key.");
    } else {
      this.opts.onFatalError("The connection to Gemini was lost.");
    }
  }

  private cleanupMedia() {
    this.setStudentSpeaking(false);
    if (this.processor) {
      try {
        this.processor.disconnect();
      } catch {
        // ignore
      }
      this.processor.onaudioprocess = null;
      this.processor = null;
    }
    if (this.audioCtx) {
      try {
        this.audioCtx.close();
      } catch {
        // ignore
      }
      this.audioCtx = null;
    }
    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((t) => t.stop());
      this.mediaStream = null;
    }
  }
}
