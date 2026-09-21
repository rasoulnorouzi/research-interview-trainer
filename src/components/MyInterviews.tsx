import { useEffect, useState } from "react";
import { api } from "../api";
import { fmtMs } from "../lib/metrics";
import { buildMarkdownReport } from "../screens/ResultsScreen";
import type { MySubmission } from "../types";

// The student's own earlier interviews, each downloadable (instructor
// request, 2026-09-21). Shown on the home screen, where a student lands after
// logging in, and under the report right after they submit.
//
// It reads GET /api/my-submissions, which only ever returns the caller's own
// rows and applies the instructor's share setting on the server: with scores
// withheld, nothing here can show one, because none arrived.

interface Props {
  /** Change it to reload the list, for example after a new submission. */
  refreshKey?: number;
  /** Hide the whole card when there is nothing yet (the home screen). */
  hideWhenEmpty?: boolean;
}

export function MyInterviews({ refreshKey = 0, hideWhenEmpty = false }: Props) {
  const [items, setItems] = useState<MySubmission[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    api<{ submissions: MySubmission[] }>("/api/my-submissions")
      .then((data) => live && setItems(data.submissions))
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [refreshKey]);

  if (failed) return null;
  if (items === null) return null;
  if (items.length === 0 && hideWhenEmpty) return null;

  return (
    <div className="card history rise no-print">
      <h2>Your interviews</h2>
      {items.length === 0 ? (
        <p className="small">No interviews submitted yet.</p>
      ) : (
        <ul className="history-list">
          {items.map((s) => (
            <li key={s.id} className="history-row">
              <span className="history-main">
                <strong>{s.personaName}</strong>
                <span className="small">
                  {new Date(s.startedAt).toLocaleString([], {
                    day: "numeric",
                    month: "short",
                    hour: "2-digit",
                    minute: "2-digit",
                  })}{" "}
                  · {fmtMs(s.durationMs)}
                </span>
              </span>
              {s.shared && s.overall !== null ? (
                <span className="history-score">{Math.round(s.overall)}%</span>
              ) : null}
              <button className="btn btn-secondary history-download" type="button" onClick={() => download(s)}>
                Download
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** The same Markdown file the results screen offers, rebuilt from the stored report. */
function download(s: MySubmission) {
  const md = buildMarkdownReport(
    {
      transcript: s.transcript,
      startedAt: s.startedAt,
      endedAt: s.startedAt + s.durationMs,
      intervieweeAudioMs: s.metrics.intervieweeSpeakingMs,
      studentSpeechMs: s.metrics.studentSpeakingMs,
    },
    s.metrics,
    { id: "", name: s.personaName, title: s.personaTitle, researchTopic: s.researchTopic, shortBio: "" },
    { scores: s.scores, feedback: s.feedback, overall: s.overall, emailed: true, shared: s.shared },
    s.transcriptConsent,
  );
  const url = URL.createObjectURL(new Blob([md], { type: "text/markdown" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `interview-report-${new Date(s.startedAt).toISOString().slice(0, 10)}.md`;
  a.click();
  URL.revokeObjectURL(url);
}
