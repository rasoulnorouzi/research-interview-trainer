import { Metrics, SessionResult, TranscriptEntry } from "../types";

const INTERROGATIVE_START =
  /^(who|what|when|where|why|how|which|can|could|would|will|do|does|did|is|are|was|were|have|has|tell me|walk me|describe|explain)\b/i;

function words(text: string): number {
  const t = text.trim();
  return t.length === 0 ? 0 : t.split(/\s+/).length;
}

// Heuristic question count: "?" occurrences; a student turn with none but an
// interrogative opening counts as one question.
export function countQuestions(studentEntries: TranscriptEntry[]): number {
  let count = 0;
  for (const e of studentEntries) {
    const marks = (e.text.match(/\?/g) ?? []).length;
    if (marks > 0) count += marks;
    else if (INTERROGATIVE_START.test(e.text.trim())) count += 1;
  }
  return count;
}

export function computeMetrics(result: SessionResult): Metrics {
  const student = result.transcript.filter((e) => e.speaker === "student");
  const interviewee = result.transcript.filter((e) => e.speaker === "interviewee");

  // Student speaking time from input-transcription streaming timestamps;
  // interviewee speaking time is exact (from received audio sample counts).
  const studentSpeakingMs = student.reduce((sum, e) => sum + (e.tEnd - e.tStart), 0);
  const intervieweeSpeakingMs = result.intervieweeAudioMs;
  const totalSpeaking = studentSpeakingMs + intervieweeSpeakingMs;

  const studentWords = student.reduce((sum, e) => sum + words(e.text), 0);
  const intervieweeWords = interviewee.reduce((sum, e) => sum + words(e.text), 0);

  return {
    durationMs: Math.max(0, result.endedAt - result.startedAt),
    studentSpeakingMs,
    intervieweeSpeakingMs,
    talkRatioStudent: totalSpeaking > 0 ? studentSpeakingMs / totalSpeaking : 0,
    questionsAsked: countQuestions(student),
    studentWords,
    intervieweeWords,
    avgQuestionWords: student.length > 0 ? Math.round(studentWords / student.length) : 0,
    longestStudentMonologueMs: student.reduce((max, e) => Math.max(max, e.tEnd - e.tStart), 0),
    studentTurns: student.length,
    intervieweeTurns: interviewee.length,
  };
}

export function fmtMs(ms: number): string {
  const totalSec = Math.round(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}:${sec.toString().padStart(2, "0")}`;
}

export function fmtPercent(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}
