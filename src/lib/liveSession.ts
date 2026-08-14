import { SessionResponse, SessionResult, Speaker, TranscriptEntry } from "../types";
import { api, ApiError } from "../api";
import { SpeechMeter, createSpeechMeter } from "./audio";

const REALTIME_BASE = "https://api.openai.com/v1/realtime";
// Streams the student's transcript while they are still speaking. The other
// option, "gpt-transcribe", only transcribes after a committed turn — which is
// the exact Gemini limitation this migration exists to remove. Do not swap it.
// The Worker sets this at mint time; the copy here is only for the fallback
// session.update below, and the two must not drift apart.
const INPUT_TRANSCRIPTION_MODEL = "gpt-live-transcribe";

// Playback speed is left at the API default (1.0). A 0.9 slowdown was tried
// and reverted: it read as artificially dragged rather than unhurried. Pacing
// is handled in the prompt instead (rules 19-21 in personas.ts), where the
// persona varies its own rhythm with the conversation rather than having every
// syllable stretched by a constant. Range is 0.25-1.5 if ever revisited.

/**
 * Semantic turn detection: a model decides when the student has finished a
 * thought, instead of a silence timer deciding they have stopped making noise.
 *
 * The default is `server_vad` with `silence_duration_ms: 500` — half a second
 * of quiet and the interviewee starts talking. That is disastrous here.
 * Students formulating a research question pause mid-sentence to choose words,
 * and being cut off teaches them to rush, which is exactly what the rubric
 * penalises. Worse, tolerating silence is itself an assessed skill: a student
 * who leaves space after a difficult disclosure scores well for it, and a
 * silence timer would punish them for it by talking over the gap.
 *
 * `eagerness: "low"` makes the model wait longest before deciding the turn is
 * over. Valid values: low, medium, high, auto.
 */
const TURN_DETECTION = { type: "semantic_vad", eagerness: "low" } as const;

export type SessionStatus = "connecting" | "live" | "speaking" | "closed";

export interface InterviewSessionOptions {
  /** Which interviewee to open. The persona text, the voice and the model all
   *  stay server-side; the browser never sees them. */
  personaId: string;
  onTranscript: (entries: TranscriptEntry[]) => void;
  onStatus: (status: SessionStatus) => void;
  onStudentSpeaking: (speaking: boolean) => void;
  onFatalError: (message: string) => void;
  /** The interview time limit, as configured by the instructor. Never hardcoded. */
  onLimits?: (limits: { limitMinutes: number; warnMinutes: number }) => void;
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
  /** Set only when the server could not apply the persona at mint time. */
  private fallbackInstructions: string | null = null;

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

    // 2. Ask our own backend to mint an ephemeral token with the university
    //    key. The browser never holds a key, only the short-lived ek_ token.
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
    // Normally the persona is applied at mint time and there is nothing to
    // configure from here. The data channel only carries a session.update on
    // the fallback path (see createEphemeralToken).
    if (this.fallbackInstructions) this.dc.onopen = () => this.configureSession();

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
    let session: SessionResponse;
    try {
      session = await api<SessionResponse>("/api/session", {
        method: "POST",
        body: JSON.stringify({ personaId: this.opts.personaId }),
      });
    } catch (err) {
      this.cleanup();
      const status = err instanceof ApiError ? err.status : 0;
      if (status === 401) throw new Error("Your login expired. Log in again.");
      // 429 is the daily session quota; the server's own message says how many
      // and when, so pass it through rather than paraphrasing it.
      throw new Error((err as Error).message);
    }
    if (typeof session.token !== "string" || session.token.length === 0) {
      this.cleanup();
      throw new Error("The server did not return a session token.");
    }
    // Present only if the persona could not be applied at mint time.
    this.fallbackInstructions = session.instructions ?? null;
    this.opts.onLimits?.({
      limitMinutes: session.limitMinutes,
      warnMinutes: session.warnMinutes,
    });
    return session.token;
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
      throw new Error(describeConnectError(res.status, detail));
    }
    await pc.setRemoteDescription({ type: "answer", sdp: await res.text() });
  }

  /**
   * Fallback only: applies the persona over the data channel when the server
   * could not set it at mint time. On the normal path there is nothing to send
   * and this never runs, so the persona text never reaches the browser.
   */
  private configureSession() {
    if (!this.fallbackInstructions) return;
    this.send({
      type: "session.update",
      session: {
        type: "realtime",
        instructions: this.fallbackInstructions,
        audio: {
          input: {
            transcription: { model: INPUT_TRANSCRIPTION_MODEL },
            turn_detection: TURN_DETECTION,
          },
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

/**
 * The OpenAI-side failures that remain now that minting has moved to our
 * server: this covers the direct WebRTC negotiation, which still goes to
 * OpenAI with the ephemeral token so the audio never relays through us.
 */
function describeConnectError(status: number, detail: string): string {
  if (status === 401 || status === 403) {
    return "The voice session token was rejected by OpenAI. Start the interview again.";
  }
  if (status === 429) {
    return "OpenAI rate-limited the request. Wait a moment and start the interview again.";
  }
  return `Could not open the voice session (HTTP ${status}). ${detail.slice(0, 200)}`;
}
