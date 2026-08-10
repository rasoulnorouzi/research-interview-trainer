import { useState } from "react";
import { Persona } from "../types";
import { PERSONAS, buildCustomPersona } from "../personas";

const LS_KEY = "riv.apiKey";
const LS_REMEMBER = "riv.rememberKey";
const LS_PERSONA = "riv.lastPersona";

interface Props {
  onStart: (apiKey: string, persona: Persona) => void;
  initialError: string | null;
}

export function SetupScreen({ onStart, initialError }: Props) {
  const remembered = localStorage.getItem(LS_REMEMBER) === "1";
  const [apiKey, setApiKey] = useState(remembered ? localStorage.getItem(LS_KEY) ?? "" : "");
  const [rememberKey, setRememberKey] = useState(remembered);
  const [selectedId, setSelectedId] = useState(
    localStorage.getItem(LS_PERSONA) ?? PERSONAS[0].id
  );
  const [customText, setCustomText] = useState("");

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
    const persona = isCustom
      ? buildCustomPersona(customText)
      : PERSONAS.find((p) => p.id === selectedId)!;
    onStart(apiKey.trim(), persona);
  };

  return (
    <div>
      <h1>Research Interview Trainer</h1>
      <p className="lede">
        Practice qualitative research interviewing by speaking with a simulated
        interviewee. Each interviewee gives a rehearsed account of their reasons
        at first and will only disclose what actually happened to an interviewer
        who earns it — by following up, noticing what is left unsaid, and not
        judging. When you end the interview you receive a report: speaking
        metrics, and a rubric assessment that includes how far beneath the
        surface account you managed to get.
      </p>

      {initialError && <div className="banner-error">{initialError}</div>}

      <h2>1. Gemini API key</h2>
      <div className="field">
        <label htmlFor="apiKey">API key</label>
        <input
          id="apiKey"
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder="Paste your Gemini API key"
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
          The key is stored only in this browser and sent only to Google. You can
          get a free key at aistudio.google.com.
        </p>
      </div>

      <h2>2. Choose an interviewee</h2>
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
              <span className="name">{p.name}</span> — {p.title}
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
            <span className="name">Custom interviewee</span> — write your own
            <br />
            <span className="small">
              Describe the person to be interviewed: who they are, their story,
              how they behave — and, for a scenario with real depth, what they
              hold back and what it takes to earn it.
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
