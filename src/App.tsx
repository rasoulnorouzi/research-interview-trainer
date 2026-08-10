import { useState } from "react";
import { SessionResult } from "./types";
import { SetupScreen, StartConfig } from "./screens/SetupScreen";
import { InterviewScreen } from "./screens/InterviewScreen";
import { ResultsScreen } from "./screens/ResultsScreen";

type Phase = "setup" | "interview" | "results";

export default function App() {
  const [phase, setPhase] = useState<Phase>("setup");
  const [config, setConfig] = useState<StartConfig | null>(null);
  const [result, setResult] = useState<SessionResult | null>(null);
  const [setupError, setSetupError] = useState<string | null>(null);

  const handleStart = (next: StartConfig) => {
    setSetupError(null);
    setConfig(next);
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
          model={config.interviewModel}
          onEnd={handleEnd}
          onAbort={handleAbort}
        />
      )}
      {phase === "results" && config && result && (
        <ResultsScreen
          result={result}
          apiKey={config.apiKey}
          persona={config.persona}
          scoringModel={config.scoringModel}
          onNewInterview={handleNewInterview}
        />
      )}
    </div>
  );
}
