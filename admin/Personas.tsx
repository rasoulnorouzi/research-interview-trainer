import { useEffect, useState } from "react";
import { api } from "./api";

interface PersonaListItem {
  id: string;
  name: string;
  title: string;
  active: boolean;
  updatedAt: number;
  updatedBy: string | null;
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
}

const EMPTY_FORM: EditorForm = {
  id: "",
  name: "",
  title: "",
  researchTopic: "",
  shortBio: "",
  voiceName: "",
  systemInstruction: "",
  hiddenCore: "",
  active: true,
};

type View =
  | { mode: "list" }
  | { mode: "editor"; isNew: boolean }
  | { mode: "history"; personaId: string };

interface Props {
  onApiError: (err: unknown) => void;
}

export function Personas({ onApiError }: Props) {
  const [list, setList] = useState<PersonaListItem[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [view, setView] = useState<View>({ mode: "list" });
  const [form, setForm] = useState<EditorForm>(EMPTY_FORM);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [versions, setVersions] = useState<PersonaVersion[] | null>(null);
  const [versionsError, setVersionsError] = useState<string | null>(null);

  const loadList = () => {
    setListError(null);
    api<{ personas: PersonaListItem[] }>("/personas")
      .then(({ personas }) => setList(personas))
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

  const restoreVersion = (v: PersonaVersion, personaId: string) => {
    if (!v.snapshot) return;
    setForm({
      id: personaId,
      name: v.snapshot.name,
      title: v.snapshot.title,
      researchTopic: v.snapshot.researchTopic,
      shortBio: v.snapshot.shortBio,
      voiceName: v.snapshot.voiceName,
      systemInstruction: v.snapshot.systemInstruction,
      hiddenCore: v.snapshot.hiddenCore ?? "",
      active: v.snapshot.active,
    });
    setEditorError(null);
    setView({ mode: "editor", isNew: false });
  };

  const save = (e: React.FormEvent) => {
    e.preventDefault();
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
    return (
      <div>
        <h2>{view.isNew ? "New persona" : `Edit persona: ${form.id}`}</h2>
        {editorError && <div className="banner-error">{editorError}</div>}
        <form onSubmit={save}>
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
            <label htmlFor="persona-voice">Voice name</label>
            <input
              id="persona-voice"
              type="text"
              required
              value={form.voiceName}
              onChange={(e) => setForm((f) => ({ ...f, voiceName: e.target.value }))}
            />
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
            <label htmlFor="persona-hidden-core">Hidden core</label>
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
            <label className="checkbox-row" htmlFor="persona-active">
              <input
                id="persona-active"
                type="checkbox"
                checked={form.active}
                onChange={(e) => setForm((f) => ({ ...f, active: e.target.checked }))}
              />
              Active (shown to students)
            </label>
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
                  <td colSpan={5} className="small">
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
