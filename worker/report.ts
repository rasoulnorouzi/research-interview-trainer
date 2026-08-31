// The two endpoints that spend the university OpenAI key: minting an interview
// token (BACKEND-PLAN.md §5) and scoring plus emailing a finished interview
// (§5, §8) with one independent evaluator call per active criterion. Read §5
// and §7 before changing anything here.
//
// Both handlers re-check the roster rather than trusting the session cookie
// alone. `identify` is stateless by design (§9) and does not see a student
// deactivated since their cookie was minted, so anything that costs money joins
// `roster ... AND active = 1` itself.
//
// No OpenAI failure detail ever reaches a response body or a log line. The
// messages below are ours, not OpenAI's; see the key-hygiene note in openai.ts.

import { identify } from "./auth";
import { getSettings, json, readJsonBody, type Env } from "./db";
import {
  assessmentAttachment,
  instructorReportEmail,
  sendEmail,
  studentReportEmail,
  studentTranscriptEmail,
  transcriptAttachment,
  type ReportEmailData,
} from "./email";
import { mintRealtimeToken } from "./openai";
import { scoreAll, type ScoringPersona } from "./scoring";
import { parseRecipients } from "../shared/recipients";
import { SHARED_DISCLOSURE_MECHANICS } from "../src/personas";
import type {
  CriterionDefinition,
  Metrics,
  ReportRequest,
  ReportResponse,
  SessionResponse,
  TranscriptEntry,
} from "../shared/types";

// Applied when a settings row is missing or unparseable. The seed file sets all
// of these, so reaching a default means someone cleared a row; the values match
// BACKEND-PLAN.md §3 so the behaviour is the documented one either way.
const DEFAULT_LIMIT_MINUTES = 12;
const DEFAULT_WARN_MINUTES = 10;
const DEFAULT_SESSIONS_TOTAL = 10;
const DEFAULT_INTERVIEW_MODEL = "gpt-realtime-2.1-mini";
const DEFAULT_SCORING_MODEL = "gpt-5.6-terra";

// A token is valid for the interview limit plus two minutes. OPENAI-MIGRATION.md
// §7(b) found no max_session_duration, so this is the only server-side bound
// that exists: it caps when a session may START, not how long one runs. The
// client countdown and the session quota carry the rest (§5).
const TOKEN_GRACE_MINUTES = 2;

const NOT_LOGGED_IN = "Not logged in.";
// Never any key detail, not even "no key is set" phrased as a key fact.
const NOT_CONFIGURED = "The service is not configured yet. Tell your instructor.";

const MAX_TRANSCRIPT_ENTRIES = 500;
const MAX_TRANSCRIPT_BYTES = 200 * 1024;

