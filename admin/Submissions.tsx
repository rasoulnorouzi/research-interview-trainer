import { useEffect, useState } from "react";
import { api, adminUrl } from "./api";
import { fmtMs } from "../shared/format";
import type { CriterionScore, Metrics, QualitativeFeedback, TranscriptEntry } from "../shared/types";

interface SubmissionListItem {
  id: string;
  studentId: string;
  fullName: string;
  cohort: string | null;
  personaId: string;
  startedAt: number;
  durationMs: number;
  overallScore: number | null;
  emailedAt: number | null;
}

interface SubmissionDetail {
  id: string;
  studentId: string;
  fullName: string;
  cohort: string | null;
  personaId: string;
  startedAt: number;
  endedAt: number;
  durationMs: number;
  overallScore: number | null;
  scores: CriterionScore[];
  feedback: QualitativeFeedback;
  metrics: Metrics;
  transcript: TranscriptEntry[];
  emailedAt: number | null;
  createdAt: number;
}

interface Props {
  onApiError: (err: unknown) => void;
}

/**
 * started_at is documented as unix seconds (BACKEND-PLAN.md §3), but worker/
 * report.ts writes the client's epoch-millisecond SessionResult.startedAt
 * straight into that column with no conversion, and worker/admin.ts's own CSV
 * export (isoFromUnix) already has to guard against that by checking whether
 * a value is plainly milliseconds. Mirrored here so the dashboard shows a real
 * date either way rather than trusting the column name.
 */
function formatUnixOrMs(value: number): string {
  const ms = value > 1e11 ? value : value * 1000;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString();
}

function toUnixSeconds(dateInput: string): number | null {
  if (dateInput.trim().length === 0) return null;
  const ms = new Date(dateInput).getTime();
  return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
}

