import { GoogleGenAI, Type } from "@google/genai";
import {
  CriterionDefinition,
  CriterionScore,
  Persona,
  QualitativeFeedback,
  TranscriptEntry,
} from "../types";
import { fmtMs } from "./metrics";

const SCORING_MODEL = "gemini-3.6-flash";

// The rubric. Each criterion is scored by its own independent model call
// (a fresh context that sees only this criterion and the transcript), so
// scores cannot anchor or halo each other.
export const CRITERIA: CriterionDefinition[] = [
  {
    id: "open_questions",
    name: "Open vs. closed questions",
    description:
      "Did the student favor open invitations ('tell me about…', 'how did you experience…') over yes/no or short-answer questions?",
    anchor1: "Nearly all questions are closed (yes/no, single-fact) — the interviewee has no room to narrate.",
    anchor3: "A mix: some genuine open questions, but frequent closed questions that cut narration short.",
    anchor5: "Consistently open, invitation-style questions that let the interviewee tell their story in their own words.",
  },
  {
    id: "probing",
    name: "Follow-up probing",
    description:
      "Did the student pursue what the interviewee actually said with depth probes ('you mentioned X — what was that like?') rather than jumping to the next prepared topic?",
    anchor1: "No follow-ups; the student moves to a new topic after every answer regardless of content.",
    anchor3: "Occasional follow-ups, but important disclosures are regularly left unexplored.",
    anchor5: "Systematically picks up the interviewee's own words and probes deeper before moving on.",
  },
  {
    id: "cue_pursuit",
    name: "Noticing and pursuing cues",
    description:
      "The interviewee repeatedly dropped small cues at the edge of things they had not yet disclosed: hesitations, half-finished sentences, qualifiers such as 'mostly' or 'it wasn't really the hours', deflecting jokes, and abrupt topic changes. Did the student notice these and follow them, rather than accepting the answer and moving on?",
    anchor1:
      "Every cue is missed or talked over; the student proceeds through their own agenda as though the interviewee had said nothing unusual.",
    anchor3:
      "One or two cues are picked up, but several clear openings are left on the table.",
    anchor5:
      "Consistently catches hesitations, unfinished sentences and evasions and gently returns to them — including naming a deflection when it occurs.",
    needsGroundTruth: true,
  },
  {
    id: "depth_reached",
    name: "Depth of discovery",
    description:
      "The interviewee was role-played with a layered account: a rehearsed surface story they give anyone, a more personal middle layer, and a genuine underlying reason disclosed only to an interviewer who earns it. How far did the student actually get, and did they identify the real problem rather than the presented one?",
    anchor1:
      "The student never left the rehearsed surface account and finished the interview believing the presented reason was the whole story.",
    anchor3:
      "The student reached the middle layer — the personal cost and specific incidents — but never approached the underlying reason.",
    anchor5:
      "The student reached the underlying reason and recognised it for what it was, arriving there through the interviewee's own disclosures rather than by guessing or asserting it.",
    needsGroundTruth: true,
  },
  {
    id: "leading",
    name: "Avoiding leading questions",
    description:
      "Did the student avoid embedding assumptions, interpretations, or desired answers in their questions ('So you must have felt abandoned, right?')?",
    anchor1: "Questions routinely put words in the interviewee's mouth or presuppose the answer.",
    anchor3: "Mostly neutral phrasing with several leading or assumption-loaded questions.",
    anchor5: "Questions are neutrally phrased throughout; interpretations are checked, not imposed.",
  },
  {
    id: "rapport",
    name: "Rapport and creating safety",
    description:
      "Did the student build conditions in which a guarded person would risk saying something they had not planned to say: appropriate acknowledgments, unhurried pacing, tolerating silence, and giving space after a difficult disclosure instead of rushing to the next question?",
    anchor1: "Mechanical interrogation; difficult disclosures are ignored, tidied away, or talked over.",
    anchor3: "Polite but somewhat detached; acknowledgments are formulaic and pacing is brisk.",
    anchor5:
      "Warm and attentive; sensitive moments are acknowledged and given room, and the interviewee visibly opens up as a result.",
  },
  {
    id: "neutrality",
    name: "Neutrality and non-judgment",
    description:
      "Did the student refrain from evaluating, advising, moralizing, or agreeing/disagreeing with the interviewee's choices?",
    anchor1: "Repeatedly judges, advises, or debates the interviewee.",
    anchor3: "Mostly neutral but occasionally slips into opinions or advice.",
    anchor5: "Fully non-judgmental stance; the interviewee's account is explored, never evaluated.",
  },
  {
    id: "structure",
    name: "Interview structure",
    description:
      "Was there a recognizable opening (introduction, easing in), a logical topic flow, and a proper closing ('is there anything you'd like to add?', thanks)?",
    anchor1: "No discernible opening or closing; topics jump around arbitrarily.",
    anchor3: "Some structure, but an abrupt start or ending, or disorganized topic flow.",
    anchor5: "Clear opening, coherent progression between topics, and a respectful closing.",
  },
];

