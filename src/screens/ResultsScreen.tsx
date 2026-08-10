import { useEffect, useMemo, useState } from "react";
import {
  CriterionScore,
  Metrics,
  Persona,
  QualitativeFeedback,
  SessionResult,
} from "../types";
import { computeMetrics, fmtMs, fmtPercent } from "../lib/metrics";
import {
  CRITERIA,
  describeScoringError,
  retryCriterion,
  retryFeedback,
  startScoring,
} from "../lib/scoring";

interface Props {
  result: SessionResult;
  apiKey: string;
  persona: Persona;
  scoringModel: string;
  onNewInterview: () => void;
}

type CriterionState =
  | { status: "loading" }
  | { status: "done"; score: CriterionScore }
  | { status: "error"; message: string };

type FeedbackState =
  | { status: "loading" }
  | { status: "done"; feedback: QualitativeFeedback }
  | { status: "error"; message: string };

export function ResultsScreen({ result, apiKey, persona, scoringModel, onNewInterview }: Props) {
  const metrics = useMemo(() => computeMetrics(result), [result]);
  const [criterionStates, setCriterionStates] = useState<Record<string, CriterionState>>(
    () => Object.fromEntries(CRITERIA.map((c) => [c.id, { status: "loading" }]))
  );
  const [feedbackState, setFeedbackState] = useState<FeedbackState>({ status: "loading" });

  const setCriterion = (id: string, state: CriterionState) =>
    setCriterionStates((prev) => ({ ...prev, [id]: state }));

  useEffect(() => {
    const handles = startScoring(apiKey, result.transcript, persona, scoringModel);
    for (const [id, promise] of handles.criterionPromises) {
      promise
        .then((score) => setCriterion(id, { status: "done", score }))
        .catch((err) => setCriterion(id, { status: "error", message: describeScoringError(err) }));
    }
    handles.feedbackPromise
      .then((feedback) => setFeedbackState({ status: "done", feedback }))
      .catch((err) => setFeedbackState({ status: "error", message: describeScoringError(err) }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleRetryCriterion = (id: string) => {
    setCriterion(id, { status: "loading" });
    retryCriterion(apiKey, result.transcript, persona, id, scoringModel)
      .then((score) => setCriterion(id, { status: "done", score }))
      .catch((err) => setCriterion(id, { status: "error", message: describeScoringError(err) }));
  };

  const handleRetryFeedback = () => {
    setFeedbackState({ status: "loading" });
    retryFeedback(apiKey, result.transcript, persona, scoringModel)
      .then((feedback) => setFeedbackState({ status: "done", feedback }))
      .catch((err) => setFeedbackState({ status: "error", message: describeScoringError(err) }));
  };

  const settled = CRITERIA.map((c) => criterionStates[c.id]).filter(
    (s) => s.status !== "loading"
  );
  // Not-assessable criteria are excluded from the mean rather than counted as
  // zero — a criterion the interview gave no chance to demonstrate should not
  // drag the average down.
  const numericScores = CRITERIA.map((c) => criterionStates[c.id])
    .filter((s): s is Extract<CriterionState, { status: "done" }> => s.status === "done")
    .map((s) => s.score.score)
    .filter((n): n is number => n !== null);
  const overall =
    settled.length === CRITERIA.length && numericScores.length > 0
      ? (numericScores.reduce((a, b) => a + b, 0) / numericScores.length).toFixed(1)
      : null;
  const notAssessedCount = settled.length - numericScores.length;

  const downloadMarkdown = () => {
    const md = buildMarkdownReport(result, metrics, persona, criterionStates, feedbackState, overall);
    const blob = new Blob([md], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `interview-report-${new Date(result.startedAt).toISOString().slice(0, 10)}.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div>
      <h1>Interview Report</h1>
      <p className="lede">
        {persona.name} — {persona.researchTopic}
        <br />
        {new Date(result.startedAt).toLocaleString()} · Duration{" "}
        {fmtMs(metrics.durationMs)}
      </p>

      {result.endedByError && (
        <div className="banner-info">
          Note: the interview ended early due to a connection problem. The report
          covers the recorded portion.
        </div>
      )}

      <h2>Speaking metrics</h2>
      <table>
        <tbody>
          <tr>
            <th>Total duration</th>
            <td className="num">{fmtMs(metrics.durationMs)}</td>
          </tr>
          <tr>
            <th>Your speaking time</th>
            <td className="num">
              {fmtMs(metrics.studentSpeakingMs)}
              {metrics.studentTurns > 0 && (
                <span className="small">
                  {" "}
                  ({metrics.studentTurns} turns, avg{" "}
                  {fmtMs(metrics.studentSpeakingMs / metrics.studentTurns)})
                </span>
              )}
            </td>
          </tr>
          <tr>
            <th>Interviewee speaking time</th>
            <td className="num">
              {fmtMs(metrics.intervieweeSpeakingMs)}
              {metrics.intervieweeTurns > 0 && (
                <span className="small">
                  {" "}
                  ({metrics.intervieweeTurns} turns, avg{" "}
                  {fmtMs(metrics.intervieweeSpeakingMs / metrics.intervieweeTurns)})
                </span>
              )}
            </td>
          </tr>
          <tr>
            <th>Silence / thinking time</th>
            <td className="num">
              {fmtMs(
                Math.max(
                  0,
                  metrics.durationMs -
                    metrics.studentSpeakingMs -
                    metrics.intervieweeSpeakingMs
                )
              )}
            </td>
          </tr>
          <tr>
            <th>Talk ratio (you : interviewee)</th>
            <td className="num">
              {fmtPercent(metrics.talkRatioStudent)} :{" "}
              {fmtPercent(1 - metrics.talkRatioStudent)}
            </td>
          </tr>
          <tr>
            <th>Questions asked</th>
            <td className="num">{metrics.questionsAsked}</td>
          </tr>
          <tr>
            <th>Your turns / interviewee turns</th>
            <td className="num">
              {metrics.studentTurns} / {metrics.intervieweeTurns}
            </td>
          </tr>
          <tr>
            <th>Words spoken (you / interviewee)</th>
            <td className="num">
              {metrics.studentWords} / {metrics.intervieweeWords}
            </td>
          </tr>
          <tr>
            <th>Average words per turn (you)</th>
            <td className="num">{metrics.avgQuestionWords}</td>
          </tr>
          <tr>
            <th>Longest uninterrupted turn (you)</th>
            <td className="num">{fmtMs(metrics.longestStudentMonologueMs)}</td>
          </tr>
        </tbody>
      </table>
      <p className="small">
        In qualitative interviewing the interviewee should generally do most of
        the talking; a common guideline is an interviewer share below 30%.
      </p>

      <h2>Rubric assessment</h2>
      <p className="small">
        Each criterion is scored 1–5 by an independent evaluator that sees only
        the transcript and that single criterion, to avoid anchoring bias
        between scores. A criterion the interview gave no opportunity to
        demonstrate is marked <strong>n/a</strong> rather than scored low, and
        is left out of the overall figure.
      </p>
      {overall && (
        <p className="overall-score">
          Overall score: {overall} / 5
          {notAssessedCount > 0 && (
            <span className="small">
              {" "}
              (over {CRITERIA.length - notAssessedCount} of {CRITERIA.length}{" "}
              criteria; {notAssessedCount} not assessable)
            </span>
          )}
        </p>
      )}
      <table>
        <thead>
          <tr>
            <th>Criterion</th>
            <th>Score</th>
            <th>Justification</th>
          </tr>
        </thead>
        <tbody>
          {CRITERIA.map((c) => {
            const state = criterionStates[c.id];
            return (
              <tr key={c.id}>
                <td>{c.name}</td>
                {state.status === "done" ? (
                  <>
                    <td className="score-cell">
                      {state.score.score === null ? (
                        <span className="not-assessed">n/a</span>
                      ) : (
                        `${state.score.score} / 5`
                      )}
                    </td>
                    <td>{state.score.justification}</td>
                  </>
                ) : state.status === "loading" ? (
                  <td colSpan={2} className="small">
                    Scoring…
                  </td>
                ) : (
                  <td colSpan={2}>
                    <span className="small">{state.message} </span>
                    <button
                      className="btn btn-secondary no-print"
                      onClick={() => handleRetryCriterion(c.id)}
                    >
                      Retry
                    </button>
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>

      <h2>Feedback</h2>
      {feedbackState.status === "loading" && <p className="small">Preparing feedback…</p>}
      {feedbackState.status === "error" && (
        <p>
          <span className="small">{feedbackState.message} </span>
          <button className="btn btn-secondary no-print" onClick={handleRetryFeedback}>
            Retry
          </button>
        </p>
      )}
      {feedbackState.status === "done" && (
        <div>
          <h3>Strengths</h3>
          <ul>
            {feedbackState.feedback.strengths.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ul>
          <h3>Areas to improve</h3>
          <ul>
            {feedbackState.feedback.improvements.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ul>
          <h3>Notable moments</h3>
          {feedbackState.feedback.moments.map((m, i) => (
            <div key={i}>
              <blockquote>“{m.quote}”</blockquote>
              <p className="small">{m.comment}</p>
            </div>
          ))}
          <h3>What you did not reach</h3>
          <p>{feedbackState.feedback.missedDepth}</p>
          <h3>Summary</h3>
          <p>{feedbackState.feedback.summary}</p>
        </div>
      )}

      <h2>Transcript</h2>
      <div className="transcript">
        {result.transcript.map((e, i) => (
          <div className="entry" key={i}>
            <span className={`speaker ${e.speaker}`}>
              {e.speaker === "student" ? "You" : persona.name}
              <span className="t">
                {fmtMs(e.tStart)} · spoke {fmtMs(e.speechMs)}
              </span>
            </span>
            <div>{e.text}</div>
          </div>
        ))}
      </div>

      <div className="btn-row no-print">
        <button className="btn btn-secondary" onClick={() => window.print()}>
          Print / save as PDF
        </button>
        <button className="btn btn-secondary" onClick={downloadMarkdown}>
          Download report (.md)
        </button>
        <button className="btn" onClick={onNewInterview}>
          New interview
        </button>
      </div>
    </div>
  );
}

function buildMarkdownReport(
  result: SessionResult,
  metrics: Metrics,
  persona: Persona,
  criterionStates: Record<string, CriterionState>,
  feedbackState: FeedbackState,
  overall: string | null
): string {
  const lines: string[] = [];
  lines.push(`# Interview Report`);
  lines.push(``);
  lines.push(`- Interviewee: ${persona.name} (${persona.title})`);
  lines.push(`- Research topic: ${persona.researchTopic}`);
  lines.push(`- Date: ${new Date(result.startedAt).toLocaleString()}`);
  lines.push(`- Duration: ${fmtMs(metrics.durationMs)}`);
  lines.push(``);
  lines.push(`## Speaking metrics`);
  lines.push(``);
  lines.push(`| Metric | Value |`);
  lines.push(`| --- | --- |`);
  lines.push(`| Your speaking time | ${fmtMs(metrics.studentSpeakingMs)} |`);
  lines.push(`| Interviewee speaking time | ${fmtMs(metrics.intervieweeSpeakingMs)} |`);
  lines.push(
    `| Silence / thinking time | ${fmtMs(Math.max(0, metrics.durationMs - metrics.studentSpeakingMs - metrics.intervieweeSpeakingMs))} |`
  );
  lines.push(
    `| Talk ratio (you : interviewee) | ${fmtPercent(metrics.talkRatioStudent)} : ${fmtPercent(1 - metrics.talkRatioStudent)} |`
  );
  lines.push(`| Questions asked | ${metrics.questionsAsked} |`);
  lines.push(`| Your turns / interviewee turns | ${metrics.studentTurns} / ${metrics.intervieweeTurns} |`);
  lines.push(`| Words spoken (you / interviewee) | ${metrics.studentWords} / ${metrics.intervieweeWords} |`);
  lines.push(`| Average words per turn (you) | ${metrics.avgQuestionWords} |`);
  lines.push(`| Longest uninterrupted turn (you) | ${fmtMs(metrics.longestStudentMonologueMs)} |`);
  lines.push(``);
  lines.push(`## Rubric assessment`);
  lines.push(``);
  if (overall) lines.push(`Overall score: **${overall} / 5**`);
  lines.push(``);
  lines.push(`| Criterion | Score | Justification |`);
  lines.push(`| --- | --- | --- |`);
  for (const c of CRITERIA) {
    const state = criterionStates[c.id];
    if (state.status === "done") {
      const score = state.score.score === null ? "n/a" : `${state.score.score} / 5`;
      lines.push(`| ${c.name} | ${score} | ${state.score.justification} |`);
    } else if (state.status === "error") {
      lines.push(`| ${c.name} | — | not scored: ${state.message.replace(/\|/g, "/")} |`);
    } else {
      lines.push(`| ${c.name} | — | not scored |`);
    }
  }
  lines.push(``);
  if (feedbackState.status === "done") {
    const f = feedbackState.feedback;
    lines.push(`## Feedback`);
    lines.push(``);
    lines.push(`### Strengths`);
    f.strengths.forEach((s) => lines.push(`- ${s}`));
    lines.push(``);
    lines.push(`### Areas to improve`);
    f.improvements.forEach((s) => lines.push(`- ${s}`));
    lines.push(``);
    lines.push(`### Notable moments`);
    f.moments.forEach((m) => {
      lines.push(`> "${m.quote}"`);
      lines.push(``);
      lines.push(`${m.comment}`);
      lines.push(``);
    });
    lines.push(`### What you did not reach`);
    lines.push(f.missedDepth);
    lines.push(``);
    lines.push(`### Summary`);
    lines.push(f.summary);
    lines.push(``);
  }
  lines.push(`## Transcript`);
  lines.push(``);
  for (const e of result.transcript) {
    lines.push(
      `**[${fmtMs(e.tStart)}, spoke ${fmtMs(e.speechMs)}] ${e.speaker === "student" ? "You" : persona.name}:** ${e.text}`
    );
    lines.push(``);
  }
  return lines.join("\n");
}
