export type Speaker = "student" | "interviewee";

export interface TranscriptEntry {
  speaker: Speaker;
  text: string;
  tStart: number; // ms since interview start
  tEnd: number;
  /**
   * How long this turn was actually voiced, in ms — not tEnd - tStart.
   * Measured by the energy-gate speech meter (see liveSession/audio), for
   * both speakers, because WebRTC never hands the app raw samples to sum.
   */
  speechMs: number;
}

export interface SessionResult {
  transcript: TranscriptEntry[];
  startedAt: number; // epoch ms
  endedAt: number;
  intervieweeAudioMs: number; // exact, from received audio sample counts
  studentSpeechMs: number; // measured from the microphone, not from transcript timing
  endedByError?: string;
}

/** A model the student can pick on the setup screen. */
export interface ModelChoice {
  id: string;
  label: string;
  note: string;
}

export interface Persona {
  id: string;
  name: string;
  title: string;
  researchTopic: string;
  shortBio: string;
  /** An OpenAI realtime voice: alloy ash ballad coral echo sage shimmer verse marin cedar. */
  voiceName: string;
  systemInstruction: string;
  /**
   * Ground truth about the persona's layered backstory: what the surface
   * account is and what lay beneath it. Given ONLY to the evaluators of the
   * discovery criteria, which cannot judge whether a student got to the
   * bottom of the story without knowing what the bottom was. Absent for
   * user-written custom personas.
   */
  hiddenCore?: string;
}

export interface Metrics {
  durationMs: number;
  studentSpeakingMs: number;
  intervieweeSpeakingMs: number;
  talkRatioStudent: number; // 0..1
  questionsAsked: number;
  studentWords: number;
  intervieweeWords: number;
  avgQuestionWords: number;
  longestStudentMonologueMs: number;
  studentTurns: number;
  intervieweeTurns: number;
}

export interface CriterionDefinition {
  id: string;
  name: string;
  description: string;
  anchor1: string; // what a score of 1 looks like
  anchor3: string;
  anchor5: string;
  /** Evaluator needs the persona's hidden backstory to judge this. */
  needsGroundTruth?: boolean;
}

export interface CriterionScore {
  id: string;
  name: string;
  /**
   * 1..5, or null when the transcript contains too little of the relevant
   * behaviour to judge. "Not assessable" is not the same as 1: a 1 means the
   * student did the thing badly, null means they never had the chance.
   */
  score: number | null;
  justification: string;
}

export interface QualitativeFeedback {
  strengths: string[];
  improvements: string[];
  moments: { quote: string; comment: string }[];
  missedDepth: string;
  summary: string;
}

/** Persona fields safe to show a student. Never carries instructions or hiddenCore. */
export interface PersonaSummary {
  id: string;
  name: string;
  title: string;
  researchTopic: string;
  shortBio: string;
}

/** Response of POST /api/session. `instructions` is present only if the API could not set them at mint time (it can today, so normally absent). */
export interface SessionResponse {
  token: string;
  expiresAt: number;
  limitMinutes: number;
  warnMinutes: number;
  instructions?: string;
}

/** Body of POST /api/report. */
export interface ReportRequest {
  personaId: string;
  transcript: TranscriptEntry[];
  startedAt: number;
  endedAt: number;
  metrics: Metrics;
}

/** Response of POST /api/report. Scores arrive in rubric order. */
export interface ReportResponse {
  scores: CriterionScore[];
  feedback: QualitativeFeedback;
  overall: number | null;
  emailed: boolean;
}

/** Response of GET /api/me. */
export interface MeResponse {
  studentId: string;
  fullName: string;
}
