import { useMemo, useState } from "react";
import {
  Metrics,
  PersonaSummary,
  ReportResponse,
  SessionResult,
} from "../types";
import { computeMetrics, fmtMs, fmtPercent } from "../lib/metrics";
import { api } from "../api";

interface Props {
  result: SessionResult;
  persona: PersonaSummary;
  onNewInterview: () => void;
}

type ReportState =
  | { status: "idle" }
  | { status: "pending" }
  | { status: "done"; report: ReportResponse }
  | { status: "error"; message: string };

export function ResultsScreen({ result, persona, onNewInterview }: Props) {
  const metrics = useMemo(() => computeMetrics(result), [result]);
  const [state, setState] = useState<ReportState>({ status: "idle" });

  // The nine independent evaluators run on the server, so the browser sees a
  // finished report rather than nine promises. This only runs when the
  // student clicks "Submit interview for scoring", or Retry after a failure
  // - never automatically on mount, so the student decides when scoring,
  // storing, and emailing happen.
  const submit = () => {
    setState({ status: "pending" });
    api<ReportResponse>("/api/report", {
      method: "POST",
      body: JSON.stringify({
        personaId: persona.id,
        transcript: result.transcript,
        startedAt: result.startedAt,
        endedAt: result.endedAt,
        metrics,
      }),
    })
      .then((report) => setState({ status: "done", report }))
      .catch((err: Error) => setState({ status: "error", message: err.message }));
  };

  const report = state.status === "done" ? state.report : null;
  const assessed = report ? report.scores.filter((s) => s.score !== null).length : 0;
  const notAssessedCount = report ? report.scores.length - assessed : 0;

  const downloadMarkdown = () => {
    const md = buildMarkdownReport(result, metrics, persona, report);
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
        {persona.name}. {persona.researchTopic}
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

      {(state.status === "idle" || state.status === "pending") && (
        <div className="no-print">
          <p>
            Your interview is complete. Submit it to receive your scores and
            feedback. A copy of the report goes to you and your instructor by
            email.
          </p>
          <button
            className="btn"
            onClick={submit}
            disabled={state.status === "pending"}
          >
            Submit interview for scoring
          </button>
        </div>
      )}

      {state.status === "pending" && (
        <p className="small">Scoring your interview. This takes 10 to 20 seconds.</p>
      )}

      {/* Retry exists only in the error branch: a second POST after a success
          would store and email the report twice. */}
      {state.status === "error" && (
        <p>
          <span className="small">{state.message} </span>
          <button className="btn btn-secondary no-print" onClick={submit}>
            Retry
          </button>
        </p>
      )}

      {report && (
        <>
          {report.overall !== null && (
            <p className="overall-score">
              Overall score: {report.overall.toFixed(1)} / 5
              {notAssessedCount > 0 && (
                <span className="small">
                  {" "}
                  (over {assessed} of {report.scores.length} criteria;{" "}
                  {notAssessedCount} not assessable)
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
              {report.scores.map((s) => (
                <tr key={s.id}>
                  <td>{s.name}</td>
                  <td className="score-cell">
                    {s.score === null ? (
                      <span className="not-assessed">n/a</span>
                    ) : (
                      `${s.score} / 5`
                    )}
                  </td>
                  <td>{s.justification}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <h2>Feedback</h2>
          <h3>Strengths</h3>
          <ul>
            {report.feedback.strengths.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ul>
          <h3>Areas to improve</h3>
          <ul>
            {report.feedback.improvements.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ul>
          <h3>Notable moments</h3>
          {report.feedback.moments.map((m, i) => (
            <div key={i}>
              <blockquote>“{m.quote}”</blockquote>
              <p className="small">{m.comment}</p>
            </div>
          ))}
          <h3>What you did not reach</h3>
          <p>{report.feedback.missedDepth}</p>
          <h3>Summary</h3>
          <p>{report.feedback.summary}</p>

          {report.emailed && (
            <p className="small">
              A copy of this report has been emailed to you and your instructor.
            </p>
          )}
        </>
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
  persona: PersonaSummary,
  report: ReportResponse | null
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
  if (!report) {
    lines.push(`The interview was not scored.`);
    lines.push(``);
  } else {
    if (report.overall !== null) lines.push(`Overall score: **${report.overall.toFixed(1)} / 5**`);
    lines.push(``);
    lines.push(`| Criterion | Score | Justification |`);
    lines.push(`| --- | --- | --- |`);
    for (const s of report.scores) {
      const score = s.score === null ? "n/a" : `${s.score} / 5`;
      lines.push(`| ${s.name} | ${score} | ${s.justification} |`);
    }
    lines.push(``);
    const f = report.feedback;
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
