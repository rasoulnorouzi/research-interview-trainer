// Every call this service makes to OpenAI: minting a realtime client secret,
// running one evaluator, speaking a voice preview, and validating a key on
// save.
//
// This module has ZERO Cloudflare imports and imports nothing else from
// worker/. Plain `fetch` and plain types only, deliberately, so it lifts to
// Python almost mechanically if the app ever moves to a university VM
// (BACKEND-PLAN.md section 9). The caller reads the key out of settings and
// passes it in; this module never reads configuration itself.
//
// KEY HYGIENE (BACKEND-PLAN.md section 7, non-negotiable). The university key
// is shared by 400 students and it lives in a database row rather than a
// secrets store, so the one protection it has is that it never appears
// anywhere but in an Authorization header. Therefore:
//
//   - Every error thrown from here is one of the four fixed strings below.
//   - No response body, no request body, no header, and no URL is ever put
//     into a thrown message, a return value, or a log line.
//   - Nothing here calls console.* at all.
//
// The 401 path is the classic leak: OpenAI's own error body quotes the key
// prefix back at you, and a handler that forwards "the detail, for debugging"
// puts it in a log aggregator. That is why the status is mapped to a constant
// and the body is never read.

const CLIENT_SECRETS_URL = "https://api.openai.com/v1/realtime/client_secrets";
const RESPONSES_URL = "https://api.openai.com/v1/responses";
const MODELS_URL = "https://api.openai.com/v1/models";
const SPEECH_URL = "https://api.openai.com/v1/audio/speech";

// The model behind the dashboard's per-voice preview button. Verified against
// the live API (2026-08-31): it accepts all ten REALTIME_VOICES, including
// marin and cedar, and answers audio/mpeg. Only the preview uses TTS; the
// interviews themselves speak through the realtime session.
const VOICE_PREVIEW_MODEL = "gpt-4o-mini-tts";

// The complete set of messages this module can throw. Nothing is interpolated
// into them, ever.
const ERR_KEY = "OpenAI rejected the API key.";
const ERR_MODEL = "OpenAI model not found.";
const ERR_RATE = "OpenAI rate limit hit.";
const ERR_GENERIC = "OpenAI request failed.";

// The input-transcription model is a caller argument since 2026-08-31: an
// instructor setting, chosen from shared/models.ts TRANSCRIPTION_MODEL_OPTIONS
// and enforced against that list by worker/admin.ts. Every model on that list
// streams the student's transcript while they are still speaking; models that
// only transcribe after a committed turn (gpt-transcribe, gpt-4o-transcribe,
// gpt-4o-mini-transcribe, whisper-1 — all tested 2026-08-31) are the exact
// Gemini limitation this migration exists to remove, and must never be added.

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

/** Maps an HTTP status to a fixed string. The response body is never read. */
function statusError(status: number): Error {
  if (status === 401 || status === 403) return new Error(ERR_KEY);
  if (status === 404) return new Error(ERR_MODEL);
  if (status === 429) return new Error(ERR_RATE);
  return new Error(ERR_GENERIC);
}

export interface MintedToken {
  /** The `ek_…` client secret the browser opens the WebRTC session with. */
  token: string;
  /** Unix seconds, as returned by OpenAI. */
  expiresAt: number;
}

/**
 * Mints a realtime client secret for one interview (BACKEND-PLAN.md section 5).
 *
 * `instructions` is set here rather than over the client's data channel:
 * OPENAI-MIGRATION.md section 7(a) verified that the mint accepts it, which is
 * what keeps the persona text (and therefore Layer 3) out of the browser.
 *
 * `expires_after` is the only server-side bound on an interview that exists.
 * Section 7(b) found no `max_session_duration`, so this caps when a token may
 * *start* a session, not how long one runs; the countdown and the daily quota
 * carry the rest. Verified accepted with the `created_at` anchor.
 */
