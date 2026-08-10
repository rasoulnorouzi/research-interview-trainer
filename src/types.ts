export type Speaker = "student" | "interviewee";

export interface TranscriptEntry {
  speaker: Speaker;
  text: string;
  tStart: number; // ms since interview start
  tEnd: number;
}

export interface SessionResult {
  transcript: TranscriptEntry[];
  startedAt: number; // epoch ms
  endedAt: number;
  intervieweeAudioMs: number; // exact, from received audio sample counts
  endedByError?: string;
}

export interface Persona {
  id: string;
  name: string;
  title: string;
  researchTopic: string;
  shortBio: string;
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
  score: number; // 1..5
  justification: string;
}

export interface QualitativeFeedback {
  strengths: string[];
  improvements: string[];
  moments: { quote: string; comment: string }[];
  missedDepth: string;
  summary: string;
}
