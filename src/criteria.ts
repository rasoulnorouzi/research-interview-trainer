/**
 * The scoring rubric, authored here as the ultimate restore for the built-in
 * criteria, the same role src/personas.ts plays for personas. This file is
 * read only by worker/genseed-criteria.ts (Node, not the Worker) to
 * regenerate seed-criteria.sql; the Worker and the client read the rubric
 * from D1, not from here. Never import this file from Worker or client
 * runtime code.
 *
 * `RubricCriterion` is defined locally rather than in shared/types.ts: a
 * later task moves the shared shape, this one only establishes the seed
 * origin and the D1 tables it feeds.
 */

export interface RubricCriterion {
  id: string;
  name: string;
  description: string;
  anchorLow: string;
  anchorMid: string;
  anchorHigh: string;
  scaleMax: number;
  needsGroundTruth?: boolean;
}

export const CRITERIA: RubricCriterion[] = [
  {
    id: "open_questions",
    name: "Open vs. closed questions",
    description:
      "Did the student favor open invitations ('tell me about…', 'how did you experience…') over yes/no or short-answer questions?",
    anchorLow: "Nearly all questions are closed (yes/no, single-fact), leaving the interviewee no room to narrate.",
    anchorMid: "A mix: some genuine open questions, but frequent closed questions that cut narration short.",
    anchorHigh: "Consistently open, invitation-style questions that let the interviewee tell their story in their own words.",
    scaleMax: 5,
  },
  {
    id: "probing",
    name: "Follow-up probing",
    description:
      "Did the student pursue what the interviewee actually said with depth probes ('you mentioned X, what was that like?') rather than jumping to the next prepared topic?",
    anchorLow: "No follow-ups; the student moves to a new topic after every answer regardless of content.",
    anchorMid: "Occasional follow-ups, but important disclosures are regularly left unexplored.",
    anchorHigh: "Systematically picks up the interviewee's own words and probes deeper before moving on.",
    scaleMax: 5,
  },
  {
    id: "cue_pursuit",
    name: "Noticing and pursuing cues",
    description:
      "The interviewee repeatedly dropped small cues at the edge of things they had not yet disclosed: hesitations, half-finished sentences, qualifiers such as 'mostly' or 'it wasn't really the hours', deflecting jokes, and abrupt topic changes. Did the student notice these and follow them, rather than accepting the answer and moving on?",
    anchorLow:
      "Every cue is missed or talked over; the student proceeds through their own agenda as though the interviewee had said nothing unusual.",
    anchorMid:
      "One or two cues are picked up, but several clear openings are left on the table.",
    anchorHigh:
      "Consistently catches hesitations, unfinished sentences and evasions and gently returns to them, including naming a deflection when it occurs.",
    scaleMax: 5,
    needsGroundTruth: true,
  },
  {
    id: "depth_reached",
    name: "Depth of discovery",
    description:
      "The interviewee was role-played with a layered account: a rehearsed surface story they give anyone, a more personal middle layer, and a genuine underlying reason disclosed only to an interviewer who earns it. How far did the student actually get, and did they identify the real problem rather than the presented one?",
    anchorLow:
      "The student never left the rehearsed surface account and finished the interview believing the presented reason was the whole story.",
    anchorMid:
      "The student reached the middle layer, the personal cost and specific incidents, but never approached the underlying reason.",
    anchorHigh:
      "The student reached the underlying reason and recognised it for what it was, arriving there through the interviewee's own disclosures rather than by guessing or asserting it.",
    scaleMax: 5,
    needsGroundTruth: true,
  },
  {
    id: "leading",
    name: "Avoiding leading questions",
    description:
      "Did the student avoid embedding assumptions, interpretations, or desired answers in their questions ('So you must have felt abandoned, right?')?",
    anchorLow: "Questions routinely put words in the interviewee's mouth or presuppose the answer.",
    anchorMid: "Mostly neutral phrasing with several leading or assumption-loaded questions.",
    anchorHigh: "Questions are neutrally phrased throughout; interpretations are checked, not imposed.",
    scaleMax: 5,
  },
  {
    id: "rapport",
    name: "Rapport and creating safety",
    description:
      "Did the student build conditions in which a guarded person would risk saying something they had not planned to say: appropriate acknowledgments, unhurried pacing, tolerating silence, and giving space after a difficult disclosure instead of rushing to the next question?",
    anchorLow: "Mechanical interrogation; difficult disclosures are ignored, tidied away, or talked over.",
    anchorMid: "Polite but somewhat detached; acknowledgments are formulaic and pacing is brisk.",
    anchorHigh:
      "Warm and attentive; sensitive moments are acknowledged and given room, and the interviewee visibly opens up as a result.",
    scaleMax: 5,
  },
  {
    id: "neutrality",
    name: "Neutrality and non-judgment",
    description:
      "Did the student refrain from evaluating, advising, moralizing, or agreeing/disagreeing with the interviewee's choices?",
    anchorLow: "Repeatedly judges, advises, or debates the interviewee.",
    anchorMid: "Mostly neutral but occasionally slips into opinions or advice.",
    anchorHigh: "Fully non-judgmental stance; the interviewee's account is explored, never evaluated.",
    scaleMax: 5,
  },
  {
    id: "structure",
    name: "Interview structure",
    description:
      "Was there a recognizable opening (introduction, easing in), a logical topic flow, and a proper closing ('is there anything you'd like to add?', thanks)?",
    anchorLow: "No discernible opening or closing; topics jump around arbitrarily.",
    anchorMid: "Some structure, but an abrupt start or ending, or disorganized topic flow.",
    anchorHigh: "Clear opening, coherent progression between topics, and a respectful closing.",
    scaleMax: 5,
  },
];