/** POST /api/session — identify, session_grants quota, mint an ephemeral token. */
export async function handleSession(request: Request, env: Env): Promise<Response> {
  const session = await identify(request, env);
  if (!session) return json(401, { error: NOT_LOGGED_IN });
  const student = await env.DB.prepare("SELECT student_id FROM roster WHERE student_id = ? AND active = 1")
    .bind(session.studentId)
    .first<{ student_id: string }>();
  if (!student) return json(401, { error: NOT_LOGGED_IN });

  // Parsed before the grant is consumed, so a malformed request does not cost
  // the student one of their interview sessions.
  const parsed = await readJsonBody<{ personaId?: unknown }>(request);
  if (!parsed.ok) return parsed.response;
  const personaId = typeof parsed.value.personaId === "string" ? parsed.value.personaId : "";
  if (!personaId) return json(400, { error: "A persona is required." });

  const settings = await getSettings(env, [
    "sessions_total",
    "interview_limit_minutes",
    "interview_warn_minutes",
    "interview_model",
    "openai_api_key",
  ]);
  const apiKey = settings.openai_api_key ?? "";
  if (!apiKey) return json(503, { error: NOT_CONFIGURED });

  const limitMinutes = positiveInt(settings.interview_limit_minutes, DEFAULT_LIMIT_MINUTES);
  const warnMinutes = positiveInt(settings.interview_warn_minutes, DEFAULT_WARN_MINUTES);
  const quota = positiveInt(settings.sessions_total, DEFAULT_SESSIONS_TOTAL);

  // The quota is a TOTAL per student, not per day (instructor decision,
  // 2026-08-26), and it is the backstop the whole time limit depends on: a
  // student who disables the countdown in devtools is still bounded to
  // sessions_total × limit (§5). The grants stay one row per day so usage
  // remains readable, and the check sums them. Increment today's row first,
  // then check the sum, so two requests racing cannot both read an under-quota
  // count. A rejected mint still costs a grant, which is the simpler behaviour
  // and acceptable. The dashboard's reset control deletes a student's grant
  // rows, which re-opens the quota without touching their reports.
  const day = new Date().toISOString().slice(0, 10); // UTC YYYY-MM-DD
  await env.DB.prepare(
    "INSERT INTO session_grants (student_id, day, count) VALUES (?, ?, 1) " +
      "ON CONFLICT(student_id, day) DO UPDATE SET count = session_grants.count + 1",
  )
    .bind(session.studentId, day)
    .run();
  const used = await env.DB.prepare("SELECT SUM(count) AS n FROM session_grants WHERE student_id = ?")
    .bind(session.studentId)
    .first<{ n: number }>();
  if ((used?.n ?? 1) > quota) {
    return json(429, {
      error: "You have used all your interview sessions. Ask your instructor if you need another one.",
    });
  }

  const persona = await env.DB.prepare(
    "SELECT id, name, voice_name, system_instruction FROM personas WHERE id = ? AND active = 1",
  )
    .bind(personaId)
    .first<{ id: string; name: string; voice_name: string; system_instruction: string }>();
  if (!persona) return json(404, { error: "That persona is not available." });

  let minted;
  try {
    minted = await mintRealtimeToken(apiKey, {
      model: settings.interview_model || DEFAULT_INTERVIEW_MODEL,
      voice: persona.voice_name,
      // The shared disclosure mechanics are re-appended here for EVERY persona,
      // exactly as buildCustomPersona() does on the client, so no stored persona
      // can exist without them (§7). Stored rows hold only the persona-specific
      // prompt; worker/genseed.ts strips this text back out when seeding.
      instructions: persona.system_instruction + SHARED_DISCLOSURE_MECHANICS,
      tokenTtlSeconds: (limitMinutes + TOKEN_GRACE_MINUTES) * 60,
    });
  } catch (err) {
    // openai.ts throws only its four fixed strings, so this cannot carry the
    // key, the request or OpenAI's response body into the log.
    console.error("mint failed:", err instanceof Error ? err.message : "unknown");
    return json(502, { error: "Could not start the interview. Try again in a moment." });
  }

  const body: SessionResponse = {
    token: minted.token,
    expiresAt: minted.expiresAt,
    limitMinutes,
    warnMinutes,
  };
  // No `instructions` field: §7(a) of OPENAI-MIGRATION.md confirmed the mint
  // accepts them, so the persona text stays server-side.
  return json(200, body);
}

/**
 * POST /api/report — one independent evaluator call per active criterion plus
 * the feedback call, then persist and email.
 */