export function Submissions({ onApiError }: Props) {
  const [cohort, setCohort] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [sort, setSort] = useState<"date" | "duration">("date");

  const [list, setList] = useState<SubmissionListItem[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);

  const [detail, setDetail] = useState<SubmissionDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const buildQuery = (): string => {
    const params = new URLSearchParams();
    if (cohort.trim().length > 0) params.set("cohort", cohort.trim());
    const fromSec = toUnixSeconds(from);
    if (fromSec !== null) params.set("from", String(fromSec));
    const toSec = toUnixSeconds(to);
    if (toSec !== null) params.set("to", String(toSec));
    if (sort === "duration") params.set("sort", "duration");
    return params.toString();
  };

  const load = () => {
    setListError(null);
    const qs = buildQuery();
    api<{ submissions: SubmissionListItem[] }>(`/submissions${qs ? `?${qs}` : ""}`)
      .then(({ submissions }) => setList(submissions))
      .catch((err) => {
        setListError(err instanceof Error ? err.message : "Could not load submissions.");
        onApiError(err);
      });
  };

  useEffect(load, []);

  const search = (e: React.FormEvent) => {
    e.preventDefault();
    load();
  };

  const openDetail = (id: string) => {
    setDetailError(null);
    setDetailLoading(true);
    setDetail(null);
    api<SubmissionDetail>(`/submissions/${encodeURIComponent(id)}`)
      .then(setDetail)
      .catch((err) => {
        setDetailError(err instanceof Error ? err.message : "Could not load this submission.");
        onApiError(err);
      })
      .finally(() => setDetailLoading(false));
  };

  if (detailLoading || detail || detailError) {
    return (
      <div>
        <p>
          <button className="btn btn-secondary" type="button" onClick={() => setDetail(null)}>
            Back to submissions
          </button>
        </p>
        {detailLoading && <p className="small">Loading…</p>}
        {detailError && <div className="banner-error">{detailError}</div>}
        {detail && <SubmissionDetailView detail={detail} />}
      </div>
    );
  }

  return (
    <div>
      <h2>Submissions</h2>

      <form className="admin-toolbar" onSubmit={search}>
        <div className="field">
          <label htmlFor="sub-cohort">Cohort</label>
          <input id="sub-cohort" type="text" value={cohort} onChange={(e) => setCohort(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="sub-from">From</label>
          <input id="sub-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="sub-to">To</label>
          <input id="sub-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="sub-sort">Sort by</label>
          <select id="sub-sort" value={sort} onChange={(e) => setSort(e.target.value as "date" | "duration")}>
            <option value="date">Date</option>
            <option value="duration">Duration</option>
          </select>
        </div>
        <button className="btn btn-secondary" type="submit">
          Filter
        </button>
        <a className="btn btn-secondary" href={adminUrl(`/submissions.csv?${buildQuery()}`)}>
          Download CSV
        </a>
      </form>

      {listError && <div className="banner-error">{listError}</div>}
      {list === null && !listError && <p className="small">Loading submissions…</p>}
      {list && (
        <div className="admin-table-wrap">
          <table>
            <thead>
              <tr>
                <th>Started</th>
                <th>Student</th>
                <th>Cohort</th>
                <th>Persona</th>
                <th>Duration</th>
                <th>Overall score</th>
                <th>Emailed</th>
              </tr>
            </thead>
            <tbody>
              {list.map((s) => (
                <tr key={s.id} className="admin-clickable-row" onClick={() => openDetail(s.id)}>
                  <td className="num">{formatUnixOrMs(s.startedAt)}</td>
                  <td>
                    {s.fullName} <span className="small">({s.studentId})</span>
                  </td>
                  <td>{s.cohort ?? ""}</td>
                  <td>{s.personaId}</td>
                  <td className="num">{fmtMs(s.durationMs)}</td>
                  <td className="score-cell">
                    {s.overallScore === null ? <span className="not-assessed">n/a</span> : `${s.overallScore} / 5`}
                  </td>
                  <td>{s.emailedAt !== null ? "Yes" : "No"}</td>
                </tr>
              ))}
              {list.length === 0 && (
                <tr>
                  <td colSpan={7} className="small">
                    No submissions match.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function SubmissionDetailView({ detail }: { detail: SubmissionDetail }) {
  const assessed = detail.scores.filter((s) => s.score !== null).length;
  const notAssessedCount = detail.scores.length - assessed;

  return (
    <div>
      <h2>Interview report</h2>
      <p className="lede">
        {detail.fullName} ({detail.studentId}){detail.cohort ? ` · ${detail.cohort}` : ""}
        <br />
        Persona: {detail.personaId}
        <br />
        {formatUnixOrMs(detail.startedAt)} · Duration {fmtMs(detail.durationMs)}
        <br />
        Emailed: {detail.emailedAt !== null ? "Yes" : "No"}
      </p>

      <h3>Speaking metrics</h3>
      <table>
        <tbody>
          <tr>
            <th>Total duration</th>
            <td className="num">{fmtMs(detail.metrics.durationMs)}</td>
          </tr>
          <tr>
            <th>Student speaking time</th>
            <td className="num">{fmtMs(detail.metrics.studentSpeakingMs)}</td>
          </tr>
          <tr>
            <th>Interviewee speaking time</th>
            <td className="num">{fmtMs(detail.metrics.intervieweeSpeakingMs)}</td>
          </tr>
          <tr>
            <th>Talk ratio (student)</th>
            <td className="num">{Math.round(detail.metrics.talkRatioStudent * 100)}%</td>
          </tr>
          <tr>
            <th>Questions asked</th>
            <td className="num">{detail.metrics.questionsAsked}</td>
          </tr>
          <tr>
            <th>Student turns / interviewee turns</th>
            <td className="num">
              {detail.metrics.studentTurns} / {detail.metrics.intervieweeTurns}
            </td>
          </tr>
          <tr>
            <th>Words spoken (student / interviewee)</th>
            <td className="num">
              {detail.metrics.studentWords} / {detail.metrics.intervieweeWords}
            </td>
          </tr>
          <tr>
            <th>Average words per student turn</th>
            <td className="num">{detail.metrics.avgQuestionWords}</td>
          </tr>
          <tr>
            <th>Longest uninterrupted student turn</th>
            <td className="num">{fmtMs(detail.metrics.longestStudentMonologueMs)}</td>
          </tr>
        </tbody>
      </table>

      <h3>Rubric assessment</h3>
      {detail.overallScore !== null && (
        <p className="overall-score">
          Overall score: {detail.overallScore.toFixed(1)} / 5
          {notAssessedCount > 0 && (
            <span className="small">
              {" "}
              (over {assessed} of {detail.scores.length} criteria; {notAssessedCount} not assessable)
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
          {detail.scores.map((s) => (
            <tr key={s.id}>
              <td>{s.name}</td>
              <td className="score-cell">
                {s.score === null ? <span className="not-assessed">n/a</span> : `${s.score} / 5`}
              </td>
              <td>{s.justification}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h3>Feedback</h3>
      <h3>Strengths</h3>
      <ul>
        {detail.feedback.strengths.map((s, i) => (
          <li key={i}>{s}</li>
        ))}
      </ul>
      <h3>Areas to improve</h3>
      <ul>
        {detail.feedback.improvements.map((s, i) => (
          <li key={i}>{s}</li>
        ))}
      </ul>
      <h3>Notable moments</h3>
      {detail.feedback.moments.map((m, i) => (
        <div key={i}>
          <blockquote>&ldquo;{m.quote}&rdquo;</blockquote>
          <p className="small">{m.comment}</p>
        </div>
      ))}
      <h3>What the student did not reach</h3>
      <p>{detail.feedback.missedDepth}</p>
      <h3>Summary</h3>
      <p>{detail.feedback.summary}</p>

      <h3>Transcript</h3>
      <div className="transcript">
        {detail.transcript.map((e, i) => (
          <div className="entry" key={i}>
            <span className={`speaker ${e.speaker}`}>
              {e.speaker === "student" ? "Student" : "Interviewee"}
              <span className="t">
                {fmtMs(e.tStart)} · spoke {fmtMs(e.speechMs)}
              </span>
            </span>
            <div>{e.text}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
