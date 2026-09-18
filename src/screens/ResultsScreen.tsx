import { useEffect, useMemo, useState } from "react";
import {
  CriterionScore,
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

/**
 * Points-out-of-possible for the overall figure, summed over rows the
 * evaluators could actually assess (score !== null); a not-assessable
 * criterion contributes to neither sum. Null when nothing was assessable.
 */
function computeOverallPoints(
  scores: CriterionScore[],
): { points: number; possible: number } | null {
  const assessed = scores.filter((s) => s.score !== null);
  if (assessed.length === 0) return null;
  const points = assessed.reduce((sum, s) => sum + (s.score as number), 0);
  const possible = assessed.reduce((sum, s) => sum + (s.max ?? 5), 0);
  return { points, possible };
}

export function ResultsScreen({ result, persona, onNewInterview }: Props) {
  const metrics = useMemo(() => computeMetrics(result), [result]);
  const [state, setState] = useState<ReportState>({ status: "idle" });
  // Transcript-consent answer (instructor request, 2026-09-18). Null means the
  // student has not answered yet, and the submit button stays disabled until
  // they do. "No" submits exactly like "Yes"; only the stored answer differs,
  // because refusing must not cost a student their coursework.
  const [consent, setConsent] = useState<boolean | null>(null);

  // The nine independent evaluators run on the server, so the browser sees a
  // finished report rather than nine promises. This only runs when the
  // student clicks "Submit interview for scoring", or Retry after a failure
  // - never automatically on mount, so the student decides when scoring,
  // storing, and emailing happen.
  const submit = () => {
    // The button is disabled until the question is answered; this guard also
    // covers the Retry button in the error branch.
    if (consent === null) return;
    setState({ status: "pending" });
    api<ReportResponse>("/api/report", {
      method: "POST",
      body: JSON.stringify({
        personaId: persona.id,
        transcript: result.transcript,
        startedAt: result.startedAt,
        endedAt: result.endedAt,
        metrics,
        consent,
      }),
    })
      .then((report) => setState({ status: "done", report }))
      .catch((err: Error) => setState({ status: "error", message: err.message }));
  };

  const report = state.status === "done" ? state.report : null;
  // The instructor can switch off the student's copy of the scores. The server
  // then sends no scores and no feedback at all, so there is nothing to hide in
  // the browser; the screen shows the metrics, the transcript and a notice.
  const withheld = report !== null && report.shared === false;
  // Held in its own const so the null check survives into the callbacks below.
  const feedback = report ? report.feedback : null;
  const assessed = report ? report.scores.filter((s) => s.score !== null).length : 0;
  const notAssessedCount = report ? report.scores.length - assessed : 0;
  const overallPoints = report ? computeOverallPoints(report.scores) : null;

  const downloadMarkdown = () => {
    const md = buildMarkdownReport(result, metrics, persona, report, consent);
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
      <div className="card rise" style={{ ["--d" as string]: 0 }}>
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

        {(state.status === "idle" || state.status === "pending") && (
          <div className="submit-block no-print">
            <p>
              Your interview is complete. Submit it for scoring. You and your
              instructor receive a copy by email.
            </p>
            {/* Both languages stand in one box, in the instructor's own
                wording. The answer travels with the report and is stored on
                the submission. */}
            <div className="consent-box">
              <p className="consent-title">Transcript consent / Toestemming transcript</p>
              <p>
                We collect transcripts in order to examine the quality of the
                feedback of the chatbot. Do you consent to the usage of your
                transcript to increase the quality of our chatbot?
              </p>
              <p lang="nl">
                We verzamelen transcripten om de kwaliteit van de feedback van
                de chatbot te beoordelen. Geef je toestemming het gebruik van
                jouw transcript om de kwaliteit van onze chatbot te verbeteren?
              </p>
              <div className="consent-choices">
                <label className="consent-chip">
                  <input
                    type="radio"
                    name="transcript-consent"
                    checked={consent === true}
                    onChange={() => setConsent(true)}
                    disabled={state.status === "pending"}
                  />
                  <span className="consent-dot" aria-hidden="true" />
                  Yes / Ja
                </label>
                <label className="consent-chip">
                  <input
                    type="radio"
                    name="transcript-consent"
                    checked={consent === false}
                    onChange={() => setConsent(false)}
                    disabled={state.status === "pending"}
                  />
                  <span className="consent-dot" aria-hidden="true" />
                  No / Nee
                </label>
              </div>
            </div>
            <div className="btn-row">
              <button
                className="btn"
                onClick={submit}
                disabled={consent === null || state.status === "pending"}
              >
                Submit interview for scoring
              </button>
            </div>
            {consent === null && (
              <p className="small">
                Answer the question above to submit. / Antwoord op de vraag
                hierboven om te verzenden.
              </p>
            )}
            {state.status === "pending" && (
              <>
                <div className="progress-indeterminate" aria-hidden="true" />
                <p className="small">
                  Scoring your interview. This takes 10 to 20 seconds.
                </p>
              </>
            )}
          </div>
        )}

        {/* Retry exists only in the error branch: a second POST after a success
            would store and email the report twice. */}
        {state.status === "error" && (
          <div className="banner-error">
            <p>{state.message}</p>
            <div className="btn-row">
              <button className="btn btn-secondary no-print" onClick={submit}>
                Retry
              </button>
            </div>
          </div>
        )}

        {report && (
          <div className="banner-success rise">
            {report.shared !== false
              ? report.emailed
                ? "Your interview was submitted and scored. The report was emailed to you and your instructor."
                : "Your interview was submitted and scored. The report email could not be sent, but your instructor has the report."
              : report.emailed
                ? "Your interview was submitted. Your instructor received the scored report, and your transcript was emailed to you."
                : "Your interview was submitted. Your instructor received the scored report."}
          </div>
        )}
      </div>

      <div className="card rise" style={{ ["--d" as string]: 1 }}>
        <h2>Speaking metrics</h2>
        <table className="kv-table">
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
      </div>

      {withheld ? (
        <div className="card rise" style={{ ["--d" as string]: 2 }}>
          <h2>Scores and feedback</h2>
          <p>
            Your interview was submitted and scored. Your instructor received the
            full report and will share feedback with you.
          </p>
        </div>
      ) : (
        <div className="card rise" style={{ ["--d" as string]: 2 }}>
          <h2>Rubric assessment</h2>
          <p className="small">
            Each criterion is scored by an independent evaluator that sees only
            the transcript and that single criterion, to avoid anchoring bias
            between scores. A criterion the interview gave no opportunity to
            demonstrate is marked <strong>n/a</strong> rather than scored low, and
            is left out of the overall figure.
          </p>

          {report ? (
            <>
              {report.overall !== null && overallPoints && (() => {
                const pct =
                  report.overall ??
                  Math.round((100 * overallPoints.points) / overallPoints.possible);
                return (
                  <div className="overall">
                    <div className="overall-figure" aria-hidden="true">
                      <CountUp value={pct} />
                      <span className="overall-unit">%</span>
                    </div>
                    <div
                      className="overall-bar"
                      style={{ ["--p" as string]: Math.min(1, Math.max(0, pct / 100)) }}
                    >
                      <span />
                    </div>
                    <p className="overall-score">
                      Overall score: {overallPoints.points} / {overallPoints.possible}{" "}
                      points ({pct}%)
                      {notAssessedCount > 0 && (
                        <span className="small">
                          {" "}
                          (over {assessed} of {report.scores.length} criteria;{" "}
                          {notAssessedCount} not assessable)
                        </span>
                      )}
                    </p>
                  </div>
                );
              })()}
              <table>
                <thead>
                  <tr>
                    <th>Criterion</th>
                    <th>Score</th>
                    <th>Justification</th>
                  </tr>
                </thead>
                <tbody>
                  {report.scores.map((s, i) => (
                    <tr key={s.id} className="rise" style={{ ["--d" as string]: 3 + i * 0.7 }}>
                      <td>{s.name}</td>
                      <td className="score-cell">
                        {s.score === null ? (
                          <span className="not-assessed">n/a</span>
                        ) : (
                          <span className="chip">{s.score} / {s.max ?? 5}</span>
                        )}
                      </td>
                      <td>{s.justification}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          ) : (
            <p className="small">
              Your scores appear here once the interview is submitted.
            </p>
          )}
        </div>
      )}

      {report && feedback && (
        <div className="card rise" style={{ ["--d" as string]: 3 }}>
          <h2>Feedback</h2>
          <h3>Strengths</h3>
          <ul>
            {feedback.strengths.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ul>
          <h3>Areas to improve</h3>
          <ul>
            {feedback.improvements.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ul>
          <h3>Notable moments</h3>
          {feedback.moments.map((m, i) => (
            <div key={i}>
              <blockquote>“{m.quote}”</blockquote>
              <p className="small">{m.comment}</p>
            </div>
          ))}
          <h3>What you did not reach</h3>
          <p>{feedback.missedDepth}</p>
          <h3>Summary</h3>
          <p>{feedback.summary}</p>

        </div>
      )}

      <div className="card rise" style={{ ["--d" as string]: 4 }}>
        <h2>Transcript</h2>
        <div className="transcript">
          {result.transcript.map((e, i) => (
            <div className="entry" key={i}>
              <span className={`speaker ${e.speaker}`}>
                {e.speaker === "student" ? "You" : persona.name}
                <span className="t">
                  {e.interrupted ? "(interrupted) · " : ""}
                  {fmtMs(e.tStart)} · spoke {fmtMs(e.speechMs)}
                </span>
              </span>
              <div>{e.text}</div>
            </div>
          ))}
        </div>
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

/** Counts up to `value` with an ease-out, once, when the score arrives. */
function CountUp({ value }: { value: number }) {
  const [shown, setShown] = useState(0);
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setShown(value);
      return;
    }
    let raf = 0;
    const start = performance.now();
    const duration = 1100;
    const tick = (t: number) => {
      const k = Math.min(1, (t - start) / duration);
      setShown(value * (1 - Math.pow(1 - k, 4)));
      if (k < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value]);
  return <>{Number.isInteger(value) ? Math.round(shown) : shown.toFixed(1)}</>;
}

function buildMarkdownReport(
  result: SessionResult,
  metrics: Metrics,
  persona: PersonaSummary,
  report: ReportResponse | null,
  consent: boolean | null,
): string {
  const lines: string[] = [];
  lines.push(`# Interview Report`);
  lines.push(``);
  lines.push(`- Interviewee: ${persona.name} (${persona.title})`);
  lines.push(`- Research topic: ${persona.researchTopic}`);
  lines.push(`- Date: ${new Date(result.startedAt).toLocaleString()}`);
  lines.push(`- Duration: ${fmtMs(metrics.durationMs)}`);
  lines.push(
    `- Transcript consent: ${consent === null ? "Not answered" : consent ? "Yes" : "No"}`,
  );
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
  if (report && report.shared === false) {
    // The same transcript-only shape the student's email has: the download must
    // not become a way around the instructor's switch.
    lines.push(
      `Your interview was submitted and scored. Your instructor received the full report and will share feedback with you.`,
    );
    lines.push(``);
  } else if (!report) {
    lines.push(`## Rubric assessment`);
    lines.push(``);
    lines.push(`The interview was not scored.`);
    lines.push(``);
  } else {
    lines.push(`## Rubric assessment`);
    lines.push(``);
    const overallPoints = computeOverallPoints(report.scores);
    if (report.overall !== null && overallPoints) {
      const pct =
        report.overall ??
        Math.round((100 * overallPoints.points) / overallPoints.possible);
      lines.push(
        `Overall score: **${overallPoints.points} / ${overallPoints.possible} points (${pct}%)**`,
      );
    }
    lines.push(``);
    lines.push(`| Criterion | Score | Justification |`);
    lines.push(`| --- | --- | --- |`);
    for (const s of report.scores) {
      const score = s.score === null ? "n/a" : `${s.score} / ${s.max ?? 5}`;
      lines.push(`| ${s.name} | ${score} | ${s.justification} |`);
    }
    lines.push(``);
    const f = report.feedback;
    if (f) {
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
  }
  lines.push(`## Transcript`);
  lines.push(``);
  for (const e of result.transcript) {
    lines.push(
      `**[${fmtMs(e.tStart)}, spoke ${fmtMs(e.speechMs)}] ${e.speaker === "student" ? "You" : persona.name}${e.interrupted ? " (interrupted)" : ""}:** ${e.text}`
    );
    lines.push(``);
  }
  return lines.join("\n");
}
