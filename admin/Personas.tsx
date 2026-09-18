import { useEffect, useRef, useState } from "react";
import { Toggle } from "./Toggle";
import { Help } from "./Help";
import { api, apiBlob } from "./api";
import { REALTIME_VOICES } from "../shared/voices";

interface PersonaListItem {
  id: string;
  name: string;
  title: string;
  active: boolean;
  /** The cohorts this persona is limited to. Empty means every student sees it. */
  cohorts: string[];
  updatedAt: number;
  updatedBy: string | null;
}

/** A cohort on the roster, with its number of active students. */
interface RosterCohort {
  name: string;
  students: number;
}

interface PersonaFull {
  id: string;
  name: string;
  title: string;
  researchTopic: string;
  shortBio: string;
  voiceName: string;
  systemInstruction: string;
  hiddenCore: string | null;
  active: boolean;
  cohorts: string[];
  updatedAt: number;
  updatedBy: string | null;
}

interface PersonaVersion {
  id: number;
  savedAt: number;
  savedBy: string | null;
  snapshot: {
    name: string;
    title: string;
    researchTopic: string;
    shortBio: string;
    voiceName: string;
    systemInstruction: string;
    hiddenCore: string | null;
    active: boolean;
    /** Null for versions saved before personas could be limited to cohorts. */
    cohorts: string[] | null;
  } | null;
}

interface EditorForm {
  id: string;
  name: string;
  title: string;
  researchTopic: string;
  shortBio: string;
  voiceName: string;
  systemInstruction: string;
  hiddenCore: string;
  active: boolean;
  /** False: every student sees the persona. True: only the ticked cohorts. */
  limited: boolean;
  cohorts: string[];
}

// alloy is the first realtime voice and the one the old custom personas used.
// A new persona has to start on some valid voice: the field is a dropdown, so
// an empty string here would show a voice the form is not actually holding.
const EMPTY_FORM: EditorForm = {
  id: "",
  name: "",
  title: "",
  researchTopic: "",
  shortBio: "",
  voiceName: "alloy",
  systemInstruction: "",
  hiddenCore: "",
  active: true,
  limited: false,
  cohorts: [],
};

/** "All students", or the cohort names, for the list and history tables. */
function audienceLabel(cohorts: string[]): string {
  return cohorts.length === 0 ? "All students" : cohorts.join(", ");
}

/** The count shown next to a cohort's checkbox. Null: no student has it now. */
function cohortCount(students: number | null): string {
  if (students === null) return "no student has this cohort now";
  if (students === 0) return "no active students";
  return students === 1 ? "1 student" : `${students} students`;
}

type View =
  | { mode: "list" }
  | { mode: "editor"; isNew: boolean }
  | { mode: "history"; personaId: string };

interface Props {
  onApiError: (err: unknown) => void;
}

