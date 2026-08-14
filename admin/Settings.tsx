import { useEffect, useState } from "react";
import { api } from "./api";
import { INTERVIEW_MODEL_OPTIONS, SCORING_MODEL_OPTIONS } from "../shared/models";
import type { ModelChoice } from "../shared/types";

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

/**
 * A model setting as a dropdown over the curated list (shared/models.ts), with
 * the chosen model's tradeoff spelled out underneath.
 *
 * A stored id that is not in the list is kept as an extra option rather than
 * discarded. The server accepts any non-empty model string, so a value set
 * straight in the database is a working configuration, and a form that
 * silently replaced it with the first list entry would change which model the
 * course runs on without anyone deciding to.
 */
function ModelSelect({
  id,
  label,
  options,
  value,
  onChange,
}: {
  id: string;
  label: string;
  options: ModelChoice[];
  value: string;
  onChange: (value: string) => void;
}) {
  const selected = options.find((option) => option.id === value);
  const note = selected
    ? selected.note
    : value.length === 0
      ? "Not set. Interviews run on the built-in default until you choose one."
      : "Set outside the dashboard. It stays in use until you choose from the list.";

  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <select
        id={id}
        style={{ font: "inherit" }}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        {value.length === 0 && <option value="">Not set</option>}
        {value.length > 0 && !selected && <option value={value}>{`(current) ${value}`}</option>}
        {options.map((option) => (
          <option key={option.id} value={option.id}>
            {option.label}
          </option>
        ))}
      </select>
      <p className="admin-help">{note}</p>
    </div>
  );
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

  const removeKey = () => {
    if (!window.confirm("Remove the stored key? Students cannot start or submit interviews until a new key is saved.")) return;
    setSaving(true);
    setError(null);
    api<{ settings: SettingsView }>("/settings", {
      method: "PUT",
      body: JSON.stringify({ openai_api_key: null }),
    })
      .then(({ settings }) => {
        setSettings(settings);
        setApiKeyInput("");
        setSaved(true);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Could not remove the key."))
      .finally(() => setSaving(false));
  };

  if (loading) return <p className="small">Loading settings…</p>;

  const keyEntry = settings?.openai_api_key ?? null;

  return (
    <div>
      <h2>Settings</h2>
      {error && <div className="banner-error">{error}</div>}
      {saved && <div className="banner-info">Saved.</div>}

      <form className="card" onSubmit={submit}>
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

        <ModelSelect
          id="interview_model"
          label="Interview (realtime) model"
          options={INTERVIEW_MODEL_OPTIONS}
          value={form.interview_model}
          onChange={(value) => setField("interview_model", value)}
        />

        <ModelSelect
          id="scoring_model"
          label="Scoring model"
          options={SCORING_MODEL_OPTIONS}
          value={form.scoring_model}
          onChange={(value) => setField("scoring_model", value)}
        />

        <div className="field">
          <label htmlFor="instructor_recipients">Assessment recipients</label>
          <input
            id="instructor_recipients"
            type="text"
            value={form.instructor_recipients}
            onChange={(e) => setField("instructor_recipients", e.target.value)}
          />
          <p className="admin-help">
            Comma separated email addresses of the assessors. When a student submits an
            interview, the full report (scores, feedback, and the complete interview
            transcript) is emailed to every address here. The student also receives
            their own copy at their roster email address.
          </p>
        </div>

        <div className="field">
          <label htmlFor="openai_api_key">OpenAI API key</label>
          {keyEntry ? (
            <p className="admin-help">
              A key is set: {keyEntry.value}. Saved by {keyEntry.updatedBy ?? "unknown"} on{" "}
              {new Date(keyEntry.updatedAt * 1000).toISOString().slice(0, 10)}. For safety the
              full key is never shown again.
            </p>
          ) : (
            <p className="admin-help">
              No key is set. Students cannot start or submit interviews until one is saved.
            </p>
          )}
          <input
            id="openai_api_key"
            type="password"
            placeholder={keyEntry ? "Enter a new key to replace the current one" : "sk-..."}
            value={apiKeyInput}
            onChange={(e) => {
              setSaved(false);
              setApiKeyInput(e.target.value);
            }}
            autoComplete="off"
          />
          <p className="admin-help">
            Type a key here and click Save to store it. The key is tested against OpenAI
            before it is stored. Leave this field empty to keep the current key.
          </p>
          {keyEntry && (
            <button
              className="btn btn-danger"
              type="button"
              disabled={saving}
              onClick={removeKey}
            >
              Remove key
            </button>
          )}
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