export async function handleReport(request: Request, env: Env): Promise<Response> {
  const session = await identify(request, env);
  if (!session) return json(401, { error: NOT_LOGGED_IN });
  const student = await env.DB.prepare(
    "SELECT student_id, email, full_name, cohort FROM roster WHERE student_id = ? AND active = 1",
  )
    .bind(session.studentId)
    .first<{ student_id: string; email: string; full_name: string; cohort: string | null }>();
  if (!student) return json(401, { error: NOT_LOGGED_IN });

  const parsed = await readJsonBody<ReportRequest>(request);
  if (!parsed.ok) return parsed.response;
  const validated = validateReport(parsed.value);
  if ("error" in validated) return json(validated.status, { error: validated.error });
  const { personaId, transcript, startedAt, endedAt, metrics } = validated;

  const personaRow = await env.DB.prepare(
    "SELECT id, name, title, research_topic, hidden_core FROM personas WHERE id = ? AND active = 1",
  )
    .bind(personaId)
    .first<{ id: string; name: string; title: string; research_topic: string; hidden_core: string | null }>();
  if (!personaRow) return json(404, { error: "That persona is not available." });

  // The rubric is read fresh per report, so an edit in the dashboard applies to
  // the next interview scored rather than the next deploy. Inactive criteria
  // are simply absent: they cost no call and appear in no report.
  const criteria = await loadCriteria(env);
  if (criteria.length === 0) {
    // Same answer as a missing API key, and for the same reason: this is the
    // instructor's configuration to fix, and a student can do nothing with a
    // more specific message.
    console.error("scoring aborted: the rubric has no active criteria");
    return json(503, { error: NOT_CONFIGURED });
  }

  const settings = await getSettings(env, [
    "scoring_model",
    "openai_api_key",
    "instructor_recipients",
    "share_report_with_student",
    "generate_feedback",
  ]);
  const apiKey = settings.openai_api_key ?? "";
  if (!apiKey) return json(503, { error: NOT_CONFIGURED });

  // The instructor's switch, and the only thing it touches: the student's copy
  // of the report. Scoring, storage and the instructor email below are the same
  // either way. Anything other than the stored "0" means share, so a cleared or
  // hand-edited row keeps today's behaviour rather than silently withholding.
  const shareWithStudent = settings.share_report_with_student !== "0";

  // The second switch (2026-08-31): whether the AI assessor writes qualitative
  // feedback at all. Off means the feedback call is never made and every copy
  // of the report, the student's, the instructor's and the stored one, carries
  // scores without a feedback section. Same missing-row default as above.
  const generateFeedback = settings.generate_feedback !== "0";

  // The evaluators see the name, the title, the topic and the ground truth.
  // Not the system instruction, not the voice, not the short bio.
  const persona: ScoringPersona = {
    name: personaRow.name,
    title: personaRow.title,
    researchTopic: personaRow.research_topic,
    hiddenCore: personaRow.hidden_core,
  };

  let scored;
  try {
    scored = await scoreAll(
      apiKey,
      settings.scoring_model || DEFAULT_SCORING_MODEL,
      persona,
      transcript,
      criteria,
      generateFeedback,
    );
  } catch (err) {
    console.error("scoring failed:", err instanceof Error ? err.message : "unknown");
    // All-or-nothing: nothing is stored and nothing is emailed, so the client's
    // whole-report retry (§8) is a clean re-POST rather than a reconciliation.
    return json(502, { error: "Scoring failed. Use Retry." });
  }

  // Computed here, never by a model: no evaluator produces an aggregate, and
  // not-assessable criteria are excluded rather than counted as zero. Points
  // earned over points available, as a percentage, because criteria no longer
  // share one scale and a mean of a 5 and a 10 would mean nothing. A report
  // where nothing was assessable has a null overall.
  let points = 0;
  let possible = 0;
  for (const row of scored.scores) {
    if (row.score === null) continue;
    points += row.score;
    possible += row.max ?? 5;
  }
  const overall = possible > 0 ? Math.round(((100 * points) / possible) * 10) / 10 : null;

  const submissionId = crypto.randomUUID();
  const durationMs = endedAt - startedAt;
  const nowSeconds = Math.floor(Date.now() / 1000);
  // The client reports epoch milliseconds; every INTEGER timestamp column in
  // schema.sql is unix seconds (and the admin date filters compare in seconds).
  // The email builder below keeps the millisecond values.
  const startedAtSeconds = Math.floor(startedAt / 1000);
  const endedAtSeconds = Math.floor(endedAt / 1000);
  await env.DB.prepare(
    "INSERT INTO submissions (id, student_id, persona_id, started_at, ended_at, duration_ms, overall_score, " +
      "scores_json, feedback_json, metrics_json, transcript_json, emailed_at, created_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)",
  )
    .bind(
      submissionId,
      student.student_id,
      personaRow.id,
      startedAtSeconds,
      endedAtSeconds,
      durationMs,
      overall,
      JSON.stringify(scored.scores),
      JSON.stringify(scored.feedback),
      JSON.stringify(metrics),
      JSON.stringify(transcript),
      nowSeconds,
    )
    .run();

  const emailData: ReportEmailData = {
    studentName: student.full_name,
    studentId: student.student_id,
    cohort: student.cohort,
    personaName: personaRow.name,
    personaTitle: personaRow.title,
    startedAt,
    durationMs,
    metrics,
    scores: scored.scores,
    feedback: scored.feedback,
    overall,
    transcript,
  };

  // Only the switched-on addresses receive a copy. A recipient the instructor
  // has toggled off stays stored (as "!address") but is filtered out here.
  const recipients = parseRecipients(settings.instructor_recipients ?? "")
    .filter((recipient) => recipient.active)
    .map((recipient) => recipient.email);

  // A failed send must never fail the report. The submission is already stored
  // and the scores are already in the response; email is a delivery mechanism,
  // not the record. The log line carries no address and no report content.
  let emailed = false;
  try {
    // The transcript and the assessment also travel as two separate .txt
    // files (instructor request, 2026-08-26). The student's mail carries the
    // assessment file only when sharing is on; the instructor's always
    // carries both.
    const transcriptFile = transcriptAttachment(emailData);
    const assessmentFile = assessmentAttachment(emailData);
    const forStudent = shareWithStudent
      ? studentReportEmail(emailData)
      : studentTranscriptEmail(emailData);
    await sendEmail(
      env.RESEND_API_KEY,
      env.EMAIL_FROM,
      [student.email],
      forStudent.subject,
      forStudent.text,
      forStudent.html,
      shareWithStudent ? [transcriptFile, assessmentFile] : [transcriptFile],
    );
    if (recipients.length > 0) {
      const forInstructor = instructorReportEmail(emailData);
      await sendEmail(
        env.RESEND_API_KEY,
        env.EMAIL_FROM,
        recipients,
        forInstructor.subject,
        forInstructor.text,
        forInstructor.html,
        [transcriptFile, assessmentFile],
      );
    }
    emailed = true;
  } catch (err) {
    console.error("report email failed for submission", submissionId, err instanceof Error ? err.message : "unknown");
  }
  if (emailed) {
    await env.DB.prepare("UPDATE submissions SET emailed_at = ? WHERE id = ?")
      .bind(nowSeconds, submissionId)
      .run();
  }

  // With sharing off the scores are held back from the response as well as from
  // the email, so the browser never holds a number the student is not meant to
  // see. The stored submission above is complete either way.
  const body: ReportResponse = shareWithStudent
    ? { scores: scored.scores, feedback: scored.feedback, overall, emailed, shared: true }
    : { scores: [], feedback: null, overall: null, emailed, shared: false };
  return json(200, body);
}

