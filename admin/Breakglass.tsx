import { useState } from "react";
import { api } from "./api";

interface BreakglassResponse {
  url: string;
  expiresInMinutes: number;
  studentId: string;
  fullName: string;
}

interface Props {
  onApiError: (err: unknown) => void;
}

export function Breakglass({ onApiError }: Props) {
  const [studentId, setStudentId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<BreakglassResponse | null>(null);
  const [copied, setCopied] = useState(false);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setResult(null);
    setCopied(false);
    setBusy(true);
    api<BreakglassResponse>("/breakglass", {
      method: "POST",
      body: JSON.stringify({ studentId: studentId.trim() }),
    })
      .then(setResult)
      .catch((err) => {
        setError(err instanceof Error ? err.message : "Could not create a link.");
        onApiError(err);
      })
      .finally(() => setBusy(false));
  };

  const fullUrl = result ? window.location.origin + result.url : "";

  const copy = () => {
    navigator.clipboard.writeText(fullUrl).then(() => setCopied(true));
  };

  return (
    <div>
      <h2>Break-glass login</h2>
      <p>
        A student who cannot receive the login email gets a direct link. The link works once and
        expires in 15 minutes.
      </p>

      {error && <div className="banner-error">{error}</div>}

      <form onSubmit={submit}>
        <div className="field">
          <label htmlFor="breakglass-student-id">Student ID</label>
          <input
            id="breakglass-student-id"
            type="text"
            required
            value={studentId}
            onChange={(e) => setStudentId(e.target.value)}
          />
        </div>
        <div className="btn-row">
          <button className="btn" type="submit" disabled={busy}>
            {busy ? "Creating…" : "Create link"}
          </button>
        </div>
      </form>

      {result && (
        <div className="banner-info">
          <p>
            {result.fullName} ({result.studentId}). Expires in {result.expiresInMinutes} minutes.
          </p>
          <div className="admin-copy-box">
            <span>{fullUrl}</span>
          </div>
          <div className="btn-row">
            <button className="btn btn-secondary" type="button" onClick={copy}>
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
          <p className="small">Send this link to the student yourself. It logs their browser in as them.</p>
        </div>
      )}
    </div>
  );
}
