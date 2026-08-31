// Email dispatch for the hosted trainer (BACKEND-PLAN.md sections 5-7).
//
// Sends through the Resend HTTP API with plain `fetch`. This module has
// ZERO Cloudflare imports and no platform types: it does not import `Env`
// or anything else from worker/, and every type it uses comes from
// ../shared/types or ../shared/format. That is deliberate (BACKEND-PLAN.md
// section 9, "keep the OpenAI and email calls in thin modules with no
// Cloudflare imports ... they lift to Python almost mechanically").
//
// The caller (the request handler) is responsible for reading the Resend
// API key and the "from" address out of settings/secrets and passing them
// in; this module never reads configuration itself.

import type {
  CriterionScore,
  Metrics,
  QualitativeFeedback,
  TranscriptEntry,
} from "../shared/types";
import { fmtMs } from "../shared/format";

// ---------------------------------------------------------------------
// Resend transport
// ---------------------------------------------------------------------

/**
 * Sends one email through the Resend HTTP API.
 *
 * Throws on a non-2xx response. The thrown message includes the HTTP
 * status and Resend's own `message` field (safe to surface), and never
 * includes `apiKey`.
 */
export interface EmailAttachment {
  filename: string;
  /** File contents, base64-encoded (what Resend's API expects). */
  content: string;
}

export async function sendEmail(
  apiKey: string,
  from: string,
  to: string[],
  subject: string,
  text: string,
  html: string,
  attachments?: EmailAttachment[],
): Promise<void> {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(
      attachments && attachments.length > 0
        ? { from, to, subject, text, html, attachments }
        : { from, to, subject, text, html },
    ),
  });

  if (!res.ok) {
    let message = res.statusText;
    try {
      const body = (await res.json()) as { message?: unknown };
      if (body && typeof body.message === "string" && body.message.length > 0) {
        message = body.message;
      }
    } catch {
      // Resend did not return a JSON error body; fall back to statusText.
    }
    throw new Error(`Resend request failed with status ${res.status}: ${message}`);
  }
}

/**
 * Sends the login-code email for the mailed-6-digit-code auth flow
 * (BACKEND-PLAN.md section 6).
 */
export async function sendLoginCode(
  apiKey: string,
  from: string,
  to: string,
  code: string,
): Promise<void> {
  const subject = "Your interview trainer login code";

  const text = [
    `Your login code is: ${code}`,
    ``,
    `This code is valid for 10 minutes.`,
    ``,
    `If you did not request this code, ignore this message.`,
  ].join("\n");

  const bodyHtml = `
<p style="${P_STYLE}">Your login code is:</p>
<p style="font-family:'Courier New', Courier, monospace; font-size:36px; font-weight:bold; letter-spacing:10px; color:${ACCENT}; margin:24px 0;">${escapeHtml(code)}</p>
<p style="${P_STYLE}">This code is valid for 10 minutes.</p>
<p style="${P_STYLE}">If you did not request this code, ignore this message.</p>
`;

  const html = htmlDocument(subject, bodyHtml);

  await sendEmail(apiKey, from, [to], subject, text, html);
}

// ---------------------------------------------------------------------
// Report emails
// ---------------------------------------------------------------------

/** Everything needed to render a report email, student or instructor copy. */
export interface ReportEmailData {
  studentName: string;
  studentId: string;
  cohort: string | null;
  personaName: string;
  personaTitle: string;
  startedAt: number; // epoch ms
  durationMs: number;
  metrics: Metrics;
  scores: CriterionScore[];
  /** Null when the instructor has switched qualitative feedback off. */
  feedback: QualitativeFeedback | null;
  overall: number | null;
  transcript: TranscriptEntry[];
}

// The two copies of a report must be tellable apart at a glance (instructor
// request, 2026-08-31, after a switched-off assessor address seemed to get
// mail that was in fact the student copy). Three markers, applied everywhere:
// the subject starts with "Your ..." or "Assessor copy:", a labelled band
// opens the body, and the accent color differs — student navy, assessor
// green, the same pairing the app and the dashboard use.
const STUDENT_COPY_LABEL = "Student copy. Sent to the student who did the interview.";
const ASSESSOR_COPY_LABEL = "Assessor copy. Sent only to the assessment recipients, not to the student.";

