import { useEffect, useRef, useState } from "react";
import { PersonaSummary, SessionResult, TranscriptEntry } from "../types";
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

export function InterviewScreen({ persona, onEnd, onAbort, endSignal }: Props) {
  const sessionRef = useRef<InterviewSession | null>(null);
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [status, setStatus] = useState<SessionStatus>("connecting");
  const [muted, setMuted] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [limits, setLimits] = useState<Limits | null>(null);
  const [studentSpeaking, setStudentSpeaking] = useState(false);
  const [awaitingStudentText, setAwaitingStudentText] = useState(false);
  const [connectionLost, setConnectionLost] = useState<string | null>(null);
  const transcriptBoxRef = useRef<HTMLDivElement | null>(null);

  // Refs so the mount effect's callbacks always see current handlers.
  const onAbortRef = useRef(onAbort);
  onAbortRef.current = onAbort;

  useEffect(() => {
    const session = new InterviewSession({
      personaId: persona.id,
      onLimits: setLimits,
      onTranscript: setTranscript,
      onStatus: setStatus,
      onStudentSpeaking: (speaking) => {
        setStudentSpeaking(speaking);
        // Text now streams while the student talks, but the first delta still
        // takes a moment; this covers only that gap.
        if (speaking) setAwaitingStudentText(true);
      },
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

  // The placeholder is resolved by the student's text arriving, which shows up
  // as a new student entry.
  const studentEntryCount = transcript.filter((e) => e.speaker === "student").length;
  useEffect(() => {
    setAwaitingStudentText(false);
  }, [studentEntryCount]);

  useEffect(() => {
    const box = transcriptBoxRef.current;
    if (box) box.scrollTop = box.scrollHeight;
  }, [transcript, studentSpeaking, awaitingStudentText]);

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
        )}
      </div>

      <div className="card">
        <h2>Transcript</h2>
        <div className="transcript" ref={transcriptBoxRef}>
          {transcript.length === 0 && !awaitingStudentText ? (
            <p className="placeholder">
              The transcript will appear here as you speak. Begin by introducing
              yourself and your research, as you would in a real interview.
            </p>
          ) : (
            transcript.map((e, i) => (
              <div className="entry" key={i}>
                <span className={`speaker ${e.speaker}`}>
                  {e.speaker === "student" ? "You" : persona.name}
                  <span className="t">{fmtMs(e.tStart)}</span>
                </span>
                <div>{e.text}</div>
              </div>
            ))
          )}
          {awaitingStudentText && (
            <div className="entry">
              <span className="speaker student">You</span>
              <div className="pending">listening…</div>
            </div>
          )}
        </div>

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
