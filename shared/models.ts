// The model ids offered in the instructor dashboard's Settings form
// (BACKEND-PLAN.md §7). Labels and notes are the curated ones the student
// setup screen used before the hosted rewrite moved the choice to the
// instructor, so the tradeoff each model carries is still spelled out.
//
// UI options only. The server accepts any non-empty model string
// (worker/admin.ts putSettings), so adding a model OpenAI ships tomorrow is an
// edit to this list, not an API change, and an id typed straight into the
// database keeps working.

import type { ModelChoice } from "./types";

// The interviewee's voice. This is the dominant cost of a session and the main
// lever on whether the layered persona holds up under questioning.
export const INTERVIEW_MODEL_OPTIONS: ModelChoice[] = [
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
export const SCORING_MODEL_OPTIONS: ModelChoice[] = [
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
