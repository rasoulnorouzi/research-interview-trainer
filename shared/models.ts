// The model ids offered in the instructor dashboard's Settings form
// (BACKEND-PLAN.md §7). Labels and notes are the curated ones the student
// setup screen used before the hosted rewrite moved the choice to the
// instructor, so the tradeoff each model carries is still spelled out.
//
// The interview and scoring lists are UI options only. The server accepts any
// non-empty model string for those (worker/admin.ts putSettings), so adding a
// model OpenAI ships tomorrow is an edit to this list, not an API change, and
// an id typed straight into the database keeps working.
//
// The transcription list is the exception: it IS enforced server-side, like
// persona voices and for the same reason — a transcription model the mint
// call rejects fails at session start, in front of a student (a bad id
// answers 400 at /v1/realtime/client_secrets; verified live 2026-08-31).

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

// The model that turns the student's speech into the live transcript. Only
// models that stream words WHILE the student is speaking may appear here
// (hard design constraint 3): a model that transcribes after the committed
// turn is the exact Gemini-era limitation the OpenAI migration removed.
// Verified live on 2026-08-31 by driving a realtime session with synthesized
// speech and counting `conversation.item.input_audio_transcription.delta`
// events that arrived before the commit: gpt-live-transcribe 31,
// gpt-realtime-whisper 32 — and zero for gpt-transcribe, gpt-4o-transcribe,
// gpt-4o-mini-transcribe and whisper-1, which are therefore not offered.
// Both offered models cost the same per audio minute.
export const TRANSCRIPTION_MODEL_OPTIONS: ModelChoice[] = [
  {
    id: "gpt-live-transcribe",
    label: "Standard (gpt-live-transcribe)",
    note: "Recommended, and the model this app was tested with. Streams each word as it is spoken.",
  },
  {
    id: "gpt-realtime-whisper",
    label: "Whisper family (gpt-realtime-whisper)",
    note: "Also streams while speaking, at the same price. An alternative if the standard model mishears your students.",
  },
];

export const TRANSCRIPTION_MODEL_IDS = TRANSCRIPTION_MODEL_OPTIONS.map((option) => option.id);

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
