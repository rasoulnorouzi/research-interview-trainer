import { useEffect, useState } from "react";
import { api } from "./api";

// Who may use this dashboard. Cloudflare Access authenticates the person at
// the door; this list authorizes them (worker/access.ts). Master admins come
// from the Worker configuration and are shown locked: the panel can neither
// add nor remove one, so a handover team can manage assistants here without
// ever being able to lock the owners out.

interface AdminRow {
  email: string;
  note: string | null;
  master: boolean;
  createdAt: number | null;
  createdBy: string | null;
}

interface Props {
  onApiError: (err: unknown) => void;
}

export function Admins({ onApiError }: Props) {
  const [list, setList] = useState<AdminRow[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [note, setNote] = useState("");
  const [addError, setAddError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () => {
    setListError(null);
    api<{ admins: AdminRow[] }>("/admins")
      .then(({ admins }) => setList(admins))
      .catch((err) => {
        setListError(err instanceof Error ? err.message : "Could not load the admin list.");
        onApiError(err);
      });
  };

  useEffect(load, []);

  const add = (e: React.FormEvent) => {
    e.preventDefault();
    setAddError(null);
    setBusy(true);
    api<{ added: boolean }>("/admins", {
      method: "POST",
      body: JSON.stringify({ email: email.trim(), note: note.trim() }),
    })
      .then(() => {
        setEmail("");
        setNote("");
        load();
      })
      .catch((err) => {
        setAddError(err instanceof Error ? err.message : "Could not add the admin.");
        onApiError(err);
      })
      .finally(() => setBusy(false));
  };

  const remove = (row: AdminRow) => {
    if (
      !confirm(
        `Remove ${row.email} from the admin list?\n\nThey lose access to this dashboard at once. This cannot be undone from here; you can add them again later.`,
      )
    ) {
      return;
    }
    setListError(null);
    api<{ deleted: boolean }>(`/admins/${encodeURIComponent(row.email)}`, { method: "DELETE" })
      .then(load)
      .catch((err) => {
        setListError(err instanceof Error ? err.message : "Could not remove the admin.");
        onApiError(err);
      });
  };

  return (
    <div>
      <h2>Admins</h2>

      <div className="card">
        <h3>How admin access works</h3>
        <ul>
          <li>
            A person needs two things to use this dashboard: to pass the Cloudflare Access login,
            and to be on this list.
          </li>
          <li>
            Master admins are set in the Worker configuration. This screen can neither add nor
            remove them, so nobody can lock the owners out.
          </li>
          <li>Everyone else, for example a student assistant, is managed here.</li>
          <li>
            Removing a person here blocks their dashboard access at once. Their Cloudflare Access
            login alone is not enough.
          </li>
        </ul>
      </div>

      {listError && <div className="banner-error">{listError}</div>}
      {list === null && !listError && <p className="small">Loading admins…</p>}
      {list && (
        <div className="admin-table-wrap">
          <table>
            <thead>
              <tr>
                <th>Email</th>
                <th>Note</th>
                <th>Added</th>
                <th>Added by</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {list.map((row) => (
                <tr key={row.email}>
                  <td>{row.email}</td>
                  <td>{row.master ? <span className="chip">Master admin</span> : (row.note ?? "")}</td>
                  <td className="num">
                    {row.createdAt !== null ? new Date(row.createdAt * 1000).toLocaleDateString() : ""}
                  </td>
                  <td>{row.createdBy ?? ""}</td>
                  <td>
                    {!row.master && (
                      <div className="admin-row-actions">
                        <button className="btn btn-danger" type="button" onClick={() => remove(row)}>
                          Remove
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <form className="card" onSubmit={add}>
        <h3>Add an admin</h3>
        {addError && <div className="banner-error">{addError}</div>}
        <div className="admin-toolbar">
          <div className="field">
            <label htmlFor="admin-email">Email address</label>
            <input
              id="admin-email"
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="admin-note">Note (optional)</label>
            <input
              id="admin-note"
              type="text"
              placeholder="student assistant"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </div>
          <button className="btn" type="submit" disabled={busy || email.trim().length === 0}>
            Add admin
          </button>
        </div>
        <p className="admin-help">
          The address must also be allowed through the Cloudflare Access login. See OPERATIONS.md,
          section Manage admins.
        </p>
      </form>
    </div>
  );
}