interface CriterionRow {
  id: string;
  name: string;
  description: string;
  anchor_low: string;
  anchor_mid: string;
  anchor_high: string;
  scale_max: number;
  needs_ground_truth: number;
}

/**
 * The active rubric, in the instructor's order. sort_order then id, so two
 * criteria left at the same sort_order still come out in a stable order rather
 * than swapping places between reports.
 *
 * scale_max is clamped to the same 2..10 the admin API enforces. The column has
 * no CHECK constraint, so a row edited straight in the database could otherwise
 * put "1-50" in an evaluator prompt and a 50-point criterion in the overall.
 */
async function loadCriteria(env: Env): Promise<CriterionDefinition[]> {
  const rows = await env.DB.prepare(
    "SELECT id, name, description, anchor_low, anchor_mid, anchor_high, scale_max, needs_ground_truth " +
      "FROM criteria WHERE active = 1 ORDER BY sort_order, id",
  ).all<CriterionRow>();

  return rows.results.map((row) => ({
    id: row.id,
    name: row.name,
    description: row.description,
    anchorLow: row.anchor_low,
    anchorMid: row.anchor_mid,
    anchorHigh: row.anchor_high,
    scaleMax: clampScale(row.scale_max),
    needsGroundTruth: row.needs_ground_truth === 1,
  }));
}

function clampScale(value: unknown): number {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return 5;
  return Math.min(10, Math.max(2, n));
}

interface ValidReport {
  personaId: string;
  transcript: TranscriptEntry[];
  startedAt: number;
  endedAt: number;
  metrics: Metrics;
}

/**
 * The request body is entirely student-controlled: it arrives from the browser
 * and a student can post whatever they like. Everything here is either checked
 * or normalised before it reaches a prompt, a database row or an email.
 *
 * The transcript itself is untrusted *content* as well as untrusted shape; the
 * defence for that is in scoring.ts (PROMPTING.md section B), not here.
 */
function validateReport(body: unknown): ValidReport | { status: number; error: string } {
  const bad = (error: string) => ({ status: 400, error });
  if (typeof body !== "object" || body === null) return bad("Malformed report.");
  const b = body as Record<string, unknown>;

  const personaId = typeof b.personaId === "string" ? b.personaId : "";
  if (!personaId) return bad("Malformed report.");

  if (!Array.isArray(b.transcript)) return bad("Malformed report.");
  if (b.transcript.length < 1 || b.transcript.length > MAX_TRANSCRIPT_ENTRIES) {
    return bad("The transcript is empty or too long.");
  }
  if (new TextEncoder().encode(JSON.stringify(b.transcript)).length > MAX_TRANSCRIPT_BYTES) {
    return { status: 413, error: "The transcript is too large." };
  }

  const transcript: TranscriptEntry[] = [];
  for (const raw of b.transcript) {
    if (typeof raw !== "object" || raw === null) return bad("Malformed report.");
    const e = raw as Record<string, unknown>;
    if (e.speaker !== "student" && e.speaker !== "interviewee") return bad("Malformed report.");
    if (typeof e.text !== "string") return bad("Malformed report.");
    // The timings only feed fmtMs in the report and the email. A missing or
    // non-finite one becomes 0 rather than rejecting an otherwise real
    // interview, because "NaN:NaN" in a student's report is the failure that
    // matters and losing the report is worse than losing one timestamp.
    transcript.push({
      speaker: e.speaker,
      text: e.text,
      tStart: finiteOrZero(e.tStart),
      tEnd: finiteOrZero(e.tEnd),
      speechMs: finiteOrZero(e.speechMs),
    });
  }

  if (!isFiniteNumber(b.startedAt) || !isFiniteNumber(b.endedAt)) return bad("Malformed report.");
  if (typeof b.metrics !== "object" || b.metrics === null || Array.isArray(b.metrics)) {
    return bad("Malformed report.");
  }

  return {
    personaId,
    transcript,
    startedAt: b.startedAt,
    endedAt: b.endedAt,
    metrics: b.metrics as Metrics,
  };
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function finiteOrZero(value: unknown): number {
  return isFiniteNumber(value) ? value : 0;
}

/** A settings value that must be a positive whole number, or the default. */
function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