export function Personas({ onApiError }: Props) {
  const [list, setList] = useState<PersonaListItem[] | null>(null);
  const [rosterCohorts, setRosterCohorts] = useState<RosterCohort[]>([]);
  const [listError, setListError] = useState<string | null>(null);
  const [view, setView] = useState<View>({ mode: "list" });
  const [form, setForm] = useState<EditorForm>(EMPTY_FORM);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [versions, setVersions] = useState<PersonaVersion[] | null>(null);
  const [versionsError, setVersionsError] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  // One fetched clip per voice, kept for the whole dashboard visit, so
  // clicking through the voices costs one TTS call each rather than one per
  // click. Refs, not state: neither should trigger a render by itself.
  const previewCache = useRef(new Map<string, string>());
  const previewAudio = useRef<HTMLAudioElement | null>(null);

  const previewVoice = async () => {
    const voice = form.voiceName;
    setPreviewError(null);
    previewAudio.current?.pause();
    try {
      let url = previewCache.current.get(voice);
      if (!url) {
        setPreviewLoading(true);
        const blob = await apiBlob("/voice-preview", {
          method: "POST",
          body: JSON.stringify({ voice }),
        });
        url = URL.createObjectURL(blob);
        previewCache.current.set(voice, url);
      }
      const audio = new Audio(url);
      previewAudio.current = audio;
      await audio.play();
    } catch (err) {
      setPreviewError(err instanceof Error ? err.message : "Could not play the voice sample.");
    } finally {
      setPreviewLoading(false);
    }
  };

  const loadList = () => {
    setListError(null);
    api<{ personas: PersonaListItem[]; rosterCohorts: RosterCohort[] }>("/personas")
      .then(({ personas, rosterCohorts }) => {
        setList(personas);
        setRosterCohorts(rosterCohorts);
      })
      .catch((err) => {
        setListError(err instanceof Error ? err.message : "Could not load personas.");
        onApiError(err);
      });
  };

  useEffect(loadList, []);

  const openNew = () => {
    setForm(EMPTY_FORM);
    setEditorError(null);
    setView({ mode: "editor", isNew: true });
  };

  const openEdit = (id: string) => {
    setEditorError(null);
    api<PersonaFull>(`/personas/${encodeURIComponent(id)}`)
      .then((p) => {
        setForm({
          id: p.id,
          name: p.name,
          title: p.title,
          researchTopic: p.researchTopic,
          shortBio: p.shortBio,
          voiceName: p.voiceName,
          systemInstruction: p.systemInstruction,
          hiddenCore: p.hiddenCore ?? "",
          active: p.active,
          limited: p.cohorts.length > 0,
          cohorts: p.cohorts,
        });
        setView({ mode: "editor", isNew: false });
      })
      .catch((err) => {
        setEditorError(err instanceof Error ? err.message : "Could not load the persona.");
        onApiError(err);
      });
  };

  const openHistory = (id: string) => {
    setVersionsError(null);
    setVersions(null);
    setView({ mode: "history", personaId: id });
    api<{ versions: PersonaVersion[] }>(`/personas/${encodeURIComponent(id)}/versions`)
      .then(({ versions }) => setVersions(versions))
      .catch((err) => {
        setVersionsError(err instanceof Error ? err.message : "Could not load version history.");
        onApiError(err);
      });
  };

  const restoreVersion = async (v: PersonaVersion, personaId: string) => {
    if (!v.snapshot) return;
    const snapshot = v.snapshot;
    // A version saved before cohorts existed does not record any. Restoring
    // it keeps the persona's current cohorts, rather than silently opening the
    // persona to every student.
    let cohorts = snapshot.cohorts;
    if (cohorts === null) {
      try {
        cohorts = (await api<PersonaFull>(`/personas/${encodeURIComponent(personaId)}`)).cohorts;
      } catch (err) {
        setVersionsError(err instanceof Error ? err.message : "Could not load the persona.");
        onApiError(err);
        return;
      }
    }
    setForm({
      id: personaId,
      name: snapshot.name,
      title: snapshot.title,
      researchTopic: snapshot.researchTopic,
      shortBio: snapshot.shortBio,
      voiceName: snapshot.voiceName,
      systemInstruction: snapshot.systemInstruction,
      hiddenCore: snapshot.hiddenCore ?? "",
      active: snapshot.active,
      limited: cohorts.length > 0,
      cohorts,
    });
    setEditorError(null);
    setView({ mode: "editor", isNew: false });
  };

  const toggleCohort = (name: string, on: boolean) =>
    setForm((f) => ({
      ...f,
      cohorts: on ? [...f.cohorts, name].sort() : f.cohorts.filter((c) => c !== name),
    }));

  const remove = () => {
    if (
      !confirm(
        `Delete persona ${form.name} (${form.id})? Version history is kept, but the persona disappears from the students' list.`,
      )
    ) {
      return;
    }
    setEditorError(null);
    setDeleting(true);
    api<{ deleted: boolean }>(`/personas/${encodeURIComponent(form.id)}`, { method: "DELETE" })
      .then(() => {
        setView({ mode: "list" });
        loadList();
      })
      .catch((err) => {
        // A 409 carries the server's count of the reports that reference this
        // persona, so it is shown as written rather than replaced.
        setEditorError(err instanceof Error ? err.message : "Could not delete the persona.");
        onApiError(err);
      })
      .finally(() => setDeleting(false));
  };

  const save = (e: React.FormEvent) => {
    e.preventDefault();
    // The server reads an empty list as "every student", so "only these
    // cohorts" with none ticked would open the persona to everyone.
    if (form.limited && form.cohorts.length === 0) {
      setEditorError("Tick at least one cohort, or choose All students.");
      return;
    }
    setEditorError(null);
    setSaving(true);

    const body = {
      name: form.name,
      title: form.title,
      researchTopic: form.researchTopic,
      shortBio: form.shortBio,
      voiceName: form.voiceName,
      systemInstruction: form.systemInstruction,
      hiddenCore: form.hiddenCore.trim().length > 0 ? form.hiddenCore : null,
      active: form.active,
      cohorts: form.limited ? form.cohorts : [],
    };

    const isNew = view.mode === "editor" && view.isNew;
    const request = isNew
      ? api<PersonaFull>("/personas", { method: "POST", body: JSON.stringify({ id: form.id, ...body }) })
      : api<PersonaFull>(`/personas/${encodeURIComponent(form.id)}`, { method: "PUT", body: JSON.stringify(body) });

    request
      .then(() => {
        setView({ mode: "list" });
        loadList();
      })
      .catch((err) => {
        setEditorError(err instanceof Error ? err.message : "Could not save the persona.");
        onApiError(err);
      })
      .finally(() => setSaving(false));
  };

  if (view.mode === "history") {
    return (
      <div>
        <h2>Version history: {view.personaId}</h2>
        <p className="small">Every save is kept forever.</p>
        <p>
          <button className="btn btn-secondary" type="button" onClick={() => setView({ mode: "list" })}>
            Back to personas
          </button>
        </p>
        {versionsError && <div className="banner-error">{versionsError}</div>}
        {versions === null && !versionsError && <p className="small">Loading history…</p>}
        {versions && versions.length === 0 && <p className="small">No saved versions yet.</p>}
        {versions && versions.length > 0 && (
          <div className="admin-table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Saved</th>
                  <th>Saved by</th>
                  <th>Name</th>
                  <th>Shown to</th>
                  <th>Active</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {versions.map((v) => (
                  <tr key={v.id}>
                    <td className="num">{new Date(v.savedAt * 1000).toLocaleString()}</td>
                    <td>{v.savedBy ?? ""}</td>
                    <td>{v.snapshot?.name ?? ""}</td>
                    <td>{v.snapshot?.cohorts ? audienceLabel(v.snapshot.cohorts) : "Not recorded"}</td>
                    <td>{v.snapshot ? (v.snapshot.active ? "Yes" : "No") : ""}</td>
                    <td>
                      <button
                        className="btn btn-secondary"
                        type="button"
                        disabled={!v.snapshot}
                        onClick={() => restoreVersion(v, view.personaId)}
                      >
                        Restore this version
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    );
  }

  if (view.mode === "editor") {
    // The roster's cohorts, plus any this persona is still limited to that no
    // student carries now (a renamed or finished cohort), so it stays visible
    // and can be unticked.
    const cohortChoices: { name: string; students: number | null }[] = [
      ...rosterCohorts,
      ...form.cohorts
        .filter((c) => !rosterCohorts.some((r) => r.name === c))
        .map((name) => ({ name, students: null })),
    ];

    return (
      <div>
        <h2>{view.isNew ? "New persona" : `Edit persona: ${form.id}`}</h2>
        {editorError && <div className="banner-error">{editorError}</div>}
        <form className="card" onSubmit={save}>
          {view.isNew && (
            <div className="field">
              <label htmlFor="persona-id">ID</label>
              <input
                id="persona-id"
                type="text"
                required
                value={form.id}
                onChange={(e) => setForm((f) => ({ ...f, id: e.target.value }))}
              />
              <p className="admin-help">
                Lowercase letters, digits and hyphens only, 1 to 40 characters. Used in URLs and
                cannot be changed later.
              </p>
            </div>
          )}
          <div className="field">
            <label htmlFor="persona-name">Name</label>
            <input
              id="persona-name"
              type="text"
              required
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            />
          </div>
          <div className="field">
            <label htmlFor="persona-title">Title</label>
            <input
              id="persona-title"
              type="text"
              required
              value={form.title}
              onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
            />
          </div>
          <div className="field">
            <label htmlFor="persona-topic">Research topic</label>
            <input
              id="persona-topic"
              type="text"
              required
              value={form.researchTopic}
              onChange={(e) => setForm((f) => ({ ...f, researchTopic: e.target.value }))}
            />
          </div>
          <div className="field">
            <label htmlFor="persona-bio">Short bio</label>
            <textarea
              id="persona-bio"
              required
              value={form.shortBio}
              onChange={(e) => setForm((f) => ({ ...f, shortBio: e.target.value }))}
            />
            <p className="admin-warn">
              Students see this before the interview. Keep it free of anything they are supposed
              to discover.
            </p>
          </div>
          <div className="field">
            <label htmlFor="persona-voice">Voice</label>
            <div className="admin-toolbar">
              <div className="field">
                <select
                  id="persona-voice"
                  style={{ font: "inherit" }}
                  required
                  value={form.voiceName}
                  onChange={(e) => {
                    setPreviewError(null);
                    setForm((f) => ({ ...f, voiceName: e.target.value }));
                  }}
                >
                  {/* A voice that predates this list is kept rather than swapped
                      for the first entry, the same way the settings form keeps an
                      unknown model id. The server rejects it on save, which is the
                      point at which the instructor should be told. */}
                  {!(REALTIME_VOICES as readonly string[]).includes(form.voiceName) && (
                    <option value={form.voiceName}>{`(current) ${form.voiceName}`}</option>
                  )}
                  {REALTIME_VOICES.map((voice) => (
                    <option key={voice} value={voice}>
                      {voice}
                    </option>
                  ))}
                </select>
              </div>
              <button
                className="btn btn-secondary"
                type="button"
                disabled={previewLoading || !(REALTIME_VOICES as readonly string[]).includes(form.voiceName)}
                onClick={previewVoice}
              >
                {previewLoading ? "Loading…" : "Preview voice"}
              </button>
            </div>
            {previewError && <p className="admin-warn">{previewError}</p>}
            <p className="admin-help">
              marin and cedar are the most natural of these. The built-in personas use marin,
              cedar and coral. Preview plays a short sample sentence in the chosen voice;
              listen before casting a persona in a new voice.
            </p>
          </div>
          <div className="field">
            <label htmlFor="persona-instruction">System instruction</label>
            <textarea
              id="persona-instruction"
              className="admin-large"
              required
              value={form.systemInstruction}
              onChange={(e) => setForm((f) => ({ ...f, systemInstruction: e.target.value }))}
            />
          </div>
          <div className="field">
            <label htmlFor="persona-hidden-core">
              Hidden core
              <Help label="Hidden core">
            <p>What this persona is really hiding, written for the AI assessor. Students never see it.</p>
          </Help>
            </label>
            <textarea
              id="persona-hidden-core"
              className="admin-large"
              value={form.hiddenCore}
              onChange={(e) => setForm((f) => ({ ...f, hiddenCore: e.target.value }))}
            />
            <p className="admin-help">
              Leave empty only if you accept weaker depth scoring. The two discovery criteria
              fall back to judging from the transcript alone.
            </p>
          </div>
          <div className="field">
            <Toggle
              id="persona-active"
              label="Active (shown to students)"
              checked={form.active}
              onChange={(active) => setForm((f) => ({ ...f, active }))}
            />
          </div>
          <div className="field" role="radiogroup" aria-labelledby="persona-audience">
            <label id="persona-audience">
              Who sees this persona
              <Help label="Who sees this persona">
            <p>With no cohort selected, every student sees this interviewee. Select cohorts to limit it to them.</p>
          </Help>
            </label>
            <label className="checkbox-row">
              <input
                type="radio"
                name="persona-audience"
                checked={!form.limited}
                onChange={() => setForm((f) => ({ ...f, limited: false }))}
              />
              All students
            </label>
            <label className="checkbox-row">
              <input
                type="radio"
                name="persona-audience"
                checked={form.limited}
                onChange={() => setForm((f) => ({ ...f, limited: true }))}
              />
              Only students in these cohorts
            </label>
            {form.limited && (
              <div style={{ marginLeft: "1.6rem" }}>
                {cohortChoices.map((c) => (
                  <label key={c.name} className="checkbox-row">
                    <input
                      type="checkbox"
                      checked={form.cohorts.includes(c.name)}
                      onChange={(e) => toggleCohort(c.name, e.target.checked)}
                    />
                    <span>
                      {c.name} <span className="small">({cohortCount(c.students)})</span>
                    </span>
                  </label>
                ))}
                {cohortChoices.length === 0 && (
                  <p className="admin-warn">
                    No student has a cohort yet. Give students a cohort on the Students screen,
                    or in the cohort column of the CSV import, and then come back here.
                  </p>
                )}
                {cohortChoices.length > 0 && form.cohorts.length === 0 && (
                  <p className="admin-warn">Tick at least one cohort, or choose All students.</p>
                )}
              </div>
            )}
            <p className="admin-help">
              Cohorts come from the Cohort column on the Students screen. A student without a
              cohort sees only the personas for all students. A change applies the next time a
              student opens the page.
            </p>
          </div>

          <div className="btn-row">
            <button className="btn" type="submit" disabled={saving}>
              {saving ? "Saving…" : "Save"}
            </button>
            <button className="btn btn-secondary" type="button" onClick={() => setView({ mode: "list" })}>
              Cancel
            </button>
            {!view.isNew && (
              <button className="btn btn-secondary" type="button" onClick={() => openHistory(form.id)}>
                View history
              </button>
            )}
          </div>
        </form>

        {/* Outside the form and well below Save, so it is never the button a
            hurried hand reaches for. Deactivating is the usual answer; this is
            for a draft or a duplicate that was never interviewed. */}
        {!view.isNew && (
          <div className="danger-zone">
            <button className="btn btn-danger" type="button" disabled={deleting} onClick={remove}>
              {deleting ? "Deleting…" : "Delete persona"}
            </button>
            <p className="admin-help">
              Deleting is possible only while no reports reference this persona. Version history
              is kept.
            </p>
          </div>
        )}
      </div>
    );
  }

  return (
    <div>
      <h2>Personas</h2>
      {listError && <div className="banner-error">{listError}</div>}
      <div className="btn-row" style={{ marginTop: 0, marginBottom: "1rem" }}>
        <button className="btn" type="button" onClick={openNew}>
          New persona
        </button>
      </div>
      {list === null && !listError && <p className="small">Loading personas…</p>}
      {list && (
        <div className="admin-table-wrap">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Title</th>
                <th>Shown to</th>
                <th>Active</th>
                <th>Updated</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {list.map((p) => (
                <tr key={p.id} className="admin-clickable-row" onClick={() => openEdit(p.id)}>
                  <td>{p.name}</td>
                  <td>{p.title}</td>
                  <td>{audienceLabel(p.cohorts)}</td>
                  <td>{p.active ? "Yes" : "No"}</td>
                  <td className="num">{new Date(p.updatedAt * 1000).toLocaleString()}</td>
                  <td>
                    <button
                      className="btn btn-secondary"
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        openHistory(p.id);
                      }}
                    >
                      View history
                    </button>
                  </td>
                </tr>
              ))}
              {list.length === 0 && (
                <tr>
                  <td colSpan={6} className="small">
                    No personas yet.
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