export async function mintRealtimeToken(
  apiKey: string,
  args: {
    model: string;
    voice: string;
    instructions: string;
    transcriptionModel: string;
    tokenTtlSeconds: number;
  },
): Promise<MintedToken> {
  let res: Response;
  try {
    res = await fetch(CLIENT_SECRETS_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        expires_after: { anchor: "created_at", seconds: args.tokenTtlSeconds },
        session: {
          type: "realtime",
          model: args.model,
          instructions: args.instructions,
          audio: {
            input: {
              transcription: { model: args.transcriptionModel },
              turn_detection: TURN_DETECTION,
            },
            output: { voice: args.voice },
          },
        },
      }),
    });
  } catch {
    throw new Error(ERR_GENERIC);
  }
  if (!res.ok) throw statusError(res.status);

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new Error(ERR_GENERIC);
  }
  const payload = body as { value?: unknown; expires_at?: unknown };
  if (typeof payload?.value !== "string" || payload.value.length === 0) {
    throw new Error(ERR_GENERIC);
  }
  return {
    token: payload.value,
    expiresAt:
      typeof payload.expires_at === "number"
        ? payload.expires_at
        : Math.floor(Date.now() / 1000) + args.tokenTtlSeconds,
  };
}

export interface ResponsesRequest {
  model: string;
  input: string;
  text: { format: { type: "json_schema"; name: string; strict: true; schema: unknown } };
}

/**
 * One evaluator call. `strict: true` bounds the output shape, so even a fully
 * successful prompt injection in the transcript cannot change what comes back
 * (PROMPTING.md section B, defence 4).
 *
 * Returns the parsed JSON. A parse failure is ERR_GENERIC like any other
 * failure: the malformed text is model output derived from a student-authored
 * transcript, and it is not going into a log line either.
 */
export async function callResponses(apiKey: string, body: ResponsesRequest): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(RESPONSES_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error(ERR_GENERIC);
  }
  if (!res.ok) throw statusError(res.status);

  let payload: unknown;
  try {
    payload = await res.json();
  } catch {
    throw new Error(ERR_GENERIC);
  }
  const text = extractOutputText(payload);
  if (!text) throw new Error(ERR_GENERIC);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(ERR_GENERIC);
  }
}

/** Pull the single output_text out of a Responses API payload. */
function extractOutputText(payload: unknown): string {
  const output = (payload as { output?: unknown })?.output;
  for (const item of Array.isArray(output) ? output : []) {
    const content = (item as { content?: unknown })?.content;
    for (const part of Array.isArray(content) ? content : []) {
      const p = part as { type?: unknown; text?: unknown };
      if (p?.type === "output_text" && typeof p.text === "string") return p.text;
    }
  }
  return "";
}

/**
 * One short spoken sample of a realtime voice, for the persona editor's
 * preview button. Returns the MP3 bytes; the caller streams them to the
 * dashboard unchanged. The same key hygiene as every other call here: on any
 * failure one of the four fixed strings, and the response body is never read.
 */
export async function synthesizeVoicePreview(
  apiKey: string,
  voice: string,
  text: string,
): Promise<ArrayBuffer> {
  let res: Response;
  try {
    res = await fetch(SPEECH_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: VOICE_PREVIEW_MODEL, voice, input: text }),
    });
  } catch {
    throw new Error(ERR_GENERIC);
  }
  if (!res.ok) throw statusError(res.status);
  try {
    return await res.arrayBuffer();
  } catch {
    throw new Error(ERR_GENERIC);
  }
}

/**
 * Cheap authenticated call used when the instructor saves a key
 * (BACKEND-PLAN.md section 7: "refuse to store a key that does not work").
 * Returns a boolean rather than throwing, so no caller is tempted to surface
 * a reason that came from OpenAI.
 */
export async function validateApiKey(apiKey: string): Promise<boolean> {
  try {
    const res = await fetch(MODELS_URL, { headers: { Authorization: `Bearer ${apiKey}` } });
    return res.ok;
  } catch {
    return false;
  }
}
