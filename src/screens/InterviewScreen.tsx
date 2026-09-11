import { useEffect, useRef, useState } from "react";
import { PersonaSummary, SessionResult } from "../types";
import { InterviewSession, SessionStatus } from "../lib/liveSession";
import { fmtMs } from "../lib/metrics";

interface Props {
  persona: PersonaSummary;
  onEnd: (result: SessionResult) => void;
  onAbort: (message: string) => void;
  /** Bumped by App when the Back button asks for the interview to end. Any
   *  change to this value takes the same path the End button takes. */
  endSignal: number;
}

/** Instructor-set interview limits, from POST /api/session. Never hardcoded. */
interface Limits {
  limitMinutes: number;
  warnMinutes: number;
}

const STATUS_TEXT: Record<SessionStatus, string> = {
  connecting: "Connecting…",
  live: "Listening. Ask your question out loud",
  speaking: "Interviewee is speaking…",
  closed: "Session closed",
};

/**
 * The live interview. The transcript is recorded but not shown here
 * (instructor decision, 2026-09-11): the student listens and speaks, and reads
 * the transcript in the report once the interview ends. The status line is
 * the only feedback that the microphone and the interviewee are working.
 */
export function InterviewScreen({ persona, onEnd, onAbort, endSignal }: Props) {
  const sessionRef = useRef<InterviewSession | null>(null);
  const [status, setStatus] = useState<SessionStatus>("connecting");
  const [muted, setMuted] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [limits, setLimits] = useState<Limits | null>(null);
  const [studentSpeaking, setStudentSpeaking] = useState(false);
  const [connectionLost, setConnectionLost] = useState<string | null>(null);

  // Refs so the mount effect's callbacks always see current handlers.
  const onAbortRef = useRef(onAbort);
  onAbortRef.current = onAbort;

  useEffect(() => {
    const session = new InterviewSession({
      personaId: persona.id,
      onLimits: setLimits,
      onStatus: setStatus,
      onStudentSpeaking: setStudentSpeaking,
      onFatalError: (message) => {
        if (session.transcript.length > 0) {
          setConnectionLost(message);
        } else {
          onAbortRef.current(message);
        }
      },
    });
    sessionRef.current = session;
    session.start().catch((err: Error) => {
      onAbortRef.current(err.message);
    });
    return () => {
      session.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const started = Date.now();
    const t = setInterval(() => setElapsedMs(Date.now() - started), 1000);
    return () => clearInterval(t);
  }, []);

  const toggleMute = () => {
    const next = !muted;
    setMuted(next);
    sessionRef.current?.setMuted(next);
  };

  const endedRef = useRef(false);

  const endInterview = (reachedLimit = false) => {
    const session = sessionRef.current;
    if (!session || endedRef.current) return;
    if (session.transcript.length === 0 && !connectionLost && !reachedLimit) {
      if (!window.confirm("Nothing has been said yet. End the interview and return to setup?")) {
        return;
      }
      endedRef.current = true;
      session.stop();
      onAbort("");
      return;
    }
    endedRef.current = true;
    const result = session.stop();
    if (connectionLost) result.endedByError = connectionLost;
    onEnd(result);
  };

  // The hard stop takes exactly the path the "End interview" button takes, so
  // the transcript is preserved and the student goes to their report as if
  // they had closed the interview themselves. Only the confirm dialog is
  // skipped, since there is nobody to answer it once the time is up.
  const endRef = useRef(endInterview);
  endRef.current = endInterview;
  useEffect(() => {
    if (!limits || endedRef.current) return;
    if (elapsedMs >= limits.limitMinutes * 60_000) endRef.current(true);
  }, [elapsedMs, limits]);

  // Back button: App has already asked the student to confirm, so this takes
  // the same path as the time limit. The value at mount is the baseline, so a
  // signal left over from an earlier interview does not end this one.
  const endSignalAtMount = useRef(endSignal);
  useEffect(() => {
    if (endSignal !== endSignalAtMount.current) endRef.current(true);
  }, [endSignal]);

  const remainingMs = limits ? limits.limitMinutes * 60_000 - elapsedMs : 0;
  const counting = limits !== null && elapsedMs >= limits.warnMinutes * 60_000;

  return (
    <div>
      <div className="card">
        <div className="interview-header">
          <div>
            <h1>Interview: {persona.name}</h1>
            <p className="small">
              {persona.title}. {persona.researchTopic}
            </p>
          </div>
          <span className={`timer ${counting ? "counting-down" : ""}`}>
            {counting ? `${fmtMs(Math.max(0, remainingMs))} left` : fmtMs(elapsedMs)}
          </span>
        </div>

        {counting && !connectionLost && (
          <p className="small">Real interviews are time-boxed. Plan your closing.</p>
        )}

        {connectionLost ? (
          <div className="banner-error">
            {connectionLost} The interview has ended, but your transcript is
            preserved, so you can still view your results.
          </div>
        ) : (
          <>
            <div className="status-line">
              <span className={`rec-dot ${status === "connecting" || muted ? "idle" : ""}`} />
              <span>
                {muted
                  ? "Microphone muted"
                  : studentSpeaking
                    ? "Hearing you…"
                    : STATUS_TEXT[status]}
              </span>
            </div>
            <p>
              Speak as you would in a real interview. Begin by introducing
              yourself and your research.
            </p>
            <p className="small">
              The transcript is not shown while you talk. You can read it in
              your report when the interview ends.
            </p>
          </>
        )}

        <div className="btn-row">
          {!connectionLost && (
            <button className="btn btn-secondary" onClick={toggleMute}>
              {muted ? "Unmute microphone" : "Mute microphone"}
            </button>
          )}
          <button className="btn" onClick={() => endInterview()}>
            {connectionLost ? "View results" : "End interview"}
          </button>
        </div>
      </div>
    </div>
  );
}
