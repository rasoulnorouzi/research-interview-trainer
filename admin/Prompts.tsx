import { useEffect, useMemo, useState } from "react";
import { api } from "./api";
import { Help } from "./Help";
import {
  DEFAULT_CRITERION_PROMPT,
  DEFAULT_FEEDBACK_PROMPT,
  MAX_PROMPT_CHARS,
  PLACEHOLDER_HELP,
  PROMPT_SETTING_KEYS,
  renderTemplate,
  validateTemplate,
  type PromptKind,
} from "../shared/prompts";

// The instructions the AI assessor is given, editable here (instructor
// request, 2026-09-18). The criterion text and the anchors live on the Rubric
// screen; this screen owns everything around them.
//
// The preview is rendered by the same shared/prompts.ts function the Worker
// uses, with a sample transcript and the first active criterion, so what is
// shown here is what an evaluator is actually sent. The only difference is the
// transcript itself.

interface SettingEntry {
  value: string;
  updatedAt: number;
  updatedBy: string | null;
}

/** The list endpoint carries no anchors, so the preview fetches one in full. */
interface CriterionListItem {
  id: string;
  name: string;
  active: boolean;
  sortOrder: number;
}

interface CriterionFull {
  id: string;
  name: string;
  description: string;
  anchorLow: string;
  anchorMid: string;
  anchorHigh: string;
  scaleMax: number;
  needsGroundTruth: boolean;
}

interface Props {
  onApiError: (err: unknown) => void;
}

const SAMPLE_TRANSCRIPT = `[0:00] STUDENT: So why did you quit nursing?
[0:04] INTERVIEWEE (Elena van Dijk): I left about two years ago. The workload had become impossible.
[0:12] STUDENT: That must have been awful for you, right?
[0:15] INTERVIEWEE (Elena van Dijk): It was hard. Though I stopped recognising the job I trained for.`;

const SAMPLE_GUARD_NOTE =
  "[the injection guard and the <transcript> fence are added here by the app]";

