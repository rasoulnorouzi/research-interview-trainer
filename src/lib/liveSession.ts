import { SessionResponse, SessionResult, Speaker, TranscriptEntry } from "../types";
import { api, ApiError } from "../api";
import { SpeechMeter, createSpeechMeter } from "./audio";

const REALTIME_BASE = "https://api.openai.com/v1/realtime";
// Streams the student's transcript while they are still speaking. The other
// option, "gpt-transcribe", only transcribes after a committed turn — which is
// the exact Gemini limitation this migration exists to remove. Do not swap it.
// The transcript is no longer shown during the interview (instructor decision,
// 2026-09-11), only in the report, but the streaming transcriber stays.
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

/**
 * Characters of interviewee text per second of spoken audio. Used to cut an
 * interrupted answer to what was heard, until this session has timed a fully
 * played answer of its own. Measured on Tom, the slowest built-in pacing, at
 * about 14 (2026-09-11).
 */
const DEFAULT_CHARS_PER_SECOND = 14;

export type SessionStatus = "connecting" | "live" | "speaking" | "closed";

export interface InterviewSessionOptions {
  /** Which interviewee to open. The persona text, the voice and the model all
   *  stay server-side; the browser never sees them. */
  personaId: string;
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
  response_id?: string;
  output_index?: number;
  audio_end_ms?: number;
  delta?: string;
  transcript?: string;
  error?: { message?: string };
}

/** One interviewee answer's audio, from output_audio_buffer.started on. */
interface Playback {
  startedAt: number; // performance.now()
  meterBase: number; // the remote meter's reading at that moment
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

  // The interviewee's text arrives within a few seconds, far ahead of the
  // audio that speaks it (verified 2026-09-11: 85 words of text in 2.6 s,
  // then 6 more seconds of speech before the student cut in). These follow
  // each answer's audio so the transcript keeps only what was heard.
  private itemInfo = new Map<string, { responseId: string; index: number }>();
  private playing = new Map<string, Playback>();
  private voiced = new Map<string, number>();
  private timedChars = 0;
  private timedMs = 0;

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
    // Ending the interview mid-answer cuts that answer off too.
    if (!wasStopped) this.cutOpenPlayback();
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
    return this.entries.filter((e) => e.text.trim().length > 0);
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

      // The interviewee's text. It runs ahead of the audio, see cutToHeard.
      case "response.output_audio_transcript.delta":
        this.noteItem(event);
        this.appendDelta("interviewee", event.item_id, event.delta ?? "");
        break;
      case "response.output_audio_transcript.done":
        this.noteItem(event);
        this.finalize("interviewee", event.item_id, event.transcript ?? "");
        break;

      // The interviewee's audio. Over WebRTC the server sends it in real time,
      // so these mark when an answer really started and stopped playing:
      // stopped when it played to the end, cleared when it was cut off.
      case "output_audio_buffer.started":
        if (event.response_id) {
          this.playing.set(event.response_id, {
            startedAt: performance.now(),
            meterBase: this.remoteMeter?.speechMs ?? 0,
          });
        }
        break;
      case "output_audio_buffer.stopped":
        if (event.response_id) this.endPlayback(event.response_id, true);
        break;
      case "output_audio_buffer.cleared":
        if (event.response_id) this.endPlayback(event.response_id, false);
        break;

      // Sent by the server when the student cuts in. The server has already
      // cut its own memory of the answer to the audio that played, so the
      // model does not remember saying the rest. audio_end_ms is how much of
      // this item was heard.
      case "conversation.item.truncated":
        if (event.item_id && typeof event.audio_end_ms === "number") {
          this.cutToHeard(event.item_id, event.audio_end_ms);
        }
        break;

