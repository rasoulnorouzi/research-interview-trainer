import { useEffect, useState } from "react";
import { api } from "./api";

interface SettingEntry {
  value: string;
  updatedAt: number;
  updatedBy: string | null;
}

type SettingsView = Record<string, SettingEntry>;

const NUMERIC_KEYS = ["interview_limit_minutes", "interview_warn_minutes", "sessions_per_day"] as const;
const TEXT_KEYS = ["interview_model", "scoring_model", "instructor_recipients"] as const;

interface FormState {
  interview_limit_minutes: string;
  interview_warn_minutes: string;
  sessions_per_day: string;
  interview_model: string;
  scoring_model: string;
  instructor_recipients: string;
}

const EMPTY_FORM: FormState = {
  interview_limit_minutes: "",
  interview_warn_minutes: "",
  sessions_per_day: "",
  interview_model: "",
  scoring_model: "",
  instructor_recipients: "",
};

interface Props {
  onApiError: (err: unknown) => void;
}

export function Settings({ onApiError }: Props) {
  const [settings, setSettings] = useState<SettingsView | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const load = () => {
    setLoading(true);
    setError(null);
    api<{ settings: SettingsView }>("/settings")
      .then(({ settings }) => {
        setSettings(settings);
        setForm({
          interview_limit_minutes: settings.interview_limit_minutes?.value ?? "",
          interview_warn_minutes: settings.interview_warn_minutes?.value ?? "",
          sessions_per_day: settings.sessions_per_day?.value ?? "",
          interview_model: settings.interview_model?.value ?? "",
          scoring_model: settings.scoring_model?.value ?? "",
          instructor_recipients: settings.instructor_recipients?.value ?? "",
        });
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : "Could not load settings.");
        onApiError(err);
      })
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

  const setField = (key: keyof FormState, value: string) => {
    setSaved(false);
    setForm((f) => ({ ...f, [key]: value }));
  };

  // Client-side warning ahead of the server's own check, so a mismatched pair
  // is caught before the round trip rather than after.
  const limitNum = Number(form.interview_limit_minutes);
  const warnNum = Number(form.interview_warn_minutes);
  const warnTooHigh =
    form.interview_limit_minutes.length > 0 &&
    form.interview_warn_minutes.length > 0 &&
    Number.isFinite(limitNum) &&
    Number.isFinite(warnNum) &&
    warnNum >= limitNum;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSaved(false);
    if (warnTooHigh) {
      setError("The warning threshold must be less than the interview time limit.");
      return;
    }

    const payload: Record<string, string | number> = {};
    for (const key of NUMERIC_KEYS) {
      const current = settings?.[key]?.value ?? "";
      if (form[key] !== current && form[key].trim().length > 0) payload[key] = Number(form[key]);
    }
    for (const key of TEXT_KEYS) {
      const current = settings?.[key]?.value ?? "";
      if (form[key] !== current) payload[key] = form[key];
    }
    if (apiKeyInput.trim().length > 0) payload.openai_api_key = apiKeyInput.trim();

    if (Object.keys(payload).length === 0) {
      setError("Nothing changed.");
      return;
    }

    setSaving(true);
    api<{ settings: SettingsView }>("/settings", { method: "PUT", body: JSON.stringify(payload) })
      .then(({ settings }) => {
        setSettings(settings);
        setForm({
          interview_limit_minutes: settings.interview_limit_minutes?.value ?? "",
          interview_warn_minutes: settings.interview_warn_minutes?.value ?? "",
          sessions_per_day: settings.sessions_per_day?.value ?? "",
          interview_model: settings.interview_model?.value ?? "",
          scoring_model: settings.scoring_model?.value ?? "",
          instructor_recipients: settings.instructor_recipients?.value ?? "",
        });
        setApiKeyInput("");
        setSaved(true);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : "Could not save settings.");
        onApiError(err);
      })
      .finally(() => setSaving(false));
  };

  if (loading) return <p className="small">Loading settings…</p>;

  const keyPlaceholder = settings?.openai_api_key?.value ?? "Not set";

  return (
    <div>
      <h2>Settings</h2>
      {error && <div className="banner-error">{error}</div>}
      {saved && <div className="banner-info">Saved.</div>}

      <form onSubmit={submit}>
        <div className="field">
          <label htmlFor="interview_limit_minutes">Interview time limit (minutes)</label>
          <input
            id="interview_limit_minutes"
            type="number"
            min={1}
            step={1}
            value={form.interview_limit_minutes}
            onChange={(e) => setField("interview_limit_minutes", e.target.value)}
          />
        </div>

        <div className="field">
          <label htmlFor="interview_warn_minutes">Warning countdown starts at (minutes)</label>
          <input
            id="interview_warn_minutes"
            type="number"
            min={1}
            step={1}
            value={form.interview_warn_minutes}
            onChange={(e) => setField("interview_warn_minutes", e.target.value)}
          />
          {warnTooHigh && (
            <p className="admin-warn">The warning threshold must be less than the time limit.</p>
          )}
        </div>

        <div className="field">
          <label htmlFor="sessions_per_day">Interview sessions per student per day</label>
          <input
            id="sessions_per_day"
            type="number"
            min={1}
            step={1}
            value={form.sessions_per_day}
            onChange={(e) => setField("sessions_per_day", e.target.value)}
          />
        </div>

        <div className="field">
          <label htmlFor="interview_model">Interview (realtime) model id</label>
          <input
            id="interview_model"
            type="text"
            value={form.interview_model}
            onChange={(e) => setField("interview_model", e.target.value)}
          />
        </div>

        <div className="field">
          <label htmlFor="scoring_model">Scoring model id</label>
          <input
            id="scoring_model"
            type="text"
            value={form.scoring_model}
            onChange={(e) => setField("scoring_model", e.target.value)}
          />
        </div>

        <div className="field">
          <label htmlFor="instructor_recipients">Instructor recipients</label>
          <input
            id="instructor_recipients"
            type="text"
            value={form.instructor_recipients}
            onChange={(e) => setField("instructor_recipients", e.target.value)}
          />
          <p className="admin-help">
            Comma-separated email addresses. Every finished interview report is emailed to
            all of them.
          </p>
        </div>

        <div className="field">
          <label htmlFor="openai_api_key">OpenAI API key</label>
          <input
            id="openai_api_key"
            type="password"
            placeholder={keyPlaceholder}
            value={apiKeyInput}
            onChange={(e) => {
              setSaved(false);
              setApiKeyInput(e.target.value);
            }}
            autoComplete="off"
          />
          <p className="admin-help">
            Write only. The stored key is never shown. Leave empty to keep the current key.
          </p>
        </div>

        <div className="btn-row">
          <button className="btn" type="submit" disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </form>
    </div>
  );
}
