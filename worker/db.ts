// Worker plumbing shared by every module: the environment binding, the
// settings read, and the two HTTP helpers. See BACKEND-PLAN.md §3.
//
import { MailError, type MailSender } from "./email";

// There is no ORM and no query builder. Handlers write their own SQL with
// .prepare(...).bind(...), which keeps the schema portable to plain SQLite or
// Postgres on a university VM (BACKEND-PLAN.md §9).

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  /** HMAC key for the signed session cookie. `wrangler secret put SESSION_SECRET`. */
  SESSION_SECRET: string;
  /**
   * Cloudflare Email Service, the `send_email` binding in wrangler.jsonc.
   * It replaced Resend on 2026-09-18, so there is no mail API key any
   * more: the binding authorizes itself, and the domain it may send from
   * is onboarded once per account.
   */
  EMAIL: SendEmail;
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
  /** The sender, as "Name <address>" or a bare address. */
  EMAIL_FROM: string;
  /**
   * Read-only token for the account's email limits, so a student blocked by
   * the daily quota can be told when it resets. Optional: without it the
   * message simply has no time. `wrangler secret put EMAIL_LIMITS_TOKEN`.
   */
  EMAIL_LIMITS_TOKEN?: string;
  /** The Cloudflare account the limits are read from. A var, not a secret. */
  CF_ACCOUNT_ID?: string;
  /**
   * The university AI gateway (Tilburg.AI, OpenAI-compatible), ending in /v1
   * with no trailing slash. Set in wrangler.jsonc; .dev.vars may override it
   * locally. Every AI call, and the browser's WebRTC call address, use it.
   */
  AI_BASE_URL: string;
  /**
   * Local development only: bypasses the Cloudflare Access check on /api/admin/*.
   * Set it in .dev.vars (gitignored) and nowhere else. It must NEVER appear in
   * wrangler.jsonc, because a var there is deployed and would open the whole
   * admin surface, including the roster and the OpenAI key.
   */
  DEV_ALLOW_INSECURE_ADMIN?: string;
}

/** The roster columns auth needs. The roster row is authoritative for identity (§6). */
export interface RosterIdentity {
  student_id: string;
  full_name: string;
}

/**
 * SQL condition: the persona aliased `p` is open to a student whose roster
 * cohort is bound to the one `?`. A persona with no persona_cohorts rows is
 * open to every student; a persona with rows only to those cohorts. Bind null
 * for a student without a cohort: `= NULL` is never true, so they get only the
 * open personas. GET /api/personas and POST /api/session both use this, so
 * the list a student sees and what they may start cannot drift apart.
 */
export const PERSONA_OPEN_TO_COHORT =
  "(NOT EXISTS (SELECT 1 FROM persona_cohorts pc WHERE pc.persona_id = p.id) " +
  "OR EXISTS (SELECT 1 FROM persona_cohorts pc WHERE pc.persona_id = p.id AND pc.cohort = ?))";

/**
 * Read settings rows in one query.
 *
 * Deliberately not cached at module scope: a dashboard change (time limit,
 * quota, model id, the API key) must take effect on the next request rather
 * than at the next cold start. BACKEND-PLAN.md §3 states this as a rule.
 * Missing keys are simply absent from the result; callers apply their own
 * defaults.
 */
export async function getSettings(env: Env, keys: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  if (keys.length === 0) return out;
  const placeholders = keys.map(() => "?").join(", ");
  const rows = await env.DB.prepare(`SELECT key, value FROM settings WHERE key IN (${placeholders})`)
    .bind(...keys)
    .all<{ key: string; value: string }>();
  for (const row of rows.results) out[row.key] = row.value;
  return out;
}

/** Every API response goes through here. no-store because most carry identity. */
export function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

const MAX_BODY_BYTES = 1024 * 1024;

/**
 * Parse a JSON request body with the content-type and size guards applied
 * before anything is deserialised. Lives here rather than in a fourth tiny
 * module; report.ts and admin.ts use it too.
 */
