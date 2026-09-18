// The transcript-consent question (instructor request, 2026-09-18).
//
// One definition, used by the student's results screen, the two emails,
// the .txt attachments, the student's Markdown download and the
// dashboard. The wording is the instructor's own and is quoted verbatim
// in every report, so a reader sees exactly what the student agreed to
// rather than a bare "Yes". Change it here and every copy follows.
//
// No imports, so the Worker, the client and the dashboard can all use it.

export const CONSENT_QUESTION_EN =
  "We collect transcripts in order to examine the quality of the feedback of " +
  "the chatbot. Do you consent to the usage of your transcript to increase " +
  "the quality of our chatbot?";

export const CONSENT_QUESTION_NL =
  "We verzamelen transcripten om de kwaliteit van de feedback van de chatbot " +
  "te beoordelen. Geef je toestemming het gebruik van jouw transcript om de " +
  "kwaliteit van onze chatbot te verbeteren?";

/** The two answers, as the student sees them. */
export const CONSENT_YES = "Yes / Ja";
export const CONSENT_NO = "No / Nee";

/**
 * The answer as a report writes it. Null means the interview was stored
 * before the question existed, which is not the same as a refusal.
 */
export function consentAnswer(value: boolean | null): string {
  if (value === null) return "Not asked (this interview is from before the question was added)";
  return value ? "Yes" : "No";
}

/** The short form, for a table cell or a one-line summary. */
export function consentShort(value: boolean | null): string {
  if (value === null) return "Not asked";
  return value ? "Yes" : "No";
}