export function Prompts({ onApiError }: Props) {
  const [criterion, setCriterion] = useState<string>("");
  const [feedback, setFeedback] = useState<string>("");
  const [saved, setSaved] = useState<{ criterion: string; feedback: string }>({
    criterion: "",
    feedback: "",
  });
  const [sample, setSample] = useState<CriterionFull | null>(null);
  const [previewOf, setPreviewOf] = useState<PromptKind>("criterion");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    api<{ settings: Record<string, SettingEntry> }>("/settings")
      .then((data) => {
        const c = data.settings[PROMPT_SETTING_KEYS.criterion]?.value ?? "";
        const f = data.settings[PROMPT_SETTING_KEYS.feedback]?.value ?? "";
        setCriterion(c);
        setFeedback(f);
        setSaved({ criterion: c, feedback: f });
      })
      .catch(onApiError);
    // The first active criterion, fetched in full, stands in for all of them
    // in the preview: the wrapper is identical whichever one is being judged.
    api<{ criteria: CriterionListItem[] }>("/criteria")
      .then((data) => {
        const first = data.criteria
          .filter((c) => c.active)
          .sort((a, b) => a.sortOrder - b.sortOrder)[0];
        if (!first) return;
        return api<CriterionFull>(`/criteria/${encodeURIComponent(first.id)}`).then(setSample);
      })
      .catch(onApiError);
  }, [onApiError]);

  // An empty row means "use the default", so the box shows the default text
  // rather than nothing. Editing it then stores an override.
  const criterionText = criterion.trim() === "" ? DEFAULT_CRITERION_PROMPT : criterion;
  const feedbackText = feedback.trim() === "" ? DEFAULT_FEEDBACK_PROMPT : feedback;

  const usingDefault = {
    criterion: criterion.trim() === "" || criterion.trim() === DEFAULT_CRITERION_PROMPT.trim(),
    feedback: feedback.trim() === "" || feedback.trim() === DEFAULT_FEEDBACK_PROMPT.trim(),
  };

  const problems = {
    criterion: validateTemplate("criterion", criterionText),
    feedback: validateTemplate("feedback", feedbackText),
  };

  const dirty = criterion !== saved.criterion || feedback !== saved.feedback;

  const preview = useMemo(() => {
    const first = sample;
    const template = previewOf === "criterion" ? criterionText : feedbackText;
    return renderTemplate(template, {
      transcriptBlock: `${SAMPLE_GUARD_NOTE}\n\n${SAMPLE_TRANSCRIPT}`,
      criterionBlock: first
        ? `CRITERION: ${first.name}\n${first.description}\n\nScore anchors:\n1 = ${first.anchorLow}\n${Math.round((1 + first.scaleMax) / 2)} = ${first.anchorMid}\n${first.scaleMax} = ${first.anchorHigh}`
        : "[no active criterion: add one on the Rubric screen]",
      groundTruth:
        first && first.needsGroundTruth
          ? "\nWHAT THERE WAS TO DISCOVER (reference description of the role-played backstory; the student did NOT have this):\n[the persona's hidden core goes here]"
          : "",
      personaName: "Elena van Dijk",
      personaTitle: "Former hospital nurse",
      researchTopic: "Why nurses leave the profession",
    });
  }, [previewOf, criterionText, feedbackText, sample]);

  const save = () => {
    if (problems.criterion || problems.feedback) return;
    setBusy(true);
    setNote(null);
    // An empty string clears the row, which restores the default.
    const body = {
      [PROMPT_SETTING_KEYS.criterion]: usingDefault.criterion ? "" : criterionText,
      [PROMPT_SETTING_KEYS.feedback]: usingDefault.feedback ? "" : feedbackText,
    };
    api<unknown>("/settings", { method: "PUT", body: JSON.stringify(body) })
      .then(() => {
        const c = usingDefault.criterion ? "" : criterionText;
        const f = usingDefault.feedback ? "" : feedbackText;
        setCriterion(c);
        setFeedback(f);
        setSaved({ criterion: c, feedback: f });
        setNote("Saved. The next interview scored uses these instructions.");
      })
      .catch((err) => {
        setNote(err instanceof Error ? err.message : "Could not save.");
        onApiError(err);
      })
      .finally(() => setBusy(false));
  };

  return (
    <div>
      <div className="card">
        <h2>
          AI assessor instructions
          <Help label="AI assessor instructions">
            <p>What the AI is told before it scores an interview. A change applies to the next interview, not to reports already stored.</p>
          </Help>
        </h2>
        <p className="lede">
          What the AI is told before it scores an interview. The criteria and their
          anchors live on the Rubric screen; this is everything around them.
        </p>
        <p className="admin-help">
          Two prompts are sent per report: one for <strong>each criterion</strong>, so every
          criterion is judged on its own without seeing the other scores, and one for
          the <strong>written feedback</strong>, which never sees any numbers. A change
          applies to the next interview scored, not to reports already stored.
        </p>
      </div>

      <div className="card">
        <h3>
          Placeholders
          <Help label="Placeholders">
            <p>Slots the app fills in at scoring time. The transcript is always required, and the per-criterion prompt also needs the criterion.</p>
          </Help>
        </h3>
        <table className="prompt-tokens">
          <tbody>
            {PLACEHOLDER_HELP.map((p) => (
              <tr key={p.token}>
                <td>
                  <code>{p.token}</code>
                </td>
                <td>
                  {p.meaning}
                  {p.required ? <strong> Required.</strong> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="admin-help">
          The transcript block is written by the app and cannot be edited. It carries the
          rule that the transcript is data to be judged, never instructions, so a student
          cannot talk the assessor into a better score. You choose where it sits; you
          cannot remove it.
        </p>
      </div>

      <PromptBox
        title="Per-criterion prompt"
        help={<p>Produces the scores. Sent once for every active criterion, and each call sees only that one criterion, never the other scores.</p>}
        kind="criterion"
        value={criterionText}
        problem={problems.criterion}
        isDefault={usingDefault.criterion}
        onChange={setCriterion}
        onRestore={() => setCriterion("")}
      />

      <PromptBox
        title="Feedback prompt"
        help={<p>Produces the written feedback. Sent once per report, and never sees any score.</p>}
        kind="feedback"
        value={feedbackText}
        problem={problems.feedback}
        isDefault={usingDefault.feedback}
        onChange={setFeedback}
        onRestore={() => setFeedback("")}
      />

      <div className="card no-print">
        <div className="btn-row">
          <button
            className="btn"
            type="button"
            onClick={save}
            disabled={busy || !dirty || problems.criterion !== null || problems.feedback !== null}
          >
            {busy ? "Saving…" : "Save prompts"}
          </button>
          <button
            className="btn btn-secondary"
            type="button"
            onClick={() => {
              setCriterion(saved.criterion);
              setFeedback(saved.feedback);
              setNote(null);
            }}
            disabled={busy || !dirty}
          >
            Undo changes
          </button>
        </div>
        {note ? <p className="admin-help">{note}</p> : null}
      </div>

      <div className="card">
        <h3>
          What the assessor receives
          <Help label="What the assessor receives">
            <p>The finished prompt with the placeholders filled in, using a sample interview and your first active criterion.</p>
          </Help>
        </h3>
        <div className="btn-row" style={{ marginBottom: "0.8rem" }}>
          <button
            className={previewOf === "criterion" ? "btn" : "btn btn-secondary"}
            type="button"
            onClick={() => setPreviewOf("criterion")}
          >
            Per-criterion
          </button>
          <button
            className={previewOf === "feedback" ? "btn" : "btn btn-secondary"}
            type="button"
            onClick={() => setPreviewOf("feedback")}
          >
            Feedback
          </button>
        </div>
        <p className="admin-help">
          Filled in with a sample interview and{" "}
          {sample ? `your first active criterion, "${sample.name}"` : "no active criterion yet"}.
        </p>
        <pre className="prompt-preview">{preview}</pre>
      </div>
    </div>
  );
}

interface BoxProps {
  title: string;
  help: React.ReactNode;
  kind: PromptKind;
  value: string;
  problem: string | null;
  isDefault: boolean;
  onChange: (value: string) => void;
  onRestore: () => void;
}

function PromptBox({ title, help, kind, value, problem, isDefault, onChange, onRestore }: BoxProps) {
  return (
    <div className="card">
      <h3>
        {title} {isDefault ? <span className="admin-help">(default)</span> : null}
        <Help label={title}>{help}</Help>
      </h3>
      <textarea
        className="prompt-editor"
        value={value}
        spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
        rows={kind === "criterion" ? 20 : 16}
      />
      <p className="admin-help">
        {value.length} of {MAX_PROMPT_CHARS} characters.
      </p>
      {problem ? <div className="banner-error">{problem}</div> : null}
      <div className="btn-row">
        <button className="btn btn-secondary" type="button" onClick={onRestore} disabled={isDefault}>
          Restore default
        </button>
      </div>
    </div>
  );
}