      case "error":
        // Session-level errors are reported but are not always fatal; a failed
        // turn should not throw away a good transcript.
        console.error("Realtime error:", event.error?.message ?? event);
        break;
    }
  }

  private noteItem(event: RealtimeEvent) {
    if (!event.item_id || !event.response_id || this.itemInfo.has(event.item_id)) return;
    this.itemInfo.set(event.item_id, { responseId: event.response_id, index: event.output_index ?? 0 });
  }

  /** The interviewee entries of one answer, in the order they are spoken. */
  private itemsOf(responseId: string): TranscriptEntry[] {
    return [...this.itemInfo.entries()]
      .filter(([, info]) => info.responseId === responseId)
      .sort((a, b) => a[1].index - b[1].index)
      .map(([id]) => this.byItem.get(id))
      .filter((e): e is TranscriptEntry => e !== undefined);
  }

  private charsPerMs(): number {
    return this.timedMs > 0 ? this.timedChars / this.timedMs : DEFAULT_CHARS_PER_SECOND / 1000;
  }

  private endPlayback(responseId: string, playedToEnd: boolean) {
    const playback = this.playing.get(responseId);
    if (!playback) return;
    this.playing.delete(responseId);
    const now = performance.now();
    const items = this.itemsOf(responseId);
    // An answer that played to the end times this voice's pace.
    if (playedToEnd) {
      const chars = items.reduce((n, e) => n + e.text.length, 0);
      const ms = now - playback.startedAt;
      if (chars > 0 && ms > 1000) {
        this.timedChars += chars;
        this.timedMs += ms;
      }
    }
    this.voiced.set(responseId, Math.max(0, (this.remoteMeter?.speechMs ?? 0) - playback.meterBase));
    const last = items[items.length - 1];
    if (last) last.tEnd = now - this.t0;
    this.shareVoicedTime(responseId);
  }

  /**
   * Per-turn speaking time for the interviewee: the answer's voiced audio,
   * shared between its items by their length. It cannot be read while the
   * text arrives, because the text is finished long before the audio is.
   */
  private shareVoicedTime(responseId: string) {
    const voiced = this.voiced.get(responseId);
    if (voiced === undefined) return;
    const items = this.itemsOf(responseId);
    const chars = items.reduce((n, e) => n + e.text.length, 0);
    for (const e of items) e.speechMs = chars > 0 ? Math.round((voiced * e.text.length) / chars) : 0;
  }

  /**
   * The student cut in: keep what was heard of this item, estimated from
   * audio_end_ms and the voice's pace, and drop any later item of the same
   * answer, which never played.
   */
  private cutToHeard(itemId: string, heardMs: number) {
    const entry = this.byItem.get(itemId);
    const info = this.itemInfo.get(itemId);
    if (!entry || !info || entry.speaker !== "interviewee") return;
    const cut = cutText(entry.text, heardMs * this.charsPerMs());
    if (cut !== null) {
      entry.text = cut;
      entry.interrupted = true;
    }
    for (const other of this.itemsOf(info.responseId)) {
      if (this.indexOf(other) > info.index) other.text = "";
    }
    // The server keeps only the heard audio of the cut item and deletes its
    // text, so the model loses track of what it already said and tends to
    // start its answer again, introduction included (3 of 4 test runs,
    // 2026-09-11). Telling it in text what the student heard stopped that
    // (0 of 8 runs); a persona rule alone did not (2 of 6). See PROMPTING.md.
    const heard = entry.text.trim();
    this.send({
      type: "conversation.item.create",
      previous_item_id: itemId,
      item: {
        type: "message",
        role: "system",
        content: [
          {
            type: "input_text",
            text: heard
              ? `The interviewer cut in while you were speaking. They heard only this part of your answer: "${heard}". Do not repeat any of it. Respond only to what they say next.`
              : "The interviewer cut in before you had said anything. Respond only to what they say next.",
          },
        ],
      },
    });
    // The cut also ends the answer's playback, whether or not the cleared
    // event has arrived yet.
    this.endPlayback(info.responseId, false);
    this.shareVoicedTime(info.responseId);
  }

  private indexOf(entry: TranscriptEntry): number {
    for (const [id, info] of this.itemInfo) if (this.byItem.get(id) === entry) return info.index;
    return -1;
  }

  /**
   * Ending the interview, or losing the connection, cuts off an answer that is
   * still playing. Walk its items with the voice's pace to find where the
   * audio had got to, and cut there.
   */
  private cutOpenPlayback() {
    const now = performance.now();
    const rate = this.charsPerMs();
    for (const [responseId, playback] of [...this.playing]) {
      let heardChars = (now - playback.startedAt) * rate;
      for (const e of this.itemsOf(responseId)) {
        if (heardChars >= e.text.length) {
          heardChars -= e.text.length;
          continue;
        }
        const cut = cutText(e.text, heardChars);
        if (cut !== null) {
          e.text = cut;
          e.interrupted = cut.length > 0;
        }
        heardChars = 0;
      }
      this.endPlayback(responseId, false);
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
    this.meterBase.set(key, this.micMeter?.speechMs ?? 0);
    this.entries.push(entry);
    return entry;
  }

  /** The student's voiced time for a turn is the mic meter's advance since that turn opened. */
  private updateStudentSpeechMs(itemId: string | undefined, entry: TranscriptEntry) {
    const key = itemId ?? "student-pending";
    const base = this.meterBase.get(key) ?? 0;
    entry.speechMs = Math.max(0, (this.micMeter?.speechMs ?? 0) - base);
  }

  private appendDelta(speaker: Speaker, itemId: string | undefined, delta: string) {
    if (!delta) return;
    const entry = this.entryFor(speaker, itemId);
    entry.text = (entry.text + delta).trimStart();
    if (speaker === "student") {
      entry.tEnd = performance.now() - this.t0;
      this.updateStudentSpeechMs(itemId, entry);
    }
  }

  private finalize(speaker: Speaker, itemId: string | undefined, transcript: string) {
    const entry = this.entryFor(speaker, itemId);
    // The final transcript supersedes the accumulated deltas — it is the
    // corrected version, not an additional fragment.
    if (transcript.trim()) entry.text = transcript.trim();
    if (speaker === "student") {
      entry.tEnd = performance.now() - this.t0;
      this.updateStudentSpeechMs(itemId, entry);
    }
  }

  private handleDrop() {
    if (this.stopped) return;
    this.cutOpenPlayback();
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
 * The part of an answer that was heard: `keep` characters, carried on to the
 * end of the word being spoken, then an ellipsis. Null when the estimate
 * covers the whole text, because the student cut in at the very end. An empty
 * string when nothing of it was heard.
 */
function cutText(text: string, keep: number): string | null {
  if (keep <= 0) return "";
  if (keep >= text.length) return null;
  const wordEnd = text.slice(Math.floor(keep)).search(/\s/);
  if (wordEnd === -1) return null;
  const heard = text.slice(0, Math.floor(keep) + wordEnd).replace(/[\s,;:.!?-]+$/, "");
  return heard.length > 0 ? `${heard}…` : "";
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
