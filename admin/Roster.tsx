import { useEffect, useState } from "react";
import { api } from "./api";

interface Student {
  studentId: string;
  email: string;
  fullName: string;
  cohort: string | null;
  active: boolean;
  createdAt: number;
}

interface ImportResult {
  mode: "preview" | "apply";
  new: number;
  changed: number;
  unchanged: number;
  invalid: { line: number; reason: string }[];
}

type ListState =
  | { status: "loading" }
  | { status: "done"; students: Student[] }
  | { status: "error"; message: string };

interface Props {
  onApiError: (err: unknown) => void;
}

const NEW_STUDENT_FORM = { studentId: "", email: "", fullName: "", cohort: "" };

export function Roster({ onApiError }: Props) {
  const [q, setQ] = useState("");
  const [cohortFilter, setCohortFilter] = useState("");
  const [state, setState] = useState<ListState>({ status: "loading" });
  const [addForm, setAddForm] = useState(NEW_STUDENT_FORM);
  const [addError, setAddError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState({ email: "", fullName: "", cohort: "" });
  const [editError, setEditError] = useState<string | null>(null);
  const [editSaving, setEditSaving] = useState(false);
  // One row's failed action, shown on that row. Only one can be pending at a
  // time, so a single slot is enough.
  const [rowError, setRowError] = useState<{ studentId: string; message: string } | null>(null);

  // Checkbox selection for bulk removal, by student id.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkRemoving, setBulkRemoving] = useState(false);
  const [bulkMessage, setBulkMessage] = useState<string | null>(null);

  const [csv, setCsv] = useState("");
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [importBusy, setImportBusy] = useState(false);

  const load = () => {
    setSelected(new Set());
    setState({ status: "loading" });
    const params = new URLSearchParams();
    if (q.trim().length > 0) params.set("q", q.trim());
    if (cohortFilter.trim().length > 0) params.set("cohort", cohortFilter.trim());
    const qs = params.toString();
    api<{ students: Student[] }>(`/roster${qs ? `?${qs}` : ""}`)
      .then(({ students }) => setState({ status: "done", students }))
      .catch((err) => {
        setState({ status: "error", message: err instanceof Error ? err.message : "Could not load the roster." });
        onApiError(err);
      });
  };

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, []);

  const search = (e: React.FormEvent) => {
    e.preventDefault();
    load();
  };

  const addStudent = (e: React.FormEvent) => {
    e.preventDefault();
    setAddError(null);
    setAdding(true);
    api<Student>("/roster", {
      method: "POST",
      body: JSON.stringify({
        studentId: addForm.studentId.trim(),
        email: addForm.email.trim(),
        fullName: addForm.fullName.trim(),
        cohort: addForm.cohort.trim(),
      }),
    })
      .then(() => {
        setAddForm(NEW_STUDENT_FORM);
        load();
      })
      .catch((err) => {
        setAddError(err instanceof Error ? err.message : "Could not add the student.");
        onApiError(err);
      })
      .finally(() => setAdding(false));
  };

  const startEdit = (s: Student) => {
    setEditingId(s.studentId);
    setEditError(null);
    setEditForm({ email: s.email, fullName: s.fullName, cohort: s.cohort ?? "" });
  };

  const saveEdit = (studentId: string) => {
    setEditError(null);
    setEditSaving(true);
    api<Student>(`/roster/${encodeURIComponent(studentId)}`, {
      method: "PATCH",
      body: JSON.stringify({
        email: editForm.email.trim(),
        fullName: editForm.fullName.trim(),
        cohort: editForm.cohort.trim(),
      }),
    })
      .then(() => {
        setEditingId(null);
        load();
      })
      .catch((err) => {
        setEditError(err instanceof Error ? err.message : "Could not save changes.");
        onApiError(err);
      })
      .finally(() => setEditSaving(false));
  };

  const deactivate = (s: Student) => {
    if (!confirm(`Deactivate ${s.fullName} (${s.studentId})? Their login will be blocked. Reports are kept.`)) {
      return;
    }
    api<{ studentId: string }>(`/roster/${encodeURIComponent(s.studentId)}`, { method: "DELETE" })
      .then(load)
      .catch((err) => onApiError(err));
  };

  /**
   * The real delete (?hard=1), for a student who was added by mistake. The
   * server refuses with a 409 the moment any report references them, and that
   * message names the number of reports, so it is shown on the row as written.
   */
  const remove = (s: Student) => {
    if (
      !confirm(
        `Remove ${s.fullName} (${s.studentId}) permanently?\n\nThis deletes the roster row, their login codes and their session grants. It cannot be undone. It only works when the student has no stored reports.`,
      )
    ) {
      return;
    }
    setRowError(null);
    api<{ deleted: boolean }>(`/roster/${encodeURIComponent(s.studentId)}?hard=1`, { method: "DELETE" })
      .then(load)
      .catch((err) => {
        setRowError({
          studentId: s.studentId,
          message: err instanceof Error ? err.message : "Could not remove the student.",
        });
        onApiError(err);
      });
  };

  /**
   * Clear the student's session grants so the total quota opens up again.
   * Reports are untouched; this is the "give this student another interview"
   * control.
   */
  const resetSessions = (s: Student) => {
    if (
      !confirm(
        `Reset the interview sessions of ${s.fullName} (${s.studentId})?\n\nTheir used-session count goes back to zero and they can start interviews again. Reports are kept. This cannot be undone.`,
      )
    ) {
      return;
    }
    setRowError(null);
    api<{ cleared: number }>(`/roster/${encodeURIComponent(s.studentId)}/reset-sessions`, { method: "POST" })
      .then((r) => {
        setRowError({
          studentId: s.studentId,
          message: r.cleared > 0 ? "Sessions reset. The student can interview again." : "Nothing to reset. The student has not used any sessions.",
        });
      })
      .catch((err) => {
        setRowError({
          studentId: s.studentId,
          message: err instanceof Error ? err.message : "Could not reset the sessions.",
        });
        onApiError(err);
      });
  };

  const toggleSelected = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const bulkRemove = (students: Student[]) => {
    if (selected.size === 0) return;
    const n = selected.size;
    if (
      !confirm(
        `Remove ${n} ${n === 1 ? "student" : "students"} permanently?\n\nThis deletes their roster rows, login codes and session grants. It cannot be undone. Students with stored reports are not removed; the result names them, and you can deactivate them instead.`,
      )
    ) {
      return;
    }
    setBulkRemoving(true);
    setBulkMessage(null);
    api<{ deleted: number; kept: { studentId: string; reports: number }[] }>(`/roster/bulk-remove`, {
      method: "POST",
      body: JSON.stringify({ ids: [...selected] }),
    })
      .then((r) => {
        const keptNote =
          r.kept.length > 0
            ? ` Kept (have reports): ${r.kept.map((k) => `${k.studentId} (${k.reports})`).join(", ")}.`
            : "";
        setBulkMessage(`Removed ${r.deleted} ${r.deleted === 1 ? "student" : "students"}.${keptNote}`);
        load();
      })
      .catch((err) => {
        setBulkMessage(err instanceof Error ? err.message : "Could not remove the selected students.");
        onApiError(err);
      })
      .finally(() => setBulkRemoving(false));
  };

  const reactivate = (s: Student) => {
    api<Student>(`/roster/${encodeURIComponent(s.studentId)}`, {
      method: "PATCH",
      body: JSON.stringify({ active: true }),
    })
      .then(load)
      .catch((err) => onApiError(err));
  };

  const runImport = (mode: "preview" | "apply") => {
    setImportError(null);
    setImportBusy(true);
    api<ImportResult>("/roster/import", { method: "POST", body: JSON.stringify({ csv, mode }) })
      .then((result) => {
        setImportResult(result);
        if (mode === "apply") load();
      })
      .catch((err) => {
        setImportError(err instanceof Error ? err.message : "Import failed.");
        onApiError(err);
      })
      .finally(() => setImportBusy(false));
  };

  return (
    <div>
      <h2>Students</h2>

      <form className="card admin-toolbar" onSubmit={search}>
        <div className="field">
          <label htmlFor="roster-q">Search</label>
          <input
            id="roster-q"
            type="text"
            placeholder="Student ID, email or name"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="roster-cohort">Cohort</label>
          <input
            id="roster-cohort"
            type="text"
            value={cohortFilter}
            onChange={(e) => setCohortFilter(e.target.value)}
          />
        </div>
        <button className="btn btn-secondary" type="submit">
          Search
        </button>
      </form>

      {state.status === "loading" && <p className="small">Loading roster…</p>}
      {state.status === "error" && <div className="banner-error">{state.message}</div>}
      {state.status === "done" && (
        <div className="admin-table-wrap">
          <table>
            <thead>
              <tr>
                <th>
                  <input
                    type="checkbox"
                    aria-label="Select all students in the list"
                    checked={state.students.length > 0 && selected.size === state.students.length}
                    onChange={() =>
                      setSelected((prev) =>
                        prev.size === state.students.length
                          ? new Set<string>()
                          : new Set(state.students.map((s) => s.studentId)),
                      )
                    }
                  />
                </th>
                <th>Student ID</th>
                <th>Email</th>
                <th>Full name</th>
                <th>Cohort</th>
                <th>Active</th>
                <th>Created</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {state.students.map((s) =>
                editingId === s.studentId ? (
                  <tr key={s.studentId}>
                    <td></td>
                    <td>{s.studentId}</td>
                    <td>
                      <input
                        type="email"
                        value={editForm.email}
                        onChange={(e) => setEditForm((f) => ({ ...f, email: e.target.value }))}
                      />
                    </td>
                    <td>
                      <input
                        type="text"
                        value={editForm.fullName}
                        onChange={(e) => setEditForm((f) => ({ ...f, fullName: e.target.value }))}
                      />
                    </td>
                    <td>
                      <input
                        type="text"
                        value={editForm.cohort}
                        onChange={(e) => setEditForm((f) => ({ ...f, cohort: e.target.value }))}
                      />
                    </td>
                    <td>{s.active ? "Yes" : "No"}</td>
                    <td className="num">{new Date(s.createdAt * 1000).toLocaleDateString()}</td>
                    <td>
                      <div className="admin-row-actions">
                        <button
                          className="btn"
                          type="button"
                          disabled={editSaving}
                          onClick={() => saveEdit(s.studentId)}
                        >
                          Save
                        </button>
                        <button
                          className="btn btn-secondary"
                          type="button"
                          onClick={() => setEditingId(null)}
                        >
                          Cancel
                        </button>
                      </div>
                      {editError && <p className="admin-warn">{editError}</p>}
                    </td>
                  </tr>
                ) : (
                  <tr key={s.studentId}>
                    <td>
                      <input
                        type="checkbox"
                        aria-label={`Select ${s.fullName}`}
                        checked={selected.has(s.studentId)}
                        onChange={() => toggleSelected(s.studentId)}
                      />
                    </td>
                    <td>{s.studentId}</td>
                    <td>{s.email}</td>
                    <td>{s.fullName}</td>
                    <td>{s.cohort ?? ""}</td>
                    <td>{s.active ? "Yes" : "No"}</td>
                    <td className="num">{new Date(s.createdAt * 1000).toLocaleDateString()}</td>
                    <td>
                      <div className="admin-row-actions">
                        <button className="btn btn-secondary" type="button" onClick={() => startEdit(s)}>
                          Edit
                        </button>
                        {s.active ? (
                          <button className="btn btn-danger" type="button" onClick={() => deactivate(s)}>
                            Deactivate
                          </button>
                        ) : (
                          <button className="btn btn-secondary" type="button" onClick={() => reactivate(s)}>
                            Reactivate
                          </button>
                        )}
                        <button className="btn btn-secondary" type="button" onClick={() => resetSessions(s)}>
                          Reset sessions
                        </button>
                        <button className="btn btn-danger" type="button" onClick={() => remove(s)}>
                          Remove
                        </button>
                      </div>
                      {rowError?.studentId === s.studentId && (
                        <p className="admin-warn">{rowError.message}</p>
                      )}
                    </td>
                  </tr>
                )
              )}
              {state.students.length === 0 && (
                <tr>
                  <td colSpan={7} className="small">
                    No students match.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
      {bulkMessage && <div className="banner-info" style={{ marginTop: "0.8rem" }}>{bulkMessage}</div>}
      {state.status === "done" && selected.size > 0 && (
        <div className="btn-row" style={{ marginTop: "0.8rem" }}>
          <button
            className="btn btn-danger"
            type="button"
            disabled={bulkRemoving}
            onClick={() => bulkRemove(state.students)}
          >
            {bulkRemoving ? "Removing…" : `Remove ${selected.size} selected`}
          </button>
        </div>
      )}

      <div className="card">
      <h2>Add a student</h2>
      {addError && <div className="banner-error">{addError}</div>}
      <form onSubmit={addStudent}>
        <div className="admin-toolbar">
          <div className="field">
            <label htmlFor="new-student-id">Student ID</label>
            <input
              id="new-student-id"
              type="text"
              required
              value={addForm.studentId}
              onChange={(e) => setAddForm((f) => ({ ...f, studentId: e.target.value }))}
            />
          </div>
          <div className="field">
            <label htmlFor="new-email">Email</label>
            <input
              id="new-email"
              type="email"
              required
              value={addForm.email}
              onChange={(e) => setAddForm((f) => ({ ...f, email: e.target.value }))}
            />
          </div>
          <div className="field">
            <label htmlFor="new-full-name">Full name</label>
            <input
              id="new-full-name"
              type="text"
              required
              value={addForm.fullName}
              onChange={(e) => setAddForm((f) => ({ ...f, fullName: e.target.value }))}
            />
          </div>
          <div className="field">
            <label htmlFor="new-cohort">Cohort</label>
            <input
              id="new-cohort"
              type="text"
              value={addForm.cohort}
              onChange={(e) => setAddForm((f) => ({ ...f, cohort: e.target.value }))}
            />
          </div>
          <button className="btn" type="submit" disabled={adding}>
            {adding ? "Adding…" : "Add student"}
          </button>
        </div>
      </form>
      </div>

      <div className="card">
      <h2>Import from CSV</h2>
      <p className="small">
        Header row: student_id,email,full_name,cohort (cohort column optional). Preview shows
        what would change before anything is written.
      </p>
      {importError && <div className="banner-error">{importError}</div>}
      <div className="field">
        <label htmlFor="import-csv">CSV</label>
        <textarea
          id="import-csv"
          className="admin-large"
          value={csv}
          onChange={(e) => {
            setCsv(e.target.value);
            setImportResult(null);
          }}
          placeholder={"student_id,email,full_name,cohort\ns1234,student@example.edu,Jordan Lee,2026-2027-S1"}
        />
      </div>
      <div className="btn-row">
        <button
          className="btn btn-secondary"
          type="button"
          disabled={importBusy || csv.trim().length === 0}
          onClick={() => runImport("preview")}
        >
          Preview
        </button>
        {importResult && importResult.mode === "preview" && (
          <button className="btn" type="button" disabled={importBusy} onClick={() => runImport("apply")}>
            Apply import
          </button>
        )}
      </div>

      {importResult && (
        <div className="banner-info">
          <p>
            {importResult.mode === "preview" ? "Preview" : "Applied"}: {importResult.new} new,{" "}
            {importResult.changed} changed, {importResult.unchanged} unchanged.
          </p>
          {importResult.invalid.length > 0 && (
            <>
              <p>Invalid lines:</p>
              <ul>
                {importResult.invalid.map((problem, i) => (
                  <li key={i}>
                    {problem.line > 0 ? `Line ${problem.line}: ` : ""}
                    {problem.reason}
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
      </div>
    </div>
  );
}
