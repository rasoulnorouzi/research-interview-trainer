import { Fragment, useEffect, useState } from "react";
import { Toggle } from "./Toggle";
import { api, adminUrl } from "./api";
import { buildZip } from "./zip";
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

/**
 * Points-out-of-possible for the overall figure, summed over rows the
 * evaluators could actually assess (score !== null); a not-assessable
 * criterion contributes to neither sum. Null when nothing was assessable
 * (including an empty scores array).
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

interface StudentGroup {
  studentId: string;
  fullName: string;
  cohort: string | null;
  items: SubmissionListItem[];
}

/**
 * One row per student, grouped in the order the server returned the
 * submissions, so both sort modes stay meaningful: by date puts the most
 * recently active student first, by duration the student with the longest
 * single interview.
 */
function groupByStudent(list: SubmissionListItem[]): StudentGroup[] {
  const groups: StudentGroup[] = [];
  const byId = new Map<string, StudentGroup>();
  for (const s of list) {
    let g = byId.get(s.studentId);
    if (!g) {
      g = { studentId: s.studentId, fullName: s.fullName, cohort: s.cohort, items: [] };
      byId.set(s.studentId, g);
      groups.push(g);
    }
    g.items.push(s);
  }
  return groups;
}

function latestStartedAt(g: StudentGroup): number {
  return Math.max(...g.items.map((s) => s.startedAt));
}

/** Mean of the student's scored interviews, null when none was scored. */
function averageScore(g: StudentGroup): number | null {
  const scored = g.items.filter((s) => s.overallScore !== null);
  if (scored.length === 0) return null;
  return Math.round(scored.reduce((sum, s) => sum + (s.overallScore as number), 0) / scored.length);
}

/** Browser-side file download, shared by the detail view and the bulk button. */
function downloadBlob(filename: string, blob: Blob) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

/** The interview's date for file names, tolerant of seconds or milliseconds. */
function submissionDay(startedAt: number): string {
  return new Date(startedAt > 1e11 ? startedAt : startedAt * 1000).toISOString().slice(0, 10);
}

