import { useCallback, useEffect, useRef, useState } from "react";
import { PersonaSummary, SessionResult } from "../types";
import { InterviewSession, SessionStatus } from "../lib/liveSession";
import { fmtMs } from "../lib/metrics";
import { VoicePoweredOrb } from "../components/ui/voice-powered-orb";

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

function statusText(status: SessionStatus, firstName: string): string {
  switch (status) {
    case "connecting":
      return "Connecting…";
    case "live":
      return "Listening";
    case "speaking":
      return `${firstName} is speaking`;
    case "closed":
      return "Session closed";
  }
}

function MicIcon({ muted }: { muted: boolean }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="9" y="3" width="6" height="11" rx="3" stroke="currentColor" strokeWidth="1.8" />
      <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      {muted && <path d="M4 4l16 16" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />}
    </svg>
  );
}

/**
 * The live interview. The transcript is recorded but not shown here
 * (instructor decision, 2026-09-11): the student listens and speaks, and reads
 * the transcript in the report once the interview ends. The orb and the status
 * line are the feedback that the microphone and the interviewee are working:
 * the orb follows the interviewee's voice, and the student's more softly.
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

  // Read by the orb on every animation frame.
  const orbLevel = useCallback(() => {
    const session = sessionRef.current;
    if (!session) return 0;
    const { student, interviewee } = session.levels();
    return Math.max(interviewee, student * 0.55);
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
  const firstName = persona.name.split(" ")[0];
  const line = connectionLost
    ? "Connection lost"
    : muted
      ? "Microphone muted"
      : studentSpeaking
        ? "Hearing you"
        : statusText(status, firstName);
  const stageState = connectionLost ? "closed" : muted ? "muted" : studentSpeaking ? "student" : status;

  return (
    <div className="interview">
      <section className={`stage-panel is-${stageState}`}>
        <div className="stage-top rise" style={{ ["--d" as string]: 0 }}>
          <div>
            <span className="eyebrow">Interview</span>
            <h1>{persona.name}</h1>
            <p className="stage-sub">{persona.title}</p>
          </div>
          <span className={`timer ${counting ? "counting-down" : ""}`}>
            {counting ? `${fmtMs(Math.max(0, remainingMs))} left` : fmtMs(elapsedMs)}
          </span>
        </div>

        <div className="orb-wrap">
          <VoicePoweredOrb className="orb-stage" hue={ORB_HUE} getLevel={orbLevel} />
        </div>

        <p className="stage-status" key={line} aria-live="polite">
          {line}
        </p>
        <p className="stage-hint rise" style={{ ["--d" as string]: 3 }}>
          {connectionLost
            ? "The interview has ended, but your transcript is preserved."
            : counting
              ? "Real interviews are time-boxed. Plan your closing."
              : "Speak as you would in a real interview. Begin by introducing yourself and your research."}
        </p>
      </section>

      {connectionLost && (
        <div className="banner-error rise">
          {connectionLost} The interview has ended, but your transcript is
          preserved, so you can still view your results.
        </div>
      )}

      <div className="stage-controls rise" style={{ ["--d" as string]: 4 }}>
        {!connectionLost && (
          <button
            className={`pill-btn ${muted ? "is-on" : ""}`}
            onClick={toggleMute}
            aria-pressed={muted}
          >
            <MicIcon muted={muted} />
            {muted ? "Unmute" : "Mute"}
          </button>
        )}
        <button className="btn btn-end" onClick={() => endInterview()}>
          {connectionLost ? "View results" : "End interview"}
        </button>
      </div>

      <p className="small stage-note rise" style={{ ["--d" as string]: 5 }}>
        The transcript is not shown while you talk. You can read it in your
        report when the interview ends.
      </p>
    </div>
  );
}

/** Hue shift for the orb's palette, in degrees. 0 is the original violet and cyan. */
export const ORB_HUE = 0;