/** The student's copy of the report. Addressed to the student. */
export function studentReportEmail(
  d: ReportEmailData,
): { subject: string; text: string; html: string } {
  const subject = `Your interview report: ${d.personaName}, ${formatDateOnly(d.startedAt)}`;
  const text = `${STUDENT_COPY_LABEL}\n\n${reportBodyText(d)}`;
  const html = htmlDocument(subject, copyLabelHtml(STUDENT_COPY_LABEL, ACCENT) + reportBodyHtml(d, ACCENT));
  return { subject, text, html };
}

/** The one line the transcript-only student copy carries about the scores. */
const WITHHELD_NOTICE = "Your instructor received the full scored report.";

/**
 * The student's copy when the instructor has switched
 * `share_report_with_student` off: the header block and the transcript, and
 * nothing else. No metrics table, no rubric, no feedback.
 *
 * The data passed in is the same complete `ReportEmailData` the instructor
 * copy is built from. This function selects what the student sees; the
 * caller does not have to hold back a second, thinner object.
 */
export function studentTranscriptEmail(
  d: ReportEmailData,
): { subject: string; text: string; html: string } {
  const subject = `Your interview transcript: ${d.personaName}, ${formatDateOnly(d.startedAt)}`;

  const lines: string[] = [];
  lines.push(STUDENT_COPY_LABEL);
  lines.push(``);
  lines.push(`${d.personaName} (${d.personaTitle})`);
  lines.push(`Student: ${d.studentName}`);
  lines.push(`Date: ${formatDateTime(d.startedAt)}`);
  lines.push(`Duration: ${fmtMs(d.durationMs)}`);
  lines.push(``);
  lines.push(WITHHELD_NOTICE);
  lines.push(``);
  lines.push(`TRANSCRIPT`);
  lines.push(``);
  lines.push(...transcriptTextLines(d));
  const text = lines.join("\n");

  const parts: string[] = [];
  parts.push(copyLabelHtml(STUDENT_COPY_LABEL, ACCENT));
  parts.push(
    `<h1 style="${H1_STYLE}">${escapeHtml(d.personaName)} (${escapeHtml(d.personaTitle)})</h1>`,
  );
  parts.push(`<p style="${P_STYLE}">Student: ${escapeHtml(d.studentName)}</p>`);
  parts.push(`<p style="${P_STYLE}">Date: ${escapeHtml(formatDateTime(d.startedAt))}</p>`);
  parts.push(`<p style="${P_STYLE}">Duration: ${escapeHtml(fmtMs(d.durationMs))}</p>`);
  parts.push(`<p style="${P_STYLE}">${escapeHtml(WITHHELD_NOTICE)}</p>`);
  parts.push(`<h2 style="${h2Style(ACCENT)}">Transcript</h2>`);
  parts.push(...transcriptHtmlParts(d));
  const html = htmlDocument(subject, parts.join("\n"));

  return { subject, text, html };
}

/**
 * The assessor's copy, for the assessment recipients. Same report body as the
 * student version, prefixed with an identity block (student name, id, cohort,
 * persona, start time, duration) so the report is attributable at cohort
 * scale — and marked apart from the student copy in subject, label band and
 * accent color (see the note above STUDENT_COPY_LABEL).
 */
