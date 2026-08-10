import { Persona, SessionResult, Speaker, TranscriptEntry } from "../types";
import { SpeechMeter, createSpeechMeter } from "./audio";

const REALTIME_BASE = "https://api.openai.com/v1/realtime";
// Streams the student's transcript while they are still speaking. The other
// option, "gpt-transcribe", only transcribes after a committed turn — which is
// the exact Gemini limitation this migration exists to remove. Do not swap it.
const INPUT_TRANSCRIPTION_MODEL = "gpt-live-transcribe";

// The realtime default (1.0) is noticeably brisk for these personas — all
// three are meant to be unhurried, and a rushed interviewee also invites the
// student to rush, which is the opposite of what the exercise teaches.
// Accepted range is 0.25–1.5. Prompt-level pacing (rule 19 in personas.ts)
// handles matching the interviewer's rhythm; this just sets the baseline.
const OUTPUT_SPEED = 0.9;

export type SessionStatus = "connecting" | "live" | "speaking" | "closed";

export interface InterviewSessionOptions {
  apiKey: string;
  persona: Persona;
  /** Realtime model id chosen on the setup screen. */
  model: string;
  onTranscript: (entries: TranscriptEntry[]) => void;
  onStatus: (status: SessionStatus) => void;
  onStudentSpeaking: (speaking: boolean) => void;
  onFatalError: (message: string) => void;
}

/** Events the app acts on. Names verified against a live session, not guessed. */
interface RealtimeEvent {
  type: string;
  item_id?: string;
  delta?: string;
  transcript?: string;
  error?: { message?: string };
}

export class InterviewSession {
  private opts: InterviewSessionOptions;
  private pc: RTCPeerConnection | null = null;
  private dc: RTCDataChannel | null = null;
  private micStream: MediaStream | null = null;
  private audioEl: HTMLAudioElement | null = null;
  private micMeter: SpeechMeter | null = null;
  private remoteMeter: SpeechMeter | null = null;

  private muted = false;
  private stopped = false;
  private connected = false;

  private t0 = 0;
  private startedAt = 0;

  // Turns are keyed by the server's item id, so no time-gap guessing is needed
  // to decide where one turn ends and the next begins.
  private entries: TranscriptEntry[] = [];
  private byItem = new Map<string, TranscriptEntry>();
  private meterBase = new Map<string, number>();

  constructor(opts: InterviewSessionOptions) {
    this.opts = opts;
  }

  async start(): Promise<void> {
    this.opts.onStatus("connecting");

    // 1. Microphone first, so a denial fails fast without spending an API call.
    try {
      this.micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      throw new Error(
        "Microphone access is required for a voice interview. Please allow microphone access and try again."
      );
    }

    // 2. Mint an ephemeral token with the student's own key. The key stays in
    //    this browser; only the short-lived token is used for the call.
    const ephemeral = await this.createEphemeralToken();
    if (this.stopped) return;

    // 3. WebRTC handles capture, playback, jitter and barge-in natively.
    const pc = new RTCPeerConnection();
    this.pc = pc;

    this.audioEl = document.createElement("audio");
    this.audioEl.autoplay = true;
    pc.ontrack = (event) => {
      const [remote] = event.streams;
      if (!remote || !this.audioEl) return;
      this.audioEl.srcObject = remote;
      // The meter needs the element attached or Chrome delivers no samples.
      this.remoteMeter = createSpeechMeter(remote, (speaking) => {
        if (!this.stopped) this.opts.onStatus(speaking ? "speaking" : "live");
      });
    };

    for (const track of this.micStream.getAudioTracks()) {
      pc.addTrack(track, this.micStream);
    }
    this.micMeter = createSpeechMeter(this.micStream, (speaking) => {
      if (!this.stopped && !this.muted) this.opts.onStudentSpeaking(speaking);
    });

    this.dc = pc.createDataChannel("oai-events");
    this.dc.onmessage = (e) => this.handleEvent(JSON.parse(e.data) as RealtimeEvent);
    this.dc.onopen = () => this.configureSession();

    pc.onconnectionstatechange = () => {
      if (this.stopped) return;
      if (pc.connectionState === "failed" || pc.connectionState === "disconnected") {
        this.handleDrop();
      }
    };

    this.t0 = performance.now();
    this.startedAt = Date.now();

    await this.negotiate(pc, ephemeral);
    if (this.stopped) return;

    this.connected = true;
    this.opts.onStatus("live");
  }