function isModelNotFound(err: unknown): boolean {
  const raw = err instanceof Error ? err.message : String(err);
  return /not found|NOT_FOUND|\b404\b/i.test(raw);
}

/**
 * Asked once per page load, and only when a call has already failed with
 * "model not found": which models can this key actually reach? Google renames
 * models between semesters, and without this the instructor sees an opaque
 * failure with no way to work out the replacement.
 */
let modelHintPromise: Promise<string> | null = null;
function availableModelHint(ai: GoogleGenAI): Promise<string> {
  modelHintPromise ??= (async () => {
    try {
      const pager = await ai.models.list({ config: { pageSize: 100 } });
      const names: string[] = [];
      for await (const m of pager) {
        const name = (m.name ?? "").replace(/^models\//, "");
        if (!name) continue;
        if (m.supportedActions && !m.supportedActions.includes("generateContent")) continue;
        names.push(name);
      }
      if (names.length === 0) return "";
      return ` Models this key can use for scoring: ${names.join(", ")}.`;
    } catch {
      return "";
    }
  })();
  return modelHintPromise;
}

/** generateContent, with the model list attached if the model name is wrong. */
async function generateWithDiagnostics(
  ai: GoogleGenAI,
  params: Parameters<GoogleGenAI["models"]["generateContent"]>[0]
) {
  try {
    return await ai.models.generateContent(params);
  } catch (err) {
    if (isModelNotFound(err)) {
      const hint = await availableModelHint(ai);
      throw new Error(`${err instanceof Error ? err.message : String(err)}${hint}`);
    }
    throw err;
  }
}

/**
 * Turn whatever the SDK threw into something the user can act on. Swallowing
 * these into a bare "Scoring failed." hid the difference between a rejected
 * key, a model the key cannot reach, and a rate limit — all of which need
 * different responses from the user.
 */
export function describeScoringError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  if (/API key not valid|API_KEY_INVALID|PERMISSION_DENIED|\b401\b|\b403\b/i.test(raw)) {
    return `Your API key was rejected for scoring, though the interview itself worked. Check that the key has access to the Gemini API. (${raw})`;
  }
  if (/not found|NOT_FOUND|\b404\b/i.test(raw)) {
    return `The scoring model "${SCORING_MODEL}" is not available to this API key. The interview model works, so the key is fine — this model name needs changing in src/lib/scoring.ts. (${raw})`;
  }
  if (/quota|RESOURCE_EXHAUSTED|\b429\b/i.test(raw)) {
    return `Gemini rate-limited the scoring calls. Wait a moment, then retry. (${raw})`;
  }
  if (/JSON|Unexpected token/i.test(raw)) {
    return `The evaluator returned something that was not valid JSON. Retrying usually fixes this. (${raw})`;
  }
  return raw;
}