export async function readJsonBody<T>(
  request: Request,
): Promise<{ ok: true; value: T } | { ok: false; response: Response }> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    return { ok: false, response: json(415, { error: "Expected a JSON body." }) };
  }
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return { ok: false, response: json(413, { error: "Request body too large." }) };
  }
  const text = await request.text();
  // A UTF-8 byte is never fewer than a character, so this catches a body that
  // lied about or omitted its content-length.
  if (text.length > MAX_BODY_BYTES) {
    return { ok: false, response: json(413, { error: "Request body too large." }) };
  }
  try {
    return { ok: true, value: JSON.parse(text) as T };
  } catch {
    return { ok: false, response: json(400, { error: "Malformed JSON body." }) };
  }
}

// ---------------------------------------------------------------------
// Mail
// ---------------------------------------------------------------------

/**
 * Splits `EMAIL_FROM` into the shape the binding wants. It accepts both
 * "Research Interview Trainer <trainer@example.org>" and a bare address,
 * because the var has held both.
 */
function parseFrom(value: string): { email: string; name: string } {
  const match = /^\s*(.*?)\s*<\s*([^>]+)\s*>\s*$/.exec(value);
  if (match) return { name: match[1].replace(/^"|"$/g, ""), email: match[2] };
  return { name: "", email: value.trim() };
}

/**
 * The mail transport for `worker/email.ts`, built from the binding and
 * the configured sender. That module stays free of Cloudflare types; this
 * is the one place that knows which service carries the mail.
 *
 * A failure throws, as it did with Resend, so the callers' existing
 * handling still applies. The binding's errors carry a `code` such as
 * E_SENDER_NOT_VERIFIED or E_DAILY_LIMIT_EXCEEDED, which says what an
 * operator has to fix, so it is kept in the message. Neither the code nor
 * the message carries a recipient or any report content.
 */
export function mailer(env: Env): MailSender {
  const from = parseFrom(env.EMAIL_FROM);
  return async (message) => {
    try {
      await env.EMAIL.send({
        to: message.to,
        from,
        subject: message.subject,
        text: message.text,
        html: message.html,
        ...(message.attachments && message.attachments.length > 0
          ? {
              attachments: message.attachments.map((a) => ({
                disposition: "attachment" as const,
                filename: a.filename,
                type: a.contentType,
                content: a.content,
              })),
            }
          : {}),
      });
    } catch (err) {
      const raw = (err as { code?: unknown }).code;
      const code = typeof raw === "string" ? raw : null;
      const detail = err instanceof Error ? err.message : "unknown error";
      throw new MailError(code, `Email send failed${code ? ` (${code})` : ""}: ${detail}`);
    }
  };
}

/**
 * When the account's daily email quota resets, as an ISO timestamp, or null.
 *
 * Cloudflare's send error says only E_DAILY_LIMIT_EXCEEDED; the reset time
 * lives in the account's limits API, and it moves (it is a rolling daily
 * window, not a fixed hour), so it cannot be written down in advance. This
 * needs EMAIL_LIMITS_TOKEN, a token that can only READ the email limits. It
 * never throws: without the token, or if Cloudflare does not answer within
 * three seconds, the caller shows its message without a time.
 */
export async function emailQuotaResetsAt(env: Env): Promise<string | null> {
  const token = (env.EMAIL_LIMITS_TOKEN ?? "").trim();
  const account = (env.CF_ACCOUNT_ID ?? "").trim();
  if (!token || !account) return null;
  try {
    const res = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${account}/email/sending/limits`,
      { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(3000) },
    );
    if (!res.ok) return null;
    const body = (await res.json()) as { result?: { usage?: { resets_at?: unknown } } };
    const at = body.result?.usage?.resets_at;
    return typeof at === "string" && !Number.isNaN(Date.parse(at)) ? at : null;
  } catch {
    return null;
  }
}
