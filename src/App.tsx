import { useEffect, useState } from "react";
import { MeResponse, PersonaSummary, SessionResult } from "./types";
import { api } from "./api";
import { LoginScreen } from "./screens/LoginScreen";
import { SetupScreen } from "./screens/SetupScreen";
import { InterviewScreen } from "./screens/InterviewScreen";
import { ResultsScreen } from "./screens/ResultsScreen";

type Phase = "login" | "setup" | "interview" | "results";

/** What the setup screen hands to the interview. The persona is a picker
 *  summary; the instructions, the voice and both model ids live server-side. */
export interface StartConfig {
  persona: PersonaSummary;
}

export default function App() {
  const [checking, setChecking] = useState(true);
  const [phase, setPhase] = useState<Phase>("login");
  const [me, setMe] = useState<MeResponse | null>(null);
  const [config, setConfig] = useState<StartConfig | null>(null);
  const [result, setResult] = useState<SessionResult | null>(null);
  const [setupError, setSetupError] = useState<string | null>(null);

  // One session check on load, so a remembered device goes straight to setup.
  useEffect(() => {
    api<MeResponse>("/api/me")
      .then((who) => {
        setMe(who);
        setPhase("setup");
      })
      .catch(() => setPhase("login"))
      .finally(() => setChecking(false));
  }, []);

  const handleLoggedIn = (who: MeResponse) => {
    setMe(who);
    setSetupError(null);
    setPhase("setup");
  };

  const handleLogout = () => {
    api("/api/auth/logout", { method: "POST" }).catch(() => {
      // The cookie is the server's to clear; if the call fails the student can
      // try again. Either way this browser goes back to the login screen.
    });
    setMe(null);
    setConfig(null);
    setResult(null);
    setSetupError(null);
    setPhase("login");
  };

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

  if (checking) {
    return (
      <div className="page">
        <p className="small">Loading…</p>
      </div>
    );
  }

  return (
    <div className="page">
      {phase === "login" && <LoginScreen onLoggedIn={handleLoggedIn} />}
      {phase === "setup" && (
        <SetupScreen
          fullName={me?.fullName ?? ""}
          onStart={handleStart}
          onLogout={handleLogout}
          initialError={setupError}
        />
      )}
      {phase === "interview" && config && (
        <InterviewScreen
          persona={config.persona}
          onEnd={handleEnd}
          onAbort={handleAbort}
        />
      )}
      {phase === "results" && config && result && (
        <ResultsScreen
          result={result}
          persona={config.persona}
          onNewInterview={handleNewInterview}
        />
      )}
    </div>
  );
}
