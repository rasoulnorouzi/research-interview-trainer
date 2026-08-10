export type Speaker = "student" | "interviewee";

export interface TranscriptEntry {
  speaker: Speaker;
  text: string;
  tStart: number; // ms since interview start
  tEnd: number;
  /**
   * How long this turn was actually voiced, in ms — not tEnd - tStart.
   * For the student it is measured from the microphone (see liveSession's
   * energy gate), because Gemini delivers input transcription in one blob
   * after the utterance ends, which would make every student turn 0 ms long.
   * For the interviewee it is the summed duration of that turn's audio.
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
