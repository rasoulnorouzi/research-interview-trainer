import { useEffect, useState } from "react";
import { Toggle } from "./Toggle";
import { api } from "./api";

interface CriterionListItem {
  id: string;
  name: string;
  scaleMax: number;
  needsGroundTruth: boolean;
  sortOrder: number;
  active: boolean;
  updatedAt: number;
  updatedBy: string | null;
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
  sortOrder: number;
  active: boolean;
  updatedAt: number;
  updatedBy: string | null;
}

interface CriterionVersion {
  id: number;
  savedAt: number;
  savedBy: string | null;
  snapshot: {
    name: string;
    description: string;
    anchorLow: string;
    anchorMid: string;
    anchorHigh: string;
    scaleMax: number;
    needsGroundTruth: boolean;
    sortOrder: number;
    active: boolean;
  } | null;
}

interface EditorForm {
  id: string;
  name: string;
  description: string;
  anchorLow: string;
  anchorMid: string;
  anchorHigh: string;
  scaleMax: number;
  needsGroundTruth: boolean;
  sortOrder: number;
  active: boolean;
}

// Built-in items step by 10 (10, 20, 30, ...), so a new item defaults to one
// slot past the highest existing order rather than colliding at 0 — the
// instructor can still retype it to insert between two existing rows.
const EMPTY_FORM: EditorForm = {
  id: "",
  name: "",
  description: "",
  anchorLow: "",
  anchorMid: "",
  anchorHigh: "",
  scaleMax: 5,
  needsGroundTruth: false,
  sortOrder: 10,
  active: true,
};

type View =
  | { mode: "list" }
  | { mode: "editor"; isNew: boolean }
  | { mode: "history"; criterionId: string };

interface Props {
  onApiError: (err: unknown) => void;
}