export function instructorReportEmail(
  d: ReportEmailData,
): { subject: string; text: string; html: string } {
  const subject = `Assessor copy: ${d.studentName} (${d.studentId}), ${d.personaName}`;

  const identityTextLines = [
    ASSESSOR_COPY_LABEL,
    ``,
    `Student: ${d.studentName} (${d.studentId})`,
    ...(d.cohort === null ? [] : [`Cohort: ${d.cohort}`]),
    `Persona: ${d.personaName} (${d.personaTitle})`,
    `Started: ${formatDateTime(d.startedAt)}`,
    `Duration: ${fmtMs(d.durationMs)}`,
    ``,
    `----------------------------------------`,
    ``,
  ];
  const text = identityTextLines.join("\n") + reportBodyText(d, false);

  const identityHtml = `
${copyLabelHtml(ASSESSOR_COPY_LABEL, ASSESSOR_ACCENT)}
<h1 style="${H1_STYLE}">${escapeHtml(d.studentName)} (${escapeHtml(d.studentId)})</h1>
${d.cohort === null ? "" : `<p style="${P_STYLE}">Cohort: ${escapeHtml(d.cohort)}</p>`}
<p style="${P_STYLE}">Persona: ${escapeHtml(d.personaName)} (${escapeHtml(d.personaTitle)})</p>
<p style="${P_STYLE}">Started: ${escapeHtml(formatDateTime(d.startedAt))}</p>
<p style="${P_STYLE}">Duration: ${escapeHtml(fmtMs(d.durationMs))}</p>
<hr style="border:none; border-top:1px solid ${BORDER_COLOR}; margin:20px 0;">
`;
  const html = htmlDocument(subject, identityHtml + reportBodyHtml(d, ASSESSOR_ACCENT, false));

  return { subject, text, html };
}

// ---------------------------------------------------------------------
// Report body, shared between the student and instructor emails
// ---------------------------------------------------------------------

function metricsRows(m: Metrics): [string, string][] {
  const talkStudent = Math.round(m.talkRatioStudent * 100);
  const talkInterviewee = 100 - talkStudent;
  return [
    ["Duration", fmtMs(m.durationMs)],
    ["Student speaking time", fmtMs(m.studentSpeakingMs)],
    ["Interviewee speaking time", fmtMs(m.intervieweeSpeakingMs)],
    ["Talk ratio (student : interviewee)", `${talkStudent}% : ${talkInterviewee}%`],
    ["Questions asked", String(m.questionsAsked)],
    ["Student turns / interviewee turns", `${m.studentTurns} / ${m.intervieweeTurns}`],
    ["Words spoken (student / interviewee)", `${m.studentWords} / ${m.intervieweeWords}`],
    ["Average words per student turn", String(m.avgQuestionWords)],
    ["Longest uninterrupted student turn", fmtMs(m.longestStudentMonologueMs)],
  ];
}

/** "n/a" for a null score, `X / max` for a real one. Never renders null as 0. */
function formatScore(score: number | null, max: number): string {
  return score === null ? "n/a" : `${roundTo1(score)} / ${max}`;
}

