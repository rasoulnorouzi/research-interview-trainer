// Worker plumbing shared by every module: the environment binding, the
// settings read, and the two HTTP helpers. See BACKEND-PLAN.md §3.
//
// There is no ORM and no query builder. Handlers write their own SQL with
// .prepare(...).bind(...), which keeps the schema portable to plain SQLite or
// Postgres on a university VM (BACKEND-PLAN.md §9).

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  /** HMAC key for the signed session cookie. `wrangler secret put SESSION_SECRET`. */
  SESSION_SECRET: string;
  RESEND_API_KEY: string;
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
  EMAIL_FROM: string;
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
