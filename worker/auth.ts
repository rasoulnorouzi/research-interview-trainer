// Student authentication: email plus a mailed six-digit code, against the
// pre-loaded roster. BACKEND-PLAN.md §6 and the security checklist there, with
// one deliberate exception recorded below. Read that section before changing
// anything in this file; several lines that look like boilerplate are the
// protection.
//
// The security rests on one property: the code goes to an address already on
// file, never to one the student supplies. Keep that if you change nothing else.
//
// The exception (instructor decision, 2026-08-14): /api/auth/request no longer
// answers 200 for every address. It says plainly when an address is not on the
// roster, so a student who mistypes their address, or who uses a personal one,
// learns it immediately instead of waiting for a code that will never arrive.
// That trades the enumeration resistance §6 asks for against clarity for 400
// students, and the instructor made that trade knowingly. What remains against
// bulk probing is the rate limits: 1 per minute and 5 per hour per address, 10
// per hour per IP, consumed before the roster is read. Do not remove them, and
// do not extend the same candour to the verify path, which still answers with a
// single message for every failure.

import { json, readJsonBody, type Env, type RosterIdentity } from "./db";
import { sendLoginCode } from "./email";
import type { MeResponse } from "../shared/types";

const COOKIE_NAME = "riv_session";
const SESSION_VERSION = 1;
const EIGHT_HOURS_SECONDS = 8 * 60 * 60;
const NINETY_DAYS_SECONDS = 90 * 24 * 60 * 60;
const CODE_TTL_SECONDS = 600;
const MAX_ATTEMPTS = 5;

// One message for every verify failure: unknown address, wrong code, expired
// code, burnt attempts, deactivated student. Separate messages here would tell
// a caller how far a guess got, which is the useful signal on this path: an
// address with a live code, a code that is merely expired, or attempts already
// burnt. Keep the single message even though /api/auth/request now names an
// unknown address.
const VERIFY_ERROR = "Code incorrect or expired.";

interface SessionPayload {
  sid: string;
  exp: number;
  v: number;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * The ONLY code in the Worker that parses the session cookie
 * (BACKEND-PLAN.md §9). Handlers call this and nothing else, so that swapping
 * the cookie for an LTI or OIDC claim later touches one function.
 *
 * Note it reads no storage, so it does not see a student deactivated since the
 * cookie was minted. Handlers that must reject a deactivated student (anything
 * spending the university key) join to roster with `active = 1` themselves;
 * handleMe below is the pattern.
 */
export async function identify(request: Request, env: Env): Promise<{ studentId: string } | null> {
  const raw = readCookie(request, COOKIE_NAME);
  if (!raw || !env.SESSION_SECRET) return null;
  const dot = raw.indexOf(".");
  if (dot <= 0) return null;
  try {
    const payloadBytes = b64urlDecode(raw.slice(0, dot));
    const signature = b64urlDecode(raw.slice(dot + 1));
    const key = await hmacKey(env.SESSION_SECRET);
    // crypto.subtle.verify, never a string compare of signatures.
    const valid = await crypto.subtle.verify("HMAC", key, signature, payloadBytes);
    if (!valid) return null;
    const payload = JSON.parse(new TextDecoder().decode(payloadBytes)) as SessionPayload;
    if (payload.v !== SESSION_VERSION) return null;
    if (typeof payload.sid !== "string" || payload.sid.length === 0) return null;
    if (typeof payload.exp !== "number" || payload.exp <= nowSeconds()) return null;
    return { studentId: payload.sid };
  } catch {
    return null;
  }
}

/** Stateless signed cookie: student id, expiry, version. Nothing to store or clean up. */
export async function makeSessionCookie(env: Env, studentId: string, remember: boolean): Promise<string> {
  const maxAge = remember ? NINETY_DAYS_SECONDS : EIGHT_HOURS_SECONDS;
  const payload: SessionPayload = { sid: studentId, exp: nowSeconds() + maxAge, v: SESSION_VERSION };
  const payloadBytes = new TextEncoder().encode(JSON.stringify(payload));
  const key = await hmacKey(env.SESSION_SECRET);
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, payloadBytes));
  const value = `${b64urlEncode(payloadBytes)}.${b64urlEncode(signature)}`;
  // Flags exactly as specified in §6. Do not relax SameSite or drop Secure.
  return `${COOKIE_NAME}=${value}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}

export function clearSessionCookie(): string {
  return `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

/**
 * POST /api/auth/request, body {email}.
 *
 * Answers each branch plainly: 400 for an address that is not one, 429 over a
 * rate limit, 404 for an address that is not on the roster, 502 when the code
 * could not be mailed, 200 when it was sent. The 404 is the instructor's
 * decision of 2026-08-14, described at the top of this file: a student who is
 * not on the course list is told so before a code is generated, rather than
 * being left to wait for mail that will never come. It is a deliberate
 * departure from the enumeration resistance BACKEND-PLAN.md §6 specifies.
 *
 * The rate limits below are what still bounds bulk probing, so they run before
 * the roster is read and are consumed even when the caller is already over.
 */