export function Rubric({ onApiError }: Props) {
  const [list, setList] = useState<CriterionListItem[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [view, setView] = useState<View>({ mode: "list" });
  const [form, setForm] = useState<EditorForm>(EMPTY_FORM);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [versions, setVersions] = useState<CriterionVersion[] | null>(null);
  const [versionsError, setVersionsError] = useState<string | null>(null);

  const loadList = () => {
    setListError(null);
    api<{ criteria: CriterionListItem[] }>("/criteria")
      .then(({ criteria }) => setList(criteria))
      .catch((err) => {
        setListError(err instanceof Error ? err.message : "Could not load the rubric.");
        onApiError(err);
      });
  };

  useEffect(loadList, []);

  // Drag-and-drop reorder. The row being dragged is remembered by id; dropping
  // on another row moves it there, the whole id list goes to the server, and
  // the reload shows the server's truth.
  const [dragId, setDragId] = useState<string | null>(null);

  const dropOn = (targetId: string) => {
    if (!list || dragId === null || dragId === targetId) {
      setDragId(null);
      return;
    }
    const ids = list.map((c) => c.id);
    const fromIndex = ids.indexOf(dragId);
    const toIndex = ids.indexOf(targetId);
    if (fromIndex < 0 || toIndex < 0) {
      setDragId(null);
      return;
    }
    ids.splice(toIndex, 0, ids.splice(fromIndex, 1)[0]);
    setDragId(null);
    setListError(null);
    api<{ reordered: number }>("/criteria/reorder", { method: "POST", body: JSON.stringify({ ids }) })
      .then(loadList)
      .catch((err) => {
        setListError(err instanceof Error ? err.message : "Could not save the new order.");
        onApiError(err);
        loadList();
      });
  };

  const openNew = () => {
    const nextSortOrder = list && list.length > 0 ? Math.max(...list.map((c) => c.sortOrder)) + 10 : 10;
    setForm({ ...EMPTY_FORM, sortOrder: nextSortOrder });
    setEditorError(null);
    setView({ mode: "editor", isNew: true });
  };

  const openEdit = (id: string) => {
    setEditorError(null);
    api<CriterionFull>(`/criteria/${encodeURIComponent(id)}`)
      .then((c) => {
        setForm({
          id: c.id,
          name: c.name,
          description: c.description,
          anchorLow: c.anchorLow,
          anchorMid: c.anchorMid,
          anchorHigh: c.anchorHigh,
          scaleMax: c.scaleMax,
          needsGroundTruth: c.needsGroundTruth,
          sortOrder: c.sortOrder,
          active: c.active,
        });
        setView({ mode: "editor", isNew: false });
      })
      .catch((err) => {
        setEditorError(err instanceof Error ? err.message : "Could not load the criterion.");
        onApiError(err);
      });
  };

  const openHistory = (id: string) => {
    setVersionsError(null);
    setVersions(null);
    setView({ mode: "history", criterionId: id });
    api<{ versions: CriterionVersion[] }>(`/criteria/${encodeURIComponent(id)}/versions`)
      .then(({ versions }) => setVersions(versions))
      .catch((err) => {
        setVersionsError(err instanceof Error ? err.message : "Could not load version history.");
        onApiError(err);
      });
  };

  const restoreVersion = (v: CriterionVersion, criterionId: string) => {
    if (!v.snapshot) return;
    setForm({
      id: criterionId,
      name: v.snapshot.name,
      description: v.snapshot.description,
      anchorLow: v.snapshot.anchorLow,
      anchorMid: v.snapshot.anchorMid,
      anchorHigh: v.snapshot.anchorHigh,
      scaleMax: v.snapshot.scaleMax,
      needsGroundTruth: v.snapshot.needsGroundTruth,
      sortOrder: v.snapshot.sortOrder,
      active: v.snapshot.active,
    });
    setEditorError(null);
    setView({ mode: "editor", isNew: false });
  };

  const remove = () => {
    if (
      !confirm(
        `Delete criterion ${form.name} (${form.id})? Version history is kept, but the item disappears from the rubric.`,
      )
    ) {
      return;
    }
    setEditorError(null);
    setDeleting(true);
    api<{ deleted: boolean }>(`/criteria/${encodeURIComponent(form.id)}`, { method: "DELETE" })
      .then(() => {
        setView({ mode: "list" });
        loadList();
      })
      .catch((err) => {
        // A 409 names the reason: reports still reference this item, or it is
        // the only active item left. Shown as written rather than replaced.
        setEditorError(err instanceof Error ? err.message : "Could not delete the criterion.");
        onApiError(err);
      })
      .finally(() => setDeleting(false));
  };

  const save = (e: React.FormEvent) => {
    e.preventDefault();
    setEditorError(null);

    // Friendliness only — the server has the authoritative count. `list` may
    // be stale (another tab, another instructor) so a rejected save still
    // falls through to the server's own 400/409 message.
    if (list) {
      const othersActiveCount = list.filter((c) => c.id !== form.id && c.active).length;
      if (form.active && othersActiveCount >= 20) {
        setEditorError("At most 20 items can be active. Deactivate another item first.");
        return;
      }
      if (!form.active && othersActiveCount === 0) {
        setEditorError("At least one item must stay active.");
        return;
      }
    }

    setSaving(true);

    const body = {
      name: form.name,
      description: form.description,
      anchorLow: form.anchorLow,
      anchorMid: form.anchorMid,
      anchorHigh: form.anchorHigh,
      scaleMax: Number(form.scaleMax),
      needsGroundTruth: form.needsGroundTruth,
      sortOrder: Number(form.sortOrder),
      active: form.active,
    };

    const isNew = view.mode === "editor" && view.isNew;
    const request = isNew
      ? api<CriterionFull>("/criteria", { method: "POST", body: JSON.stringify({ id: form.id, ...body }) })
      : api<CriterionFull>(`/criteria/${encodeURIComponent(form.id)}`, { method: "PUT", body: JSON.stringify(body) });

    request
      .then(() => {
        setView({ mode: "list" });
        loadList();
      })
      .catch((err) => {
        setEditorError(err instanceof Error ? err.message : "Could not save the criterion.");
        onApiError(err);
      })
      .finally(() => setSaving(false));
  };

  if (view.mode === "history") {
    return (
      <div>
        <h2>Version history: {view.criterionId}</h2>
        <p className="small">Every save is kept forever.</p>
        <p>
          <button className="btn btn-secondary" type="button" onClick={() => setView({ mode: "list" })}>
            Back to rubric
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
                  <th>Scale</th>
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
                    <td>{v.snapshot ? `1-${v.snapshot.scaleMax}` : ""}</td>
                    <td>{v.snapshot ? (v.snapshot.active ? "Yes" : "No") : ""}</td>
                    <td>
                      <button
                        className="btn btn-secondary"
                        type="button"
                        disabled={!v.snapshot}
                        onClick={() => restoreVersion(v, view.criterionId)}
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
        <h2>{view.isNew ? "New criterion" : `Edit criterion: ${form.id}`}</h2>
        {editorError && <div className="banner-error">{editorError}</div>}
        <form className="card" onSubmit={save}>
          {view.isNew && (
            <div className="field">
              <label htmlFor="criterion-id">ID</label>
              <input
                id="criterion-id"
                type="text"
                required
                pattern="[a-z0-9_-]+"
                minLength={1}
                maxLength={40}
                value={form.id}
                onChange={(e) => setForm((f) => ({ ...f, id: e.target.value }))}
              />
              <p className="admin-help">
                Lowercase letters, digits, underscores and hyphens only, 1 to 40 characters. Used
                in URLs and cannot be changed later.
              </p>
            </div>
          )}
          <div className="field">
            <label htmlFor="criterion-name">Name</label>
            <input
              id="criterion-name"
              type="text"
              required
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            />
          </div>
          <div className="field">
            <label htmlFor="criterion-description">Description</label>
            <textarea
              id="criterion-description"
              required
              value={form.description}
              onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
            />
            <p className="admin-help">
              What behaviour is judged. The evaluator sees this text verbatim.
            </p>
          </div>

          <p className="admin-help">
            The three anchors describe what the transcript looks like at a score of 1, at the
            midpoint, and at the top score. Keep the wording neutral. Do not address the student.
          </p>
          <div className="field">
            <label htmlFor="criterion-anchor-low">What the lowest score (1) looks like</label>
            <textarea
              id="criterion-anchor-low"
              required
              value={form.anchorLow}
              onChange={(e) => setForm((f) => ({ ...f, anchorLow: e.target.value }))}
            />
          </div>
          <div className="field">
            <label htmlFor="criterion-anchor-mid">What the midpoint score looks like</label>
            <textarea
              id="criterion-anchor-mid"
              required
              value={form.anchorMid}
              onChange={(e) => setForm((f) => ({ ...f, anchorMid: e.target.value }))}
            />
          </div>
          <div className="field">
            <label htmlFor="criterion-anchor-high">What the top score looks like</label>
            <textarea
              id="criterion-anchor-high"
              required
              value={form.anchorHigh}
              onChange={(e) => setForm((f) => ({ ...f, anchorHigh: e.target.value }))}
            />
          </div>

          <div className="field">
            <label htmlFor="criterion-scale-max">Top score</label>
            <input
              id="criterion-scale-max"
              type="number"
              required
              min={2}
              max={10}
              step={1}
              value={form.scaleMax}
              onChange={(e) => setForm((f) => ({ ...f, scaleMax: Number(e.target.value) }))}
            />
            <p className="admin-help">
              The item is scored from 1 to this number. Default 5. If you change it, also reword
              the anchors: the midpoint anchor now describes a different score.
            </p>
          </div>
          <div className="field">
            <Toggle
              id="criterion-ground-truth"
              label="Uses hidden core"
              checked={form.needsGroundTruth}
              onChange={(needsGroundTruth) => setForm((f) => ({ ...f, needsGroundTruth }))}
            />
            <p className="admin-help">
              Shows the persona's hidden backstory to this evaluator. Use it only for items that
              judge discovery depth.
            </p>
          </div>
          <div className="field">
            <label htmlFor="criterion-sort-order">Order</label>
            <input
              id="criterion-sort-order"
              type="number"
              required
              step={1}
              value={form.sortOrder}
              onChange={(e) => setForm((f) => ({ ...f, sortOrder: Number(e.target.value) }))}
            />
            <p className="admin-help">
              Lower numbers appear first. Built-in items use 10, 20, 30... so you can insert
              between them.
            </p>
          </div>
          <div className="field">
            <Toggle
              id="criterion-active"
              label="Active (scored on the next interview)"
              checked={form.active}
              onChange={(active) => setForm((f) => ({ ...f, active }))}
            />
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
            for a draft or a duplicate that was never scored against. */}
        {!view.isNew && (
          <div className="danger-zone">
            <button className="btn btn-danger" type="button" disabled={deleting} onClick={remove}>
              {deleting ? "Deleting…" : "Delete criterion"}
            </button>
            <p className="admin-help">
              Deleting is possible only while no reports reference this item and it is not the
              only active item. Version history is kept.
            </p>
          </div>
        )}
      </div>
    );
  }

  return (
    <div>
      <h2>Rubric</h2>

      <div className="card">
        <h3>How the rubric works</h3>
        <ul>
          <li>
            Each item is scored by its own independent evaluator that sees only the transcript
            and that one item.
          </li>
          <li>
            Drag a row by its handle to change the order. The order sets how the report lists
            the items.
          </li>
          <li>Write each item as a description of behaviour that is observable in the transcript.</li>
          <li>
            The three anchors describe what the transcript looks like at a score of 1, at the
            midpoint, and at the top score. Keep the wording neutral. Do not address the student.
          </li>
          <li>
            Each item chooses its own top score (2 to 10, default 5). The overall result is points
            earned out of points possible, shown as a percentage.
          </li>
          <li>
            Changes apply to the next interview. Stored reports keep the rubric and scale they
            were scored with.
          </li>
          <li>
            Each active item adds one evaluator call per report. At most 20 items can be active.
            At least one must stay active.
          </li>
          <li>
            &ldquo;Uses hidden core&rdquo; shows the persona's hidden backstory to that evaluator.
            Use it only for items that judge discovery depth.
          </li>
        </ul>
      </div>

      {listError && <div className="banner-error">{listError}</div>}
      <div className="btn-row" style={{ marginTop: 0, marginBottom: "1rem" }}>
        <button className="btn" type="button" onClick={openNew}>
          New criterion
        </button>
      </div>
      {list === null && !listError && <p className="small">Loading rubric…</p>}
      {list && (
        <div className="admin-table-wrap">
          <table>
            <thead>
              <tr>
                <th></th>
                <th>Order</th>
                <th>Name</th>
                <th>Scale</th>
                <th>Active</th>
                <th>Hidden core</th>
                <th>Updated</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {list.map((c) => (
                <tr
                  key={c.id}
                  className="admin-clickable-row"
                  onClick={() => openEdit(c.id)}
                  draggable
                  onDragStart={() => setDragId(c.id)}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault();
                    dropOn(c.id);
                  }}
                  onDragEnd={() => setDragId(null)}
                >
                  <td className="drag-handle" title="Drag to change the order">≡</td>
                  <td className="num">{c.sortOrder}</td>
                  <td>{c.name}</td>
                  <td>{`1-${c.scaleMax}`}</td>
                  <td>{c.active ? "Yes" : "No"}</td>
                  <td>{c.needsGroundTruth ? "Yes" : "No"}</td>
                  <td className="num">{new Date(c.updatedAt * 1000).toLocaleString()}</td>
                  <td>
                    <button
                      className="btn btn-secondary"
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        openHistory(c.id);
                      }}
                    >
                      View history
                    </button>
                  </td>
                </tr>
              ))}
              {list.length === 0 && (
                <tr>
                  <td colSpan={8} className="small">
                    No rubric items yet.
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