export function formatTranscript(transcript: TranscriptEntry[], personaName: string): string {
  return transcript
    .map(
      (e) =>
        `[${fmtMs(e.tStart)}] ${e.speaker === "student" ? "STUDENT" : `INTERVIEWEE (${personaName})`}: ${e.text}`
    )
    .join("\n");
}

const COMMON_PREAMBLE = (persona: Persona, transcriptText: string) => `You are an expert instructor in qualitative research methods evaluating a student's practice interview. The interviewee was a role-played persona: ${persona.name}, ${persona.title}. Research topic: ${persona.researchTopic}.

The persona was written with a layered account: a rehearsed surface story given to anyone, a more personal middle layer, and an underlying reason disclosed only to an interviewer who earns it through patient, non-judgmental, cue-following questioning. A shallow interview is therefore the expected default, not an anomaly.

Evaluate ONLY the student's interviewing technique, not the interviewee's answers. The transcript comes from automatic speech transcription; ignore transcription artifacts and do not penalize them. If the interview is very short (fewer than 4 student turns), evaluate what is present.

TRANSCRIPT:
${transcriptText}`;

// Ground truth is supplied only to the criteria that cannot be judged without
// it: whether the student pursued the planted cues, and how deep they got.
// This is knowledge of the scenario, not knowledge of other scores, so it does
// not reintroduce the anchoring bias the per-criterion isolation prevents.
function groundTruthBlock(persona: Persona): string {
  if (!persona.hiddenCore) {
    return `
WHAT THERE WAS TO DISCOVER:
This persona was written by the instructor, so no reference description of its hidden layers is available. Judge depth from the transcript itself: how far the interviewee moved from generic, rehearsed-sounding answers toward specific, personal, reluctantly given material, and how much of that movement the student caused.`;
  }
  return `
WHAT THERE WAS TO DISCOVER (reference description of the role-played backstory; the student did NOT have this):
${persona.hiddenCore}

Judge only what the transcript shows the student actually reached and understood. Do not credit them for material the interviewee never disclosed.`;
}

async function scoreOneCriterion(
  ai: GoogleGenAI,
  criterion: CriterionDefinition,
  persona: Persona,
  transcriptText: string
): Promise<CriterionScore> {
  const prompt = `${COMMON_PREAMBLE(persona, transcriptText)}
${criterion.needsGroundTruth ? groundTruthBlock(persona) : ""}

Score the student on exactly ONE criterion:

CRITERION: ${criterion.name}
${criterion.description}

Score anchors:
1 = ${criterion.anchor1}
3 = ${criterion.anchor3}
5 = ${criterion.anchor5}
(2 and 4 are intermediate.)

IF THERE IS NOT ENOUGH TO JUDGE: return a score of 0. A score of 0 means "not assessable" — the interview never contained enough of the relevant behaviour to form a view (for example it ended after a turn or two, or the student never got far enough for this criterion to apply). Absence of evidence is NOT poor performance: do not award a 1 because the student had no opportunity. A 1 is for a student who did this badly, not for one who barely spoke. When you return 0, use the justification to say what would have been needed to assess it.

Otherwise give an integer score from 1 to 5 and a justification of at most two sentences that references what the student actually said.`;

  const response = await generateWithDiagnostics(ai, {
    model: SCORING_MODEL,
    contents: prompt,
    config: {
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          score: { type: Type.INTEGER },
          justification: { type: Type.STRING },
        },
        required: ["score", "justification"],
      },
      temperature: 0.2,
    },
  });

  const parsed = JSON.parse(response.text ?? "") as { score: number; justification: string };
  const raw = Math.round(Number(parsed.score));
  return {
    id: criterion.id,
    name: criterion.name,
    // 0 (or anything below 1) means the evaluator judged this not assessable.
    score: Number.isFinite(raw) && raw >= 1 ? Math.min(5, raw) : null,
    justification: String(parsed.justification ?? ""),
  };
}

