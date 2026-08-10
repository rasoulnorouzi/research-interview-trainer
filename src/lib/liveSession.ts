import { GoogleGenAI, Modality, LiveServerMessage, Session } from "@google/genai";
import { Persona, SessionResult, TranscriptEntry } from "../types";
import { PcmAudioPlayer, base64PcmDurationMs, pcmFloat32ToBase64 } from "./audio";

const LIVE_MODEL = "gemini-3.1-flash-live-preview";
// Consecutive transcription chunks from the same speaker closer together
// than this are merged into one transcript entry (one "turn").
const TURN_GAP_MS = 2000;

export type SessionStatus = "connecting" | "live" | "speaking" | "closed";

export interface InterviewSessionOptions {
  apiKey: string;
  persona: Persona;
  onTranscript: (entries: TranscriptEntry[]) => void;
  onStatus: (status: SessionStatus) => void;
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

  private appendChunk(speaker: "student" | "interviewee", text: string) {
    const now = performance.now() - this.t0;
    const open = this.openEntry[speaker];
    if (open && now - open.tEnd < TURN_GAP_MS) {
      open.text = (open.text + text).trimStart();
      open.tEnd = now;
    } else {
      const entry: TranscriptEntry = { speaker, text: text.trimStart(), tStart: now, tEnd: now };
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
