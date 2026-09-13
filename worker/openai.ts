// Every call this service makes to the AI gateway: minting a realtime client
// secret, running one evaluator, speaking a voice preview, and validating a
// key on save.
//
// Since 2026-09-11 the gateway is the university's Tilburg.AI service: LiteLLM
// in front of Azure OpenAI (Sweden Central). Before that the app called
// api.openai.com directly. The gateway speaks the OpenAI API shape, so this
// module changed only in where it sends requests, one retry for a stray
// gateway upstream (send, below), and one detail of the mint body (see
// mintRealtimeToken). The caller passes the base URL and the key together as a
// Gateway; this module never reads configuration itself.
//
// This module has ZERO Cloudflare imports and imports nothing else from
// worker/. Plain `fetch` and plain types only, deliberately, so it lifts to
// Python almost mechanically if the app ever moves to a university VM
// (BACKEND-PLAN.md section 9).
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
// The 401 path is the classic leak: the provider's own error body quotes the
// key prefix back at you, and a handler that forwards "the detail, for
// debugging" puts it in a log aggregator. That is why the status is mapped to
// a constant and the body is never read.

/**
 * Where requests go and with which key. The caller builds it per request from
 * the AI_BASE_URL var (wrangler.jsonc; ends in /v1, no trailing slash) and the
 * `openai_api_key` settings row.
 */
export interface Gateway {
  baseUrl: string;
  apiKey: string;
}

// The model behind the dashboard's per-voice preview button. Verified against
// OpenAI directly (2026-08-31): it accepts all ten REALTIME_VOICES, including
// marin and cedar, and answers audio/mpeg. The university gateway does not
// offer it yet (2026-09-11); once it does under this name, the preview works
// again with no code change. Only the preview uses TTS; the interviews
// themselves speak through the realtime session.
const VOICE_PREVIEW_MODEL = "gpt-4o-mini-tts";

// The complete set of messages this module can throw. Nothing is interpolated
// into them, ever.
const ERR_KEY = "The AI gateway rejected the API key.";
const ERR_MODEL = "The AI gateway did not find the model.";
const ERR_RATE = "The AI gateway rate limit was hit.";
const ERR_GENERIC = "The AI gateway request failed.";

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

/**
 * `fetch`, repeated once on a 404. One upstream behind the Tilburg gateway
 * answers a bare nginx 404 to any path, most often to the first request after
 * a quiet spell (found 2026-09-11, CLAUDE.md "Azure migration"). It never
 * reaches the model, so sending the same request again is safe and usually
 * lands on a healthy upstream. A genuine 404 simply comes back twice. Every
 * body sent from here is a string, so it can be sent twice.
 */
async function send(url: string, init: RequestInit): Promise<Response> {
  const res = await fetch(url, init);
  if (res.status !== 404) return res;
  await res.body?.cancel();
  return fetch(url, init);
}

export interface MintedToken {
  /** The ephemeral client secret the browser opens the WebRTC session with. */
  token: string;
  /** Unix seconds, as returned by the gateway. */
  expiresAt: number;
}

/**
 * Mints a realtime client secret for one interview (BACKEND-PLAN.md section 5).
 *
 * `instructions` is set here rather than over the client's data channel:
 * OPENAI-MIGRATION.md section 7(a) verified that the mint accepts it, and the
 * gateway keeps it (verified 2026-09-11), which is what keeps the persona text
 * (and therefore Layer 3) out of the browser.
 *
 * The body shape is the gateway's, found by an A/B test against the patched
 * testing gateway on 2026-09-11: the model goes at the TOP level, and
 * `session.model` must be present but EMPTY. With the model name inside the
 * session instead (OpenAI's own shape, which this function sent before), the
 * gateway forwards it to Azure, Azure refuses, and the gateway answers "429 No
 * deployments available", a five-second cooldown that hides the real error.
 * Leaving `session.model` out altogether gets "OperationNotSupported" back.
 *
 * `expires_after` is the only server-side bound on an interview that exists.
 * Section 7(b) found no `max_session_duration`, so this caps when a token may
 * *start* a session, not how long one runs; the countdown and the session
 * quota carry the rest. Verified accepted with the `created_at` anchor.
 */
export async function mintRealtimeToken(
  gw: Gateway,
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
    res = await send(`${gw.baseUrl}/realtime/client_secrets`, {
      method: "POST",
      headers: { Authorization: `Bearer ${gw.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: args.model,
        expires_after: { anchor: "created_at", seconds: args.tokenTtlSeconds },
        session: {
          type: "realtime",
          model: "",
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
export async function callResponses(gw: Gateway, body: ResponsesRequest): Promise<unknown> {
  let res: Response;
  try {
    res = await send(`${gw.baseUrl}/responses`, {
      method: "POST",
      headers: { Authorization: `Bearer ${gw.apiKey}`, "Content-Type": "application/json" },
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
  gw: Gateway,
  voice: string,
  text: string,
): Promise<ArrayBuffer> {
  let res: Response;
  try {
    res = await send(`${gw.baseUrl}/audio/speech`, {
      method: "POST",
      headers: { Authorization: `Bearer ${gw.apiKey}`, "Content-Type": "application/json" },
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
 * a reason that came from the gateway.
 */
export async function validateApiKey(gw: Gateway): Promise<boolean> {
  try {
    const res = await send(`${gw.baseUrl}/models`, { headers: { Authorization: `Bearer ${gw.apiKey}` } });
    return res.ok;
  } catch {
    return false;
  }
}
