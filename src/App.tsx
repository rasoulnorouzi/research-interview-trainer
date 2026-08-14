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

/**
 * History state contract. Every entry this app creates carries exactly
 * `{ phase }`; nothing else is stored and the URL never changes, since there
 * is no router. An entry without a `phase` belongs to something else (or to
 * the browser's own initial entry) and the popstate handler ignores it.
 *
 * The stack mirrors the phase machine: one pushState per transition the app
 * initiates, so Back walks the interview backwards instead of leaving the app.
 */
interface HistoryPhaseState {
  phase: Phase;
}

const pushPhase = (phase: Phase) => {
  window.history.pushState({ phase } as HistoryPhaseState, "");
};

const replacePhase = (phase: Phase) => {
  window.history.replaceState({ phase } as HistoryPhaseState, "");
};

export default function App() {
  const [checking, setChecking] = useState(true);
  const [phase, setPhase] = useState<Phase>("login");
  const [me, setMe] = useState<MeResponse | null>(null);
  const [config, setConfig] = useState<StartConfig | null>(null);
  const [result, setResult] = useState<SessionResult | null>(null);
  const [setupError, setSetupError] = useState<string | null>(null);
  // Bumped to ask the live interview screen to end itself through exactly the
  // path its own "End interview" button takes. Used by the Back button.
  const [endSignal, setEndSignal] = useState(0);

  // One session check on load, so a remembered device goes straight to setup.
  useEffect(() => {
    api<MeResponse>("/api/me")
      .then((who) => {
        setMe(who);
        setPhase("setup");
        replacePhase("setup");
      })
      .catch(() => {
        setPhase("login");
        replacePhase("login");
      })
      .finally(() => setChecking(false));
  }, []);

  // Back and forward. Re-registered whenever the phase or the session changes,
  // so the handler never reads a stale one.
  useEffect(() => {
    const onPopState = (event: PopStateEvent) => {
      const target = (event.state as HistoryPhaseState | null)?.phase;
      if (!target) return; // Not one of ours: leave the navigation alone.

      // History can never bypass the login check: /api/me is the authority.
      if (!me) {
        setPhase("login");
        return;
      }

      if (phase === "interview") {
        if (
          window.confirm(
            "Leave the interview? It will end and you go to your results."
          )
        ) {
          // Same end path as the button, so the transcript survives. The end
          // handler pushes the results entry itself.
          setEndSignal((n) => n + 1);
        } else {
          // Declined: put the interview entry back so the stack stays honest.
          pushPhase("interview");
        }
        return;
      }

      if (target === "login") {
        // Setup is the entry screen for a logged-in student, so Back is not
        // trapped here: collapse this entry and let the next Back leave the
        // app the way the browser normally would.
        setPhase("setup");
        replacePhase("setup");
        return;
      }

      if (target === "results" && !(config && result)) {
        setPhase("setup");
        replacePhase("setup");
        return;
      }

      setPhase(target);
    };

    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [phase, me, config, result]);

  const handleLoggedIn = (who: MeResponse) => {
    setMe(who);
    setSetupError(null);
    setPhase("setup");
    pushPhase("setup");
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
    pushPhase("login");
  };

  const handleStart = (next: StartConfig) => {
    setSetupError(null);
    setConfig(next);
    setResult(null);
    setPhase("interview");
    pushPhase("interview");
  };

  const handleEnd = (sessionResult: SessionResult) => {
    setResult(sessionResult);
    setPhase("results");
    pushPhase("results");
  };

  const handleAbort = (message: string) => {
    setSetupError(message);
    setPhase("setup");
    pushPhase("setup");
  };

  const handleNewInterview = () => {
    setResult(null);
    setSetupError(null);
    setPhase("setup");
    pushPhase("setup");
  };

  if (checking) {
    return (
      <div className="page">
        <p className="small">Loading…</p>
      </div>
    );
  }

  const showAccount = me !== null && (phase === "setup" || phase === "results");

  return (
    <div className="page">
      <header className="app-header">
        <span className="app-name">Research Interview Trainer</span>
        {showAccount && (
          <span className="app-user">
            <span>{me?.fullName}</span>
            <button className="link-btn" type="button" onClick={handleLogout}>
              Log out
            </button>
          </span>
        )}
      </header>

      {phase === "login" && <LoginScreen onLoggedIn={handleLoggedIn} />}
      {phase === "setup" && (
        <SetupScreen onStart={handleStart} initialError={setupError} />
      )}
      {phase === "interview" && config && (
        <InterviewScreen
          persona={config.persona}
          onEnd={handleEnd}
          onAbort={handleAbort}
          endSignal={endSignal}
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
