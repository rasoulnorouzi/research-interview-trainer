import { useState } from "react";
import { Persona, SessionResult } from "./types";
import { SetupScreen } from "./screens/SetupScreen";
import { InterviewScreen } from "./screens/InterviewScreen";
import { ResultsScreen } from "./screens/ResultsScreen";

type Phase = "setup" | "interview" | "results";

interface Config {
  apiKey: string;
  persona: Persona;
}

export default function App() {
  const [phase, setPhase] = useState<Phase>("setup");
  const [config, setConfig] = useState<Config | null>(null);
  const [result, setResult] = useState<SessionResult | null>(null);
  const [setupError, setSetupError] = useState<string | null>(null);

  const handleStart = (apiKey: string, persona: Persona) => {
    setSetupError(null);
    setConfig({ apiKey, persona });
    setResult(null);
    setPhase("interview");
  };

  const handleEnd = (sessionResult: SessionResult) => {
    setResult(sessionResult);
    setPhase("results");
  };

  const handleAbort = (message: string) => {
    setSetupError(message);
    setPhase("setup");
  };

  const handleNewInterview = () => {
    setResult(null);
    setSetupError(null);
    setPhase("setup");
  };

  return (
    <div className="page">
      {phase === "setup" && <SetupScreen onStart={handleStart} initialError={setupError} />}
      {phase === "interview" && config && (
        <InterviewScreen
          apiKey={config.apiKey}
          persona={config.persona}
          onEnd={handleEnd}
          onAbort={handleAbort}
        />
      )}
      {phase === "results" && config && result && (
        <ResultsScreen
          result={result}
          apiKey={config.apiKey}
          persona={config.persona}
          onNewInterview={handleNewInterview}
        />
      )}
    </div>
  );
}