function roundTo1(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * Points-out-of-possible presentation for the overall line, e.g.
 * "12 / 15 points (80%)". Sums score and max over rows the evaluators could
 * actually assess (score !== null); a not-assessable criterion contributes
 * to neither sum. `pct` prefers the report's own overall percentage and
 * only falls back to computing one locally if that is unavailable. "n/a"
 * when nothing was assessable at all.
 */
function formatOverall(d: ReportEmailData): string {
  const assessed = d.scores.filter((c) => c.score !== null);
  if (assessed.length === 0) return "n/a";
  const points = assessed.reduce((sum, c) => sum + (c.score as number), 0);
  const possible = assessed.reduce((sum, c) => sum + (c.max ?? 5), 0);
  const pct = d.overall ?? Math.round((100 * points) / possible);
  return `${points} / ${possible} points (${pct}%)`;
}

function headerTextLines(d: ReportEmailData): string[] {
  return [
    `${d.personaName} (${d.personaTitle})`,
    `Student: ${d.studentName} (${d.studentId})`,
    `Date: ${formatDateTime(d.startedAt)}`,
    `Duration: ${fmtMs(d.durationMs)}`,
    ``,
  ];
}

function rubricTextLines(d: ReportEmailData): string[] {
  const lines: string[] = [];
  lines.push(`RUBRIC ASSESSMENT`);
  lines.push(``);
  lines.push(`Overall score: ${formatOverall(d)}`);
  lines.push(``);
  for (const c of d.scores) {
    lines.push(`${c.name}: ${formatScore(c.score, c.max ?? 5)}`);
    lines.push(c.justification);
    lines.push(``);
  }
  return lines;
}

function feedbackTextLines(d: ReportEmailData): string[] {
  // With feedback switched off there is no section at all, rather than an
  // empty heading that reads as something having failed.
  const feedback = d.feedback;
  if (!feedback) return [];
  const lines: string[] = [];
  lines.push(`FEEDBACK`);
  lines.push(``);
  lines.push(`Strengths:`);
  feedback.strengths.forEach((s) => lines.push(`- ${s}`));
  lines.push(``);
  lines.push(`Areas to improve:`);
  feedback.improvements.forEach((s) => lines.push(`- ${s}`));
  lines.push(``);
  lines.push(`Notable moments:`);
  feedback.moments.forEach((m) => {
    lines.push(`"${m.quote}"`);
    lines.push(m.comment);
    lines.push(``);
  });
  lines.push(`What you did not reach:`);
  lines.push(feedback.missedDepth);
  lines.push(``);
  lines.push(`Summary:`);
  lines.push(feedback.summary);
  lines.push(``);
  return lines;
}

function reportBodyText(d: ReportEmailData, withHeader = true): string {
  const lines: string[] = [];

  // The assessor copy skips this header: its identity block above already
  // names the persona, the start time and the duration, and saying it twice
  // makes the two copies harder to tell apart, not easier.
  if (withHeader) {
    lines.push(`${d.personaName} (${d.personaTitle})`);
    lines.push(`Date: ${formatDateTime(d.startedAt)}`);
    lines.push(`Duration: ${fmtMs(d.durationMs)}`);
    lines.push(``);
  }

  lines.push(`SPEAKING METRICS`);
  lines.push(``);
  for (const [label, value] of metricsRows(d.metrics)) {
    lines.push(`${label}: ${value}`);
  }
  lines.push(``);

  lines.push(...rubricTextLines(d));
  lines.push(...feedbackTextLines(d));

  lines.push(`TRANSCRIPT`);
  lines.push(``);
  lines.push(...transcriptTextLines(d));

  return lines.join("\n");
}

// ---------------------------------------------------------------------
// Attachments: the transcript and the assessment as two plain-text files
// ---------------------------------------------------------------------

/** UTF-8 text to the base64 form Resend's attachment API expects. */
function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function attachmentDate(d: ReportEmailData): string {
  return new Date(d.startedAt).toISOString().slice(0, 10); // UTC YYYY-MM-DD
}

/**
 * The interview transcript as a standalone .txt file. The assessor's copy
 * carries the student id in the filename, because an assessor saves files
 * from many students and "interview-transcript-<date>.txt" collides on day
 * one; the student's own copy keeps the short name.
 */
export function transcriptAttachment(d: ReportEmailData, forAssessor = false): EmailAttachment {
  const lines = [...headerTextLines(d), `TRANSCRIPT`, ``, ...transcriptTextLines(d), ``];
  return {
    filename: forAssessor
      ? `interview-${d.studentId}-transcript-${attachmentDate(d)}.txt`
      : `interview-transcript-${attachmentDate(d)}.txt`,
    content: toBase64(lines.join("\n")),
  };
}

/** The rubric scores and the qualitative feedback as a standalone .txt file. */
export function assessmentAttachment(d: ReportEmailData, forAssessor = false): EmailAttachment {
  const lines = [...headerTextLines(d), ...rubricTextLines(d), ...feedbackTextLines(d)];
  return {
    filename: forAssessor
      ? `interview-${d.studentId}-assessment-${attachmentDate(d)}.txt`
      : `interview-assessment-${attachmentDate(d)}.txt`,
    content: toBase64(lines.join("\n")),
  };
}

/** The transcript body, shared by the full report and the transcript-only copy. */
function transcriptTextLines(d: ReportEmailData): string[] {
  return d.transcript.map((e) => {
    const speaker = e.speaker === "student" ? "Student" : d.personaName;
    return `[${fmtMs(e.tStart)}, spoke ${fmtMs(e.speechMs)}] ${speaker}: ${e.text}`;
  });
}

function transcriptHtmlParts(d: ReportEmailData): string[] {
  return d.transcript.map((e) => {
    const speaker = e.speaker === "student" ? "Student" : d.personaName;
    return (
      `<p style="${P_STYLE}"><strong>${escapeHtml(speaker)}</strong> ` +
      `<span style="color:#666666;">[${escapeHtml(fmtMs(e.tStart))}, spoke ${escapeHtml(fmtMs(e.speechMs))}]</span><br>` +
      `${escapeHtmlMultiline(e.text)}</p>`
    );
  });
}

function reportBodyHtml(d: ReportEmailData, accent: string, withHeader = true): string {
  const parts: string[] = [];

  // Same rule as reportBodyText: the assessor copy's identity block already
  // carries the persona, the start time and the duration.
  if (withHeader) {
    parts.push(
      `<h1 style="${H1_STYLE}">${escapeHtml(d.personaName)} (${escapeHtml(d.personaTitle)})</h1>`,
    );
    parts.push(`<p style="${P_STYLE}">Date: ${escapeHtml(formatDateTime(d.startedAt))}</p>`);
    parts.push(`<p style="${P_STYLE}">Duration: ${escapeHtml(fmtMs(d.durationMs))}</p>`);
  }

  parts.push(`<h2 style="${h2Style(accent)}">Speaking metrics</h2>`);
  parts.push(`<table style="${TABLE_STYLE}">`);
  for (const [label, value] of metricsRows(d.metrics)) {
    parts.push(
      `<tr><td style="${TD_STYLE}">${escapeHtml(label)}</td><td style="${TD_STYLE}">${escapeHtml(value)}</td></tr>`,
    );
  }
  parts.push(`</table>`);

  parts.push(`<h2 style="${h2Style(accent)}">Rubric assessment</h2>`);
  parts.push(
    `<p style="${P_STYLE}"><strong>Overall score: ${escapeHtml(formatOverall(d))}</strong></p>`,
  );
  parts.push(`<table style="${TABLE_STYLE}">`);
  parts.push(
    `<tr><th style="${TH_STYLE}">Criterion</th><th style="${TH_STYLE}">Score</th><th style="${TH_STYLE}">Justification</th></tr>`,
  );
  for (const c of d.scores) {
    parts.push(
      `<tr><td style="${TD_STYLE}">${escapeHtml(c.name)}</td>` +
        `<td style="${TD_STYLE}">${escapeHtml(formatScore(c.score, c.max ?? 5))}</td>` +
        `<td style="${TD_STYLE}">${escapeHtmlMultiline(c.justification)}</td></tr>`,
    );
  }
  parts.push(`</table>`);

  // Same rule as feedbackTextLines: no section at all when feedback is off.
  const feedback = d.feedback;
  if (feedback) {
    parts.push(`<h2 style="${h2Style(accent)}">Feedback</h2>`);
    parts.push(`<h3 style="${H3_STYLE}">Strengths</h3>`);
    parts.push(
      `<ul style="${P_STYLE}">${feedback.strengths.map((s) => `<li>${escapeHtml(s)}</li>`).join("")}</ul>`,
    );
    parts.push(`<h3 style="${H3_STYLE}">Areas to improve</h3>`);
    parts.push(
      `<ul style="${P_STYLE}">${feedback.improvements.map((s) => `<li>${escapeHtml(s)}</li>`).join("")}</ul>`,
    );
    parts.push(`<h3 style="${H3_STYLE}">Notable moments</h3>`);
    for (const m of feedback.moments) {
      parts.push(`<p style="${QUOTE_STYLE}">&ldquo;${escapeHtmlMultiline(m.quote)}&rdquo;</p>`);
      parts.push(`<p style="${P_STYLE}">${escapeHtmlMultiline(m.comment)}</p>`);
    }
    parts.push(`<h3 style="${H3_STYLE}">What you did not reach</h3>`);
    parts.push(`<p style="${P_STYLE}">${escapeHtmlMultiline(feedback.missedDepth)}</p>`);
    parts.push(`<h3 style="${H3_STYLE}">Summary</h3>`);
    parts.push(`<p style="${P_STYLE}">${escapeHtmlMultiline(feedback.summary)}</p>`);
  }

  parts.push(`<h2 style="${h2Style(accent)}">Transcript</h2>`);
  parts.push(...transcriptHtmlParts(d));

  return parts.join("\n");
}

// ---------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------
//
// Formatted manually with UTC getters rather than `toLocaleString`, so the
// output does not depend on a runtime's default locale/ICU data and lifts
// to Python (`datetime.utcfromtimestamp(...).strftime(...)`) without
// surprises.

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function pad2(n: number): string {
  return n.toString().padStart(2, "0");
}

function formatDateOnly(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

function formatDateTime(ms: number): string {
  const d = new Date(ms);
  return `${formatDateOnly(ms)}, ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())} UTC`;
}

// ---------------------------------------------------------------------
// HTML rendering helpers: minimal semantic HTML, inline styles only,
// matching the app's plain academic design (white background, Georgia
// serif headings, system sans body, accent #1a4a8a, 1px #c8c8c8 borders).
// ---------------------------------------------------------------------

const ACCENT = "#1a4a8a";
// The dashboard's deep green (src/index.css .admin-root --accent, light
// theme). Emails are always rendered light, so the light value is the one
// that matters. Student mail keeps navy; assessor mail goes green — the same
// pairing that keeps the app and the dashboard unconfusable.
const ASSESSOR_ACCENT = "#1f5c4a";
const BORDER_COLOR = "#c8c8c8";
const FONT_SANS =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif";
const FONT_SERIF = "Georgia, 'Times New Roman', serif";

const BODY_STYLE = `font-family:${FONT_SANS}; color:#1a1a1a; font-size:15px; line-height:1.5;`;
const H1_STYLE = `font-family:${FONT_SERIF}; color:#1a1a1a; font-size:22px; font-weight:normal; margin:0 0 4px 0;`;
// The one accent-carrying style, a function so the two copies can differ.
const h2Style = (accent: string) =>
  `font-family:${FONT_SERIF}; color:${accent}; font-size:18px; font-weight:normal; margin:28px 0 8px 0; border-bottom:1px solid ${BORDER_COLOR}; padding-bottom:4px;`;

/** The band that opens every report email and names which copy it is. */
function copyLabelHtml(label: string, accent: string): string {
  return `<p style="font-family:${FONT_SANS}; font-size:12px; letter-spacing:1px; text-transform:uppercase; color:${accent}; border-left:3px solid ${accent}; padding:2px 0 2px 8px; margin:0 0 18px 0;">${escapeHtml(label)}</p>`;
}
const H3_STYLE = `font-family:${FONT_SERIF}; color:#1a1a1a; font-size:15px; font-weight:bold; margin:16px 0 4px 0;`;
const P_STYLE = `margin:6px 0;`;
const TABLE_STYLE = `border-collapse:collapse; width:100%; margin:8px 0;`;
const TD_STYLE = `border:1px solid ${BORDER_COLOR}; padding:6px 10px; text-align:left; vertical-align:top;`;
const TH_STYLE = `${TD_STYLE} background:#f4f4f4; font-family:${FONT_SERIF};`;
const QUOTE_STYLE = `margin:10px 0 2px 0; padding-left:10px; border-left:3px solid ${BORDER_COLOR}; font-style:italic;`;

function htmlDocument(title: string, bodyHtml: string): string {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
</head>
<body style="margin:0; padding:24px; background:#ffffff; ${BODY_STYLE}">
<div style="max-width:680px; margin:0 auto;">
${bodyHtml}
</div>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeHtmlMultiline(value: string): string {
  return escapeHtml(value).replace(/\n/g, "<br>");
}
