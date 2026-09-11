import { useEffect, useState } from "react";
import { PersonaSummary } from "../types";
import { api } from "../api";
import { StartConfig } from "../App";
import { DEFAULT_PANEL_TEXT, PanelText } from "../panel";

const LS_PERSONA = "riv.lastPersona";
// Left behind by the pre-backend build, when the student supplied their own
// API key and chose both models. Cleared once, so no stale key lingers in a
// student's browser.
const DEAD_KEYS = ["riv.apiKey", "riv.rememberKey", "riv.interviewModel", "riv.scoringModel"];

interface Props {
  onStart: (config: StartConfig) => void;
  initialError: string | null;
  /** The instructor's welcome panel from /api/me: null for the default, "" for none. */
  panel: string | null;
}

type PersonaState =
  | { status: "loading" }
  | { status: "done"; personas: PersonaSummary[] }
  | { status: "error"; message: string };

export function SetupScreen({ onStart, initialError, panel }: Props) {
  const [state, setState] = useState<PersonaState>({ status: "loading" });
  const [selectedId, setSelectedId] = useState(localStorage.getItem(LS_PERSONA) ?? "");

  useEffect(() => {
    for (const key of DEAD_KEYS) localStorage.removeItem(key);
  }, []);

  const load = () => {
    setState({ status: "loading" });
    api<PersonaSummary[]>("/api/personas")
      .then((personas) => {
        setState({ status: "done", personas });
        setSelectedId((current) =>
          personas.some((p) => p.id === current) ? current : (personas[0]?.id ?? "")
        );
      })
      .catch((err: Error) => setState({ status: "error", message: err.message }));
  };

  useEffect(load, []);

  const handleStart = () => {
    if (state.status !== "done") return;
    const persona = state.personas.find((p) => p.id === selectedId);
    if (!persona) return;
    localStorage.setItem(LS_PERSONA, persona.id);
    onStart({ persona });
  };

  return (
    <div>
      {initialError && <div className="banner-error">{initialError}</div>}

      {/* The instructor writes this panel in the dashboard. Null means none is
          saved yet, so the built-in text shows; an emptied panel shows nothing. */}
      {(panel ?? DEFAULT_PANEL_TEXT).trim().length > 0 && (
        <div className="card">
          <PanelText text={panel ?? DEFAULT_PANEL_TEXT} />
        </div>
      )}

      <div className="card">
        <h2>Choose your interviewee</h2>

        {state.status === "loading" && <p className="small">Loading interviewees…</p>}

        {state.status === "error" && (
          <div>
            <div className="banner-error">{state.message}</div>
            <button className="btn btn-secondary" type="button" onClick={load}>
              Try again
            </button>
          </div>
        )}

        {state.status === "done" && (
          <>
            {/* Personas can be limited to cohorts, so the list is empty for a
                student when no persona is open to their cohort. */}
            {state.personas.length === 0 && (
              <p className="small">No interviewees are available to you yet. Ask your instructor.</p>
            )}
            <div className="persona-list">
              {state.personas.map((p) => (
                <label
                  key={p.id}
                  className={`persona-card ${selectedId === p.id ? "selected" : ""}`}
                >
                  <input
                    type="radio"
                    name="persona"
                    checked={selectedId === p.id}
                    onChange={() => setSelectedId(p.id)}
                  />
                  <span>
                    <span className="name">{p.name}</span>. {p.title}
                    <br />
                    <span className="topic">Research topic: {p.researchTopic}</span>
                    <br />
                    <span className="small">{p.shortBio}</span>
                  </span>
                </label>
              ))}
            </div>

            <div className="btn-row">
              <button className="btn" onClick={handleStart} disabled={!selectedId}>
                Start interview
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