export async function handleAuthRequest(request: Request, env: Env): Promise<Response> {
  const parsed = await readJsonBody<{ email?: unknown }>(request);
  if (!parsed.ok) return parsed.response;

  const email = typeof parsed.value.email === "string" ? parsed.value.email.trim().toLowerCase() : "";
  if (!email.includes("@")) return json(400, { error: "Enter your university email address." });

  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const now = nowSeconds();

  // Consumed before the roster is touched. Without this the endpoint is an
  // email-bombing tool aimed at any student whose address someone knows, it
  // drains the send quota (§6), and now that the roster answer is visible it is
  // also the only thing standing between a script and the enrolment list.
  const limited = await consumeRateLimits(env, now, [
    { key: `email:60:${email}`, windowSeconds: 60, max: 1 },
    { key: `email:3600:${email}`, windowSeconds: 3600, max: 5 },
    // A whole computer lab or campus WiFi can sit behind one NAT address, so
    // the IP ceiling must fit a classroom logging in together, not a single
    // person. 120/hour still stops bulk probing and email bombing cold.
    { key: `ip:3600:${ip}`, windowSeconds: 3600, max: 120 },
  ]);
  if (limited) return json(429, { error: "Too many attempts. Wait a minute and try again." });

  const student = await env.DB.prepare(
    "SELECT student_id, full_name FROM roster WHERE email = ? AND active = 1",
  )
    .bind(email)
    .first<RosterIdentity>();
  // Nothing is generated and nothing is stored for an address that is not here.
  if (!student) {
    return json(404, {
      error: "This email address is not on the course list. Check for typos or contact your instructor.",
    });
  }

  const code = generateCode();
  // One live code per address; a new request overwrites the old one.
  await env.DB.prepare(
    "INSERT OR REPLACE INTO login_codes (email, code_hash, expires_at, attempts, requested_at) VALUES (?, ?, ?, 0, ?)",
  )
    .bind(email, await sha256Hex(code), now + CODE_TTL_SECONDS, now)
    .run();

  try {
    await sendLoginCode(env.RESEND_API_KEY, env.EMAIL_FROM, email, code);
  } catch (err) {
    // The address and the transport failure, never the code itself.
    console.error("login code send failed for", email, err instanceof Error ? err.message : String(err));
    return json(502, { error: "The code email could not be sent. Try again in a minute." });
  }
  return json(200, { ok: true });
}

/** POST /api/auth/verify, body {email, code, remember}. Read this path in full before shipping (§10). */
export async function handleAuthVerify(request: Request, env: Env): Promise<Response> {
  const parsed = await readJsonBody<{ email?: unknown; code?: unknown; remember?: unknown }>(request);
  if (!parsed.ok) return parsed.response;
  const fail = () => json(401, { error: VERIFY_ERROR });

  const email = typeof parsed.value.email === "string" ? parsed.value.email.trim().toLowerCase() : "";
  const code = typeof parsed.value.code === "string" ? parsed.value.code.trim() : "";
  const remember = parsed.value.remember === true;
  const now = nowSeconds();

  const row = await env.DB.prepare(
    "SELECT code_hash, expires_at, attempts FROM login_codes WHERE email = ?",
  )
    .bind(email)
    .first<{ code_hash: string; expires_at: number; attempts: number }>();
  if (!row) return fail();
  if (row.expires_at <= now) {
    await deleteCode(env, email);
    return fail();
  }
  // Six digits is a million combinations, which a script clears in seconds.
  if (row.attempts >= MAX_ATTEMPTS) {
    await deleteCode(env, email);
    return fail();
  }
  // Increment BEFORE comparing, so a crash or a timeout after the comparison
  // cannot hand an attacker a free attempt.
  await env.DB.prepare("UPDATE login_codes SET attempts = attempts + 1 WHERE email = ?").bind(email).run();

  const encoder = new TextEncoder();
  const submitted = encoder.encode(await sha256Hex(code));
  if (!constantTimeEqual(submitted, encoder.encode(row.code_hash))) return fail();

  // Single use.
  await deleteCode(env, email);

  const student = await env.DB.prepare(
    "SELECT student_id, full_name FROM roster WHERE email = ? AND active = 1",
  )
    .bind(email)
    .first<RosterIdentity>();
  if (!student) return fail();

  const body: MeResponse = { studentId: student.student_id, fullName: student.full_name };
  const response = json(200, body);
  response.headers.append("set-cookie", await makeSessionCookie(env, student.student_id, remember));
  return response;
}

/** POST /api/auth/logout. */
export function handleAuthLogout(): Response {
  const response = json(200, { ok: true });
  response.headers.append("set-cookie", clearSessionCookie());
  return response;
}