async function getQualitativeFeedback(
  ai: GoogleGenAI,
  persona: Persona,
  transcriptText: string
): Promise<QualitativeFeedback> {
  const prompt = `${COMMON_PREAMBLE(persona, transcriptText)}
${groundTruthBlock(persona)}

Provide qualitative feedback on the student's interviewing technique (do NOT give numeric scores):
- "strengths": 2 to 4 concrete things the student did well.
- "improvements": 2 to 4 concrete, actionable things to do differently next time. Where the student missed a cue the interviewee dropped, name the cue and say what could have been asked instead.
- "moments": 2 to 3 short verbatim excerpts of STUDENT speech from the transcript (max ~25 words each) — at least one strong moment and at least one missed opening — each with a one-sentence comment.
- "missedDepth": what remained undiscovered, and the specific opening that could have got there. Address the student directly and describe the undisclosed material only in general terms — enough to show what was at stake without handing over the whole story, since they may interview this person again. If the student reached the underlying reason, say so here instead.
- "summary": a 2-3 sentence overall impression addressed to the student.`;

  const response = await generateWithDiagnostics(ai, {
    model: SCORING_MODEL,
    contents: prompt,
    config: {
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          strengths: { type: Type.ARRAY, items: { type: Type.STRING } },
          improvements: { type: Type.ARRAY, items: { type: Type.STRING } },
          moments: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                quote: { type: Type.STRING },
                comment: { type: Type.STRING },
              },
              required: ["quote", "comment"],
            },
          },
          missedDepth: { type: Type.STRING },
          summary: { type: Type.STRING },
        },
        required: ["strengths", "improvements", "moments", "missedDepth", "summary"],
      },
      temperature: 0.4,
    },
  });

  const parsed = JSON.parse(response.text ?? "") as QualitativeFeedback;
  return {
    strengths: (parsed.strengths ?? []).map(String),
    improvements: (parsed.improvements ?? []).map(String),
    moments: (parsed.moments ?? []).map((m) => ({
      quote: String(m.quote ?? ""),
      comment: String(m.comment ?? ""),
    })),
    missedDepth: String(parsed.missedDepth ?? ""),
    summary: String(parsed.summary ?? ""),
  };
}

export interface ScoringHandles {
  // One independent promise per criterion, plus one for qualitative feedback.
  criterionPromises: Map<string, Promise<CriterionScore>>;
  feedbackPromise: Promise<QualitativeFeedback>;
}

// Launches all evaluator calls in parallel. Each criterion gets a fresh,
// independent model context that sees only the transcript and that single
// criterion — no other criteria, no other scores — to avoid anchoring bias.
// The qualitative call likewise never sees any numeric scores.
export function startScoring(
  apiKey: string,
  transcript: TranscriptEntry[],
  persona: Persona
): ScoringHandles {
  const ai = new GoogleGenAI({ apiKey });
  const transcriptText = formatTranscript(transcript, persona.name);
  const criterionPromises = new Map<string, Promise<CriterionScore>>();
  for (const criterion of CRITERIA) {
    criterionPromises.set(criterion.id, scoreOneCriterion(ai, criterion, persona, transcriptText));
  }
  return {
    criterionPromises,
    feedbackPromise: getQualitativeFeedback(ai, persona, transcriptText),
  };
}

export function retryCriterion(
  apiKey: string,
  transcript: TranscriptEntry[],
  persona: Persona,
  criterionId: string
): Promise<CriterionScore> {
  const criterion = CRITERIA.find((c) => c.id === criterionId);
  if (!criterion) return Promise.reject(new Error(`Unknown criterion: ${criterionId}`));
  const ai = new GoogleGenAI({ apiKey });
  return scoreOneCriterion(ai, criterion, persona, formatTranscript(transcript, persona.name));
}

export function retryFeedback(
  apiKey: string,
  transcript: TranscriptEntry[],
  persona: Persona
): Promise<QualitativeFeedback> {
  const ai = new GoogleGenAI({ apiKey });
  return getQualitativeFeedback(ai, persona, formatTranscript(transcript, persona.name));
}
