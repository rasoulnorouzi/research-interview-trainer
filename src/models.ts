import { ModelChoice } from "./types";

/**
 * The two model choices offered on the setup screen. Both are shown with their
 * cost/quality tradeoff because the student is spending their own API credit.
 *
 * Verified available on 2026-08-10 via GET /v1/models. If OpenAI retires one,
 * the scoring error path lists what a key can actually reach.
 */

// The interviewee's voice. This is the dominant cost of a session and the main
// lever on whether the layered persona holds up under questioning.
export const INTERVIEW_MODELS: ModelChoice[] = [
  {
    id: "gpt-realtime-2.1-mini",
    label: "Standard (gpt-realtime-2.1-mini)",
    note: "Roughly a quarter of the cost. Fine for practising technique.",
  },
  {
    id: "gpt-realtime-2.1",
    label: "High fidelity (gpt-realtime-2.1)",
    note: "Holds character more reliably under difficult questioning. Costs about 3× more.",
  },
];

// The eight rubric evaluators plus the feedback call. Cheap at any tier next to
// the audio, so this is a quality choice more than a cost one.
export const SCORING_MODELS: ModelChoice[] = [
  {
    id: "gpt-5.6-terra",
    label: "Balanced (gpt-5.6-terra)",
    note: "Recommended. Sound rubric judgement at moderate cost.",
  },
  {
    id: "gpt-5.6-sol",
    label: "Most thorough (gpt-5.6-sol)",
    note: "Best at the depth and cue-pursuit criteria, which need real reasoning.",
  },
  {
    id: "gpt-5.6-luna",
    label: "Economical (gpt-5.6-luna)",
    note: "Cheapest. More willing to mark a criterion 'not assessable'.",
  },
];

export const DEFAULT_INTERVIEW_MODEL = INTERVIEW_MODELS[0].id;
export const DEFAULT_SCORING_MODEL = SCORING_MODELS[0].id;
