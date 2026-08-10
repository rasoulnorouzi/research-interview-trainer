import { useState } from "react";
import { ModelChoice, Persona } from "../types";
import { PERSONAS, buildCustomPersona } from "../personas";
import {
  DEFAULT_INTERVIEW_MODEL,
  DEFAULT_SCORING_MODEL,
  INTERVIEW_MODELS,
  SCORING_MODELS,
} from "../models";

const LS_KEY = "riv.apiKey";
const LS_REMEMBER = "riv.rememberKey";
const LS_PERSONA = "riv.lastPersona";
const LS_INTERVIEW_MODEL = "riv.interviewModel";
const LS_SCORING_MODEL = "riv.scoringModel";

export interface StartConfig {
  apiKey: string;
  persona: Persona;
  interviewModel: string;
  scoringModel: string;
}

interface Props {
  onStart: (config: StartConfig) => void;
  initialError: string | null;
}

/** Radio group of model options, each with its tradeoff spelled out. */
function ModelPicker({
  legend,
  choices,
  value,
  onChange,
}: {
  legend: string;
  choices: ModelChoice[];
  value: string;
  onChange: (id: string) => void;
}) {
  return (
    <fieldset className="model-picker">
      <legend>{legend}</legend>
      {choices.map((c) => (
        <label key={c.id} className={value === c.id ? "selected" : ""}>
          <input
            type="radio"
            name={legend}
            checked={value === c.id}
            onChange={() => onChange(c.id)}
          />
          <span>
            {c.label}
            <br />
            <span className="small">{c.note}</span>
          </span>
        </label>
      ))}
    </fieldset>
  );
}

export function SetupScreen({ onStart, initialError }: Props) {
  const remembered = localStorage.getItem(LS_REMEMBER) === "1";
  const [apiKey, setApiKey] = useState(remembered ? localStorage.getItem(LS_KEY) ?? "" : "");
  const [rememberKey, setRememberKey] = useState(remembered);
  const [selectedId, setSelectedId] = useState(
    localStorage.getItem(LS_PERSONA) ?? PERSONAS[0].id
  );
  const [customText, setCustomText] = useState("");
  const [interviewModel, setInterviewModel] = useState(
    localStorage.getItem(LS_INTERVIEW_MODEL) ?? DEFAULT_INTERVIEW_MODEL
  );
  const [scoringModel, setScoringModel] = useState(
    localStorage.getItem(LS_SCORING_MODEL) ?? DEFAULT_SCORING_MODEL
  );

  const isCustom = selectedId === "custom";
  const canStart =
    apiKey.trim().length > 0 && (!isCustom || customText.trim().length > 0);

  const handleStart = () => {
    if (!canStart) return;
    if (rememberKey) {
      localStorage.setItem(LS_KEY, apiKey.trim());
      localStorage.setItem(LS_REMEMBER, "1");
    } else {
      localStorage.removeItem(LS_KEY);
      localStorage.removeItem(LS_REMEMBER);
    }
    localStorage.setItem(LS_PERSONA, selectedId);
    localStorage.setItem(LS_INTERVIEW_MODEL, interviewModel);
    localStorage.setItem(LS_SCORING_MODEL, scoringModel);
    const persona = isCustom
      ? buildCustomPersona(customText)
      : PERSONAS.find((p) => p.id === selectedId)!;
    onStart({ apiKey: apiKey.trim(), persona, interviewModel, scoringModel });
  };

  return (
    <div>
      <h1>Research Interview Trainer</h1>
      <p className="lede">
        Practice qualitative research interviewing by speaking with a simulated
        interviewee. Each interviewee gives a rehearsed account of their reasons
        at first and will only disclose what actually happened to an interviewer
        who earns it by following up, noticing what is left unsaid, and not
        judging. When you end the interview you receive a report: speaking
        metrics, and a rubric assessment that includes how far beneath the
        surface account you managed to get.
      </p>

      {initialError && <div className="banner-error">{initialError}</div>}

      <h2>1. OpenAI API key</h2>
      <div className="field">
        <label htmlFor="apiKey">API key</label>
        <input
          id="apiKey"
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder="sk-…"
          autoComplete="off"
        />
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={rememberKey}
            onChange={(e) => setRememberKey(e.target.checked)}
          />
          Remember this key on this computer
        </label>
        <p className="small">
          The key is stored only in this browser and sent only to OpenAI. This
          app has no server to send it to. Create one at
          platform.openai.com/api-keys.
        </p>
      </div>

      <h2>2. Models</h2>
      <p className="small">
        Both run on your own API credit. The interviewee model is the larger
        cost by far; scoring adds a few cents either way.
      </p>
      <div className="model-grid">
        <ModelPicker
          legend="Interviewee voice"
          choices={INTERVIEW_MODELS}
          value={interviewModel}
          onChange={setInterviewModel}
        />
        <ModelPicker
          legend="Scoring"
          choices={SCORING_MODELS}
          value={scoringModel}
          onChange={setScoringModel}
        />
      </div>

      <h2>3. Choose an interviewee</h2>
      <div className="persona-list">
        {PERSONAS.map((p) => (
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
        <label className={`persona-card ${isCustom ? "selected" : ""}`}>
          <input
            type="radio"
            name="persona"
            checked={isCustom}
            onChange={() => setSelectedId("custom")}
          />
          <span>
            <span className="name">Custom interviewee</span>. Write your own
            <br />
            <span className="small">
              Describe the person to be interviewed: who they are, their story,
              how they behave, and, for a scenario with any depth, what they hold
              back and what it takes to earn it.
            </span>
          </span>
        </label>
      </div>

      {isCustom && (
        <div className="field" style={{ marginTop: "0.75rem" }}>
          <label htmlFor="customPersona">Custom persona description</label>
          <textarea
            id="customPersona"
            value={customText}
            onChange={(e) => setCustomText(e.target.value)}
            placeholder={
              "Example:\n" +
              "You are Maria, 52. You ran a family bakery for 25 years and closed it last year. " +
              "A student researcher is interviewing you about why small family businesses close. " +
              "You are proud and a little defensive about the closure.\n\n" +
              "WHAT YOU SAY FIRST (give freely): the supermarket that opened nearby, rising " +
              "energy costs, the rent increase.\n\n" +
              "WHAT YOU GIVE IF ASKED PROPERLY: the seven-day weeks, your back, the " +
              "Christmas you spent alone in the kitchen.\n\n" +
              "WHAT YOU ONLY SAY TO SOMEONE WHO EARNS IT: your son refused to take the " +
              "bakery over, and you closed it the week he told you. The money was survivable; " +
              "that was not. Only reveal this if the interviewer has followed up on your own " +
              "words, has not judged or advised you, and asks about your family or the future " +
              "of the shop."
            }
          />
        </div>
      )}

      <div className="btn-row">
        <button className="btn" onClick={handleStart} disabled={!canStart}>
          Start interview
        </button>
      </div>
      <p className="small" style={{ marginTop: "0.75rem" }}>
        The interview is voice-only: your browser will ask for microphone
        access. Speak your questions out loud; the interviewee answers with
        voice.
      </p>
    </div>
  );
}