  private async createEphemeralToken(): Promise<string> {
    let res: Response;
    try {
      res = await fetch(`${REALTIME_BASE}/client_secrets`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.opts.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          session: {
            type: "realtime",
            model: this.opts.model,
            audio: {
              input: { transcription: { model: INPUT_TRANSCRIPTION_MODEL } },
              output: { voice: this.opts.persona.voiceName, speed: OUTPUT_SPEED },
            },
          },
        }),
      });
    } catch {
      this.cleanup();
      throw new Error("Could not reach OpenAI. Check your network connection.");
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      this.cleanup();
      throw new Error(describeConnectError(res.status, detail, this.opts.model));
    }
    const body = await res.json();
    const token = body?.value;
    if (typeof token !== "string") {
      this.cleanup();
      throw new Error("OpenAI did not return a session token.");
    }
    return token;
  }

  private async negotiate(pc: RTCPeerConnection, ephemeral: string): Promise<void> {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    const res = await fetch(`${REALTIME_BASE}/calls`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ephemeral}`, "Content-Type": "application/sdp" },
      body: offer.sdp ?? "",
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      this.cleanup();
      throw new Error(`Could not open the voice session. ${detail.slice(0, 200)}`);
    }
    await pc.setRemoteDescription({ type: "answer", sdp: await res.text() });
  }

  /** Persona instructions go over the data channel once it is open. */
  private configureSession() {
    this.send({
      type: "session.update",
      session: {
        type: "realtime",
        instructions: this.opts.persona.systemInstruction,
        audio: {
          input: { transcription: { model: INPUT_TRANSCRIPTION_MODEL } },
          output: { voice: this.opts.persona.voiceName, speed: OUTPUT_SPEED },
        },
      },
    });
  }

  private send(payload: unknown) {
    if (this.dc?.readyState === "open") this.dc.send(JSON.stringify(payload));
  }

  setMuted(muted: boolean) {
    this.muted = muted;
    for (const track of this.micStream?.getAudioTracks() ?? []) {
      track.enabled = !muted;
    }
    if (muted) this.opts.onStudentSpeaking(false);
  }

  stop(): SessionResult {
    const wasStopped = this.stopped;
    const studentSpeechMs = Math.round(this.micMeter?.speechMs ?? 0);
    const intervieweeAudioMs = Math.round(this.remoteMeter?.speechMs ?? 0);
    this.stopped = true;
    this.cleanup();
    if (!wasStopped) this.opts.onStatus("closed");
    this.entries = this.entries.filter((e) => e.text.trim().length > 0);
    return {
      transcript: [...this.entries],
      startedAt: this.startedAt || Date.now(),
      endedAt: Date.now(),
      intervieweeAudioMs,
      studentSpeechMs,
    };
  }

  get transcript(): TranscriptEntry[] {
    return [...this.entries];
  }

  private handleEvent(event: RealtimeEvent) {
    if (this.stopped) return;
    switch (event.type) {
      // The student, streaming while they are still talking.
      case "conversation.item.input_audio_transcription.delta":
        this.appendDelta("student", event.item_id, event.delta ?? "");
        break;
      case "conversation.item.input_audio_transcription.completed":
        this.finalize("student", event.item_id, event.transcript ?? "");
        break;

      // The interviewee, streaming alongside their audio.
      case "response.output_audio_transcript.delta":
        this.appendDelta("interviewee", event.item_id, event.delta ?? "");
        break;
      case "response.output_audio_transcript.done":
        this.finalize("interviewee", event.item_id, event.transcript ?? "");
        break;

      case "error":
        // Session-level errors are reported but are not always fatal; a failed
        // turn should not throw away a good transcript.
        console.error("Realtime error:", event.error?.message ?? event);
        break;
    }
  }

  private entryFor(speaker: Speaker, itemId: string | undefined): TranscriptEntry {
    const key = itemId ?? `${speaker}-pending`;
    const existing = this.byItem.get(key);
    if (existing) return existing;
    const entry: TranscriptEntry = {
      speaker,
      text: "",
      tStart: performance.now() - this.t0,
      tEnd: performance.now() - this.t0,
      speechMs: 0,
    };
    this.byItem.set(key, entry);
    this.meterBase.set(key, this.meterFor(speaker)?.speechMs ?? 0);
    this.entries.push(entry);
    return entry;
  }

  private meterFor(speaker: Speaker): SpeechMeter | null {
    return speaker === "student" ? this.micMeter : this.remoteMeter;
  }

  /** Voiced time for a turn is the meter's advance since that turn opened. */
  private updateSpeechMs(speaker: Speaker, itemId: string | undefined, entry: TranscriptEntry) {
    const key = itemId ?? `${speaker}-pending`;
    const base = this.meterBase.get(key) ?? 0;
    entry.speechMs = Math.max(0, (this.meterFor(speaker)?.speechMs ?? 0) - base);
  }

  private appendDelta(speaker: Speaker, itemId: string | undefined, delta: string) {
    if (!delta) return;
    const entry = this.entryFor(speaker, itemId);
    entry.text = (entry.text + delta).trimStart();
    entry.tEnd = performance.now() - this.t0;
    this.updateSpeechMs(speaker, itemId, entry);
    this.opts.onTranscript([...this.entries]);
  }

  private finalize(speaker: Speaker, itemId: string | undefined, transcript: string) {
    const entry = this.entryFor(speaker, itemId);
    // The final transcript supersedes the accumulated deltas — it is the
    // corrected version, not an additional fragment.
    if (transcript.trim()) entry.text = transcript.trim();
    entry.tEnd = performance.now() - this.t0;
    this.updateSpeechMs(speaker, itemId, entry);
    this.opts.onTranscript([...this.entries]);
  }

  private handleDrop() {
    if (this.stopped) return;
    this.stopped = true;
    this.cleanup();
    this.opts.onStatus("closed");
    this.opts.onFatalError(
      this.connected
        ? "The connection to OpenAI was lost."
        : "Could not establish the voice session."
    );
  }

  private cleanup() {
    this.micMeter?.stop();
    this.remoteMeter?.stop();
    this.opts.onStudentSpeaking(false);
    try {
      this.dc?.close();
    } catch {
      // ignore
    }
    this.dc = null;
    try {
      this.pc?.close();
    } catch {
      // ignore
    }
    this.pc = null;
    if (this.audioEl) {
      this.audioEl.srcObject = null;
      this.audioEl = null;
    }
    for (const track of this.micStream?.getTracks() ?? []) track.stop();
    this.micStream = null;
  }
}

function describeConnectError(status: number, detail: string, model: string): string {
  if (status === 401 || status === 403) {
    return "Your OpenAI API key was rejected. Check that you pasted it correctly and that it has API access.";
  }
  if (status === 404) {
    return `The interview model "${model}" is not available to this API key.`;
  }
  if (status === 429) {
    return "OpenAI rate-limited the request, or the account has no available quota. Check your billing and try again.";
  }
  return `Could not start the interview (HTTP ${status}). ${detail.slice(0, 200)}`;
}