export function Submissions({ onApiError }: Props) {
  const [cohort, setCohort] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [sort, setSort] = useState<"date" | "duration">("date");
  const [student, setStudent] = useState("");

  // The checkbox selection for bulk delete and bulk download, by submission id.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [bulkDownloading, setBulkDownloading] = useState(false);

  // Which student rows are open. The list shows one row per student.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const [list, setList] = useState<SubmissionListItem[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);

  const [detail, setDetail] = useState<SubmissionDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const buildQuery = (): string => {
    const params = new URLSearchParams();
    if (student.trim().length > 0) params.set("student", student.trim());
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
    setSelected(new Set());
    const qs = buildQuery();
    api<{ submissions: SubmissionListItem[] }>(`/submissions${qs ? `?${qs}` : ""}`)
      .then(({ submissions }) => {
        setList(submissions);
        // A filter that narrows the list to one student opens that student's
        // row by itself; otherwise every row starts closed.
        const students = new Set(submissions.map((s) => s.studentId));
        setExpanded(students.size === 1 ? students : new Set());
      })
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

  const toggleSelected = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (!list) return;
    setSelected((prev) => (prev.size === list.length ? new Set<string>() : new Set(list.map((s) => s.id))));
  };

  const toggleExpanded = (studentId: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(studentId)) next.delete(studentId);
      else next.add(studentId);
      return next;
    });
  };

  // The student row's checkbox selects (or clears) all of that student's
  // submissions at once.
  const toggleStudentSelected = (g: StudentGroup) => {
    setSelected((prev) => {
      const next = new Set(prev);
      const all = g.items.every((s) => next.has(s.id));
      for (const s of g.items) {
        if (all) next.delete(s.id);
        else next.add(s.id);
      }
      return next;
    });
  };

  /**
   * Every selected submission as its own Markdown file, fetched one by one
   * from the existing detail endpoint, so no new API surface. One selection
   * downloads directly; more than one arrives as a single ZIP archive
   * (admin/zip.ts, dependency-free), because a browser blocks a page that
   * fires many downloads at once. Scores and feedback are always included:
   * this is the instructor's own record, not a student handout.
   */
  const bulkDownload = () => {
    if (!list || selected.size === 0) return;
    setBulkDownloading(true);
    setListError(null);
    const ids = list.filter((s) => selected.has(s.id)).map((s) => s.id);
    Promise.all(ids.map((id) => api<SubmissionDetail>(`/submissions/${encodeURIComponent(id)}`)))
      .then((details) => {
        if (details.length === 1) {
          const d = details[0];
          const md = buildSubmissionMarkdown(d, true);
          downloadBlob(`interview-${d.studentId}-${submissionDay(d.startedAt)}.md`, new Blob([md], { type: "text/markdown" }));
          return;
        }
        const used = new Set<string>();
        const entries = details.map((d) => {
          const base = `interview-${d.studentId}-${submissionDay(d.startedAt)}-${d.personaId}`;
          // A student can interview the same persona twice in a day, and one
          // archive cannot hold two files with one name.
          let name = `${base}.md`;
          for (let n = 2; used.has(name); n++) name = `${base}-${n}.md`;
          used.add(name);
          return { name, text: buildSubmissionMarkdown(d, true) };
        });
        downloadBlob(`submissions-${new Date().toISOString().slice(0, 10)}.zip`, buildZip(entries));
      })
      .catch((err) => {
        setListError(err instanceof Error ? err.message : "Could not download the selected submissions.");
        onApiError(err);
      })
      .finally(() => setBulkDownloading(false));
  };

  const bulkDelete = () => {
    if (selected.size === 0) return;
    const n = selected.size;
    if (
      !confirm(
        `Delete ${n} ${n === 1 ? "submission" : "submissions"} permanently? This cannot be undone. The emailed copies are not affected.`,
      )
    ) {
      return;
    }
    setBulkDeleting(true);
    setListError(null);
    api<{ deleted: number }>(`/submissions/bulk-delete`, {
      method: "POST",
      body: JSON.stringify({ ids: [...selected] }),
    })
      .then(() => load())
      .catch((err) => {
        setListError(err instanceof Error ? err.message : "Could not delete the selected submissions.");
        onApiError(err);
      })
      .finally(() => setBulkDeleting(false));
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

  const removeDetail = () => {
    if (!detail) return;
    if (!confirm("Delete this submission permanently? The emailed copies are not affected.")) return;
    setDetailError(null);
    setDeleting(true);
    api<{ deleted: boolean }>(`/submissions/${encodeURIComponent(detail.id)}`, { method: "DELETE" })
      .then(() => {
        setDetail(null);
        load();
      })
      .catch((err) => {
        setDetailError(err instanceof Error ? err.message : "Could not delete this submission.");
        onApiError(err);
      })
      .finally(() => setDeleting(false));
  };

  if (detailLoading || detail || detailError) {
    return (
      <div>
        <p className="no-print">
          <button className="btn btn-secondary" type="button" onClick={() => setDetail(null)}>
            Back to submissions
          </button>
        </p>
        {detailLoading && <p className="small">Loading…</p>}
        {detailError && <div className="banner-error">{detailError}</div>}
        {detail && <SubmissionDetailView detail={detail} deleting={deleting} onDelete={removeDetail} />}
      </div>
    );
  }

  return (
    <div>
      <h2>Submissions</h2>

      <form className="card admin-toolbar" onSubmit={search}>
        <div className="field">
          <label htmlFor="sub-student">Student ID</label>
          <input
            id="sub-student"
            type="text"
            placeholder="u000000"
            value={student}
            onChange={(e) => setStudent(e.target.value)}
          />
        </div>
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
                <th>
                  <input
                    type="checkbox"
                    aria-label="Select all submissions in the list"
                    checked={list.length > 0 && selected.size === list.length}
                    onChange={toggleSelectAll}
                  />
                </th>
                <th aria-hidden="true"></th>
                <th>Student</th>
                <th>Cohort</th>
                <th>Interviews</th>
                <th>Last interview</th>
                <th>Average score</th>
              </tr>
            </thead>
            <tbody>
              {groupByStudent(list).map((g) => {
                const isOpen = expanded.has(g.studentId);
                const avg = averageScore(g);
                return (
                  <Fragment key={g.studentId}>
                    <tr className="admin-clickable-row" onClick={() => toggleExpanded(g.studentId)}>
                      <td onClick={(e) => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          aria-label={`Select all submissions of ${g.fullName}`}
                          checked={g.items.every((s) => selected.has(s.id))}
                          onChange={() => toggleStudentSelected(g)}
                        />
                      </td>
                      <td className="admin-caret">{isOpen ? "▾" : "▸"}</td>
                      <td>
                        {g.fullName} <span className="small">({g.studentId})</span>
                      </td>
                      <td>{g.cohort ?? ""}</td>
                      <td className="num">{g.items.length}</td>
                      <td className="num">{formatUnixOrMs(latestStartedAt(g))}</td>
                      <td className="score-cell">
                        {avg === null ? (
                          <span className="not-assessed">n/a</span>
                        ) : (
                          <span className="chip">{avg}%</span>
                        )}
                      </td>
                    </tr>
                    {isOpen && (
                      <tr className="admin-subrow">
                        <td></td>
                        <td colSpan={6}>
                          <table className="admin-subtable">
                            <thead>
                              <tr>
                                <th></th>
                                <th>Started</th>
                                <th>Persona</th>
                                <th>Duration</th>
                                <th>Overall score</th>
                                <th>Emailed</th>
                              </tr>
                            </thead>
                            <tbody>
                              {g.items.map((s) => (
                                <tr key={s.id} className="admin-clickable-row" onClick={() => openDetail(s.id)}>
                                  <td onClick={(e) => e.stopPropagation()}>
                                    <input
                                      type="checkbox"
                                      aria-label={`Select the submission of ${s.studentId} started ${formatUnixOrMs(s.startedAt)}`}
                                      checked={selected.has(s.id)}
                                      onChange={() => toggleSelected(s.id)}
                                    />
                                  </td>
                                  <td className="num">{formatUnixOrMs(s.startedAt)}</td>
                                  <td>{s.personaId}</td>
                                  <td className="num">{fmtMs(s.durationMs)}</td>
                                  <td className="score-cell">
                                    {s.overallScore === null ? (
                                      <span className="not-assessed">n/a</span>
                                    ) : (
                                      <span className="chip">{s.overallScore}%</span>
                                    )}
                                  </td>
                                  <td>{s.emailedAt !== null ? "Yes" : "No"}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
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
      {list && selected.size > 0 && (
        <div className="btn-row" style={{ marginTop: "0.8rem" }}>
          <button
            className="btn btn-secondary"
            type="button"
            onClick={bulkDownload}
            disabled={bulkDownloading}
          >
            {bulkDownloading ? "Preparing…" : `Download ${selected.size} selected`}
          </button>
          <button className="btn btn-danger" type="button" onClick={bulkDelete} disabled={bulkDeleting}>
            {bulkDeleting ? "Deleting…" : `Delete ${selected.size} selected`}
          </button>
        </div>
      )}
    </div>
  );
}

interface SubmissionDetailViewProps {
  detail: SubmissionDetail;
  deleting: boolean;
  onDelete: () => void;
}

function SubmissionDetailView({ detail, deleting, onDelete }: SubmissionDetailViewProps) {
  const assessed = detail.scores.filter((s) => s.score !== null).length;
  const notAssessedCount = detail.scores.length - assessed;
  const overallPoints = computeOverallPoints(detail.scores);

  // One switch governs the screen, the Markdown download and the print
  // output together: what you see is what you get in the file.
  const [includeFeedback, setIncludeFeedback] = useState(true);

  const downloadMarkdown = () => {
    const md = buildSubmissionMarkdown(detail, includeFeedback);
    downloadBlob(`interview-${detail.studentId}-${submissionDay(detail.startedAt)}.md`, new Blob([md], { type: "text/markdown" }));
  };

  return (
    <div>
      <div className="card">
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
      </div>

      <div className="card no-print">
        <Toggle
          id="detail-include-feedback"
          label="Include scores and feedback (on screen, in the file, and in print)"
          checked={includeFeedback}
          onChange={setIncludeFeedback}
        />
        <div className="btn-row" style={{ marginTop: "0.8rem" }}>
          <button className="btn btn-secondary" type="button" onClick={downloadMarkdown}>
            Download Markdown
          </button>
          <button className="btn btn-secondary" type="button" onClick={() => window.print()}>
            Print / Save as PDF
          </button>
        </div>
        <p className="admin-help">
          Print opens the browser dialog. Choose &ldquo;Save as PDF&rdquo; there for a PDF file.
        </p>
      </div>

      <div className="card">
      <h3>Speaking metrics</h3>
      <table className="kv-table">
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
      </div>

      {includeFeedback && (
      <div className="card">
      <h3>Rubric assessment</h3>
      {detail.overallScore !== null && overallPoints && (
        <p className="overall-score">
          Overall score: {overallPoints.points} / {overallPoints.possible} points (
          {detail.overallScore ??
            Math.round((100 * overallPoints.points) / overallPoints.possible)}
          %)
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
      </div>
      )}

      {includeFeedback && (
      <div className="card">
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
      </div>
      )}

      <div className="card">
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

      {/* Below everything else, so it is never the button a hurried hand
          reaches for. There is no per-row delete in the list above: opening
          this view first is what makes sure the instructor sees what they
          are about to remove. */}
      <div className="danger-zone no-print">
        <button className="btn btn-danger" type="button" disabled={deleting} onClick={onDelete}>
          {deleting ? "Deleting…" : "Delete submission"}
        </button>
        <p className="admin-help">
          Removes this report and its transcript from the dashboard. Emailed copies already sent
          to the student and instructors are not affected.
        </p>
      </div>
    </div>
  );
}
/**
 * The submission as a Markdown file, for the instructor's records. The
 * includeFeedback flag removes the rubric and the feedback, so the file can
 * be passed to a student even when scores are withheld.
 */
function buildSubmissionMarkdown(detail: SubmissionDetail, includeFeedback: boolean): string {
  const lines: string[] = [];
  const overallPoints = computeOverallPoints(detail.scores);

  lines.push(`# Interview report`);
  lines.push(``);
  lines.push(`- Student: ${detail.fullName} (${detail.studentId})`);
  if (detail.cohort) lines.push(`- Cohort: ${detail.cohort}`);
  lines.push(`- Persona: ${detail.personaId}`);
  lines.push(`- Date: ${formatUnixOrMs(detail.startedAt)}`);
  lines.push(`- Duration: ${fmtMs(detail.durationMs)}`);
  lines.push(``);

  lines.push(`## Speaking metrics`);
  lines.push(``);
  lines.push(`| Metric | Value |`);
  lines.push(`| --- | --- |`);
  lines.push(`| Total duration | ${fmtMs(detail.metrics.durationMs)} |`);
  lines.push(`| Student speaking time | ${fmtMs(detail.metrics.studentSpeakingMs)} |`);
  lines.push(`| Interviewee speaking time | ${fmtMs(detail.metrics.intervieweeSpeakingMs)} |`);
  lines.push(`| Talk ratio (student) | ${Math.round(detail.metrics.talkRatioStudent * 100)}% |`);
  lines.push(`| Questions asked | ${detail.metrics.questionsAsked} |`);
  lines.push(`| Student turns / interviewee turns | ${detail.metrics.studentTurns} / ${detail.metrics.intervieweeTurns} |`);
  lines.push(`| Words spoken (student / interviewee) | ${detail.metrics.studentWords} / ${detail.metrics.intervieweeWords} |`);
  lines.push(``);

  if (includeFeedback) {
    lines.push(`## Rubric assessment`);
    lines.push(``);
    if (overallPoints) {
      const pct =
        detail.overallScore ?? Math.round((100 * overallPoints.points) / overallPoints.possible);
      lines.push(`Overall score: **${overallPoints.points} / ${overallPoints.possible} points (${pct}%)**`);
      lines.push(``);
    }
    lines.push(`| Criterion | Score | Justification |`);
    lines.push(`| --- | --- | --- |`);
    for (const c of detail.scores) {
      const score = c.score === null ? "n/a" : `${c.score} / ${c.max ?? 5}`;
      lines.push(`| ${c.name} | ${score} | ${c.justification.replace(/\|/g, "\\|")} |`);
    }
    lines.push(``);

    lines.push(`## Feedback`);
    lines.push(``);
    lines.push(`### Strengths`);
    detail.feedback.strengths.forEach((t) => lines.push(`- ${t}`));
    lines.push(``);
    lines.push(`### Areas to improve`);
    detail.feedback.improvements.forEach((t) => lines.push(`- ${t}`));
    lines.push(``);
    lines.push(`### Notable moments`);
    detail.feedback.moments.forEach((m) => {
      lines.push(`> ${m.quote}`);
      lines.push(``);
      lines.push(m.comment);
      lines.push(``);
    });
    lines.push(`### What the student did not reach`);
    lines.push(detail.feedback.missedDepth);
    lines.push(``);
    lines.push(`### Summary`);
    lines.push(detail.feedback.summary);
    lines.push(``);
  }

  lines.push(`## Transcript`);
  lines.push(``);
  for (const e of detail.transcript) {
    const speaker = e.speaker === "student" ? "Student" : "Interviewee";
    lines.push(`**${speaker}** (${fmtMs(e.tStart)}, spoke ${fmtMs(e.speechMs)})`);
    lines.push(``);
    lines.push(e.text);
    lines.push(``);
  }

  return lines.join("\n");
}