/** GET /api/me. The roster join is what makes a deactivated student's cookie useless. */
export async function handleMe(request: Request, env: Env): Promise<Response> {
  const session = await identify(request, env);
  if (!session) return json(401, { error: "Not logged in." });
  const student = await env.DB.prepare("SELECT full_name FROM roster WHERE student_id = ? AND active = 1")
    .bind(session.studentId)
    .first<{ full_name: string }>();
  if (!student) return json(401, { error: "Not logged in." });
  const body: MeResponse = { studentId: session.studentId, fullName: student.full_name };
  return json(200, body);
}

/**
 * GET /api/auth/redeem?token=… — the break-glass path (§6), for the few
 * students whose mail never arrives for reasons nobody can see. The admin
 * endpoint mints an opaque 32-hex token and stores its SHA-256 in login_codes
 * under the student's roster email; this exchanges it for a normal session.
 *
 * Single use, and it expires like any other code. It carries no error detail,
 * because the link is handed out over another channel and a failure there is
 * an instructor problem, not a student one.
 */
export async function handleRedeem(request: Request, env: Env): Promise<Response> {
  const expired = () => redirect("/?breakglass=expired");
  const token = new URL(request.url).searchParams.get("token") ?? "";
  if (!/^[0-9a-f]{32}$/.test(token)) return expired();

  const row = await env.DB.prepare("SELECT email FROM login_codes WHERE code_hash = ? AND expires_at > ?")
    .bind(await sha256Hex(token), nowSeconds())
    .first<{ email: string }>();
  if (!row) return expired();
  await deleteCode(env, row.email);

  const student = await env.DB.prepare(
    "SELECT student_id, full_name FROM roster WHERE email = ? AND active = 1",
  )
    .bind(row.email)
    .first<RosterIdentity>();
  if (!student) return expired();

  // remember=false: a break-glass link is for getting through one session.
  return redirect("/", await makeSessionCookie(env, student.student_id, false));
}

/** Six digits from crypto.getRandomValues, never Math.random, never modulo bias. */
export function generateCode(): string {
  const digits: string[] = [];
  const byte = new Uint8Array(1);
  while (digits.length < 6) {
    crypto.getRandomValues(byte);
    // Rejection sampling: 250 is the largest multiple of 10 at or below 256,
    // so the accepted range maps exactly 25-to-1 onto the ten digits.
    if (byte[0] >= 250) continue;
    digits.push(String(byte[0] % 10));
  }
  return digits.join("");
}

/** Exported because the admin break-glass endpoint stores tokens the same way. */
export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * XOR-accumulate over the full length with the length difference folded in.
 * No early return: the running time must not depend on where the first
 * differing byte is.
 */
export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  let diff = a.length ^ b.length;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = i < a.length ? a[i] : 0;
    const y = i < b.length ? b[i] : 0;
    diff |= x ^ y;
  }
  return diff === 0;
}

// Shared with access.ts rather than duplicated there.
export function b64urlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64urlDecode(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4)) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

interface RateLimitRule {
  key: string;
  windowSeconds: number;
  max: number;
}

/**
 * Increment every counter, then report whether any is over its limit. Counters
 * are consumed even when already over, so a caller hammering the endpoint stays
 * locked out rather than recovering one send per window.
 *
 * The window length is part of the key. Two windows on the same address would
 * otherwise collide on the (key, window_start) primary key whenever a 60s and a
 * 3600s window begin at the same second, which is every full hour.
 */
async function consumeRateLimits(env: Env, now: number, rules: RateLimitRule[]): Promise<boolean> {
  const statements = rules.map((rule) =>
    env.DB.prepare(
      "INSERT INTO request_log (key, window_start, count) VALUES (?, ?, 1) " +
        "ON CONFLICT(key, window_start) DO UPDATE SET count = request_log.count + 1 RETURNING count",
    ).bind(rule.key, Math.floor(now / rule.windowSeconds) * rule.windowSeconds),
  );
  // Windows older than the longest one in use can never matter again.
  statements.push(env.DB.prepare("DELETE FROM request_log WHERE window_start < ?").bind(now - 7200));

  const results = await env.DB.batch<{ count: number }>(statements);
  let over = false;
  for (let i = 0; i < rules.length; i++) {
    const row = results[i].results[0];
    if (row && row.count > rules[i].max) over = true;
  }
  return over;
}

async function deleteCode(env: Env, email: string): Promise<void> {
  await env.DB.prepare("DELETE FROM login_codes WHERE email = ?").bind(email).run();
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

function redirect(location: string, cookie?: string): Response {
  const headers = new Headers({ location, "cache-control": "no-store" });
  if (cookie) headers.append("set-cookie", cookie);
  return new Response(null, { status: 302, headers });
}

function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    if (trimmed.startsWith(`${name}=`)) return trimmed.slice(name.length + 1);
  }
  return null;
}
