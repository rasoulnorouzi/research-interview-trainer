import { useEffect, useRef, useState } from "react";
import { Persona, SessionResult, TranscriptEntry } from "../types";
import { InterviewSession, SessionStatus } from "../lib/liveSession";
import { fmtMs } from "../lib/metrics";

interface Props {
  apiKey: string;
  persona: Persona;
  onEnd: (result: SessionResult) => void;
  onAbort: (message: string) => void;
}

const STATUS_TEXT: Record<SessionStatus, string> = {
  connecting: "Connecting…",
  live: "Listening — ask your question out loud",
  speaking: "Interviewee is speaking…",
  closed: "Session closed",
};

export function InterviewScreen({ apiKey, persona, onEnd, onAbort }: Props) {
  const sessionRef = useRef<InterviewSession | null>(null);
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [status, setStatus] = useState<SessionStatus>("connecting");
  const [muted, setMuted] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [connectionLost, setConnectionLost] = useState<string | null>(null);
  const transcriptBoxRef = useRef<HTMLDivElement | null>(null);

  // Refs so the mount effect's callbacks always see current handlers.
  const onAbortRef = useRef(onAbort);
  onAbortRef.current = onAbort;

  useEffect(() => {
    const session = new InterviewSession({
      apiKey,
      persona,
      onTranscript: setTranscript,
      onStatus: setStatus,
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

  useEffect(() => {
    const box = transcriptBoxRef.current;
    if (box) box.scrollTop = box.scrollHeight;
  }, [transcript]);

  const toggleMute = () => {
    const next = !muted;
    setMuted(next);
    sessionRef.current?.setMuted(next);
  };

  const endInterview = () => {
    const session = sessionRef.current;
    if (!session) return;
    if (session.transcript.length === 0 && !connectionLost) {
      if (!window.confirm("Nothing has been said yet. End the interview and return to setup?")) {
        return;
      }
      session.stop();
      onAbort("");
      return;
    }
    const result = session.stop();
    if (connectionLost) result.endedByError = connectionLost;
    onEnd(result);
  };

  return (
    <div>
      <div className="interview-header">
        <h1>Interview: {persona.name}</h1>
        <span className="timer">{fmtMs(elapsedMs)}</span>
      </div>
      <p className="small">
        {persona.title} — {persona.researchTopic}
      </p>

      {connectionLost ? (
        <div className="banner-error">
          {connectionLost} The interview has ended, but your transcript is
          preserved — you can still view your results.
        </div>
      ) : (
        <div className="status-line">
          <span className={`rec-dot ${status === "connecting" || muted ? "idle" : ""}`} />
          <span>{muted ? "Microphone muted" : STATUS_TEXT[status]}</span>
        </div>
      )}

      <div className="transcript" ref={transcriptBoxRef}>
        {transcript.length === 0 ? (
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
      </div>

      <div className="btn-row">
        {!connectionLost && (
          <button className="btn btn-secondary" onClick={toggleMute}>
            {muted ? "Unmute microphone" : "Mute microphone"}
          </button>
        )}
        <button className="btn btn-danger" onClick={endInterview}>
          {connectionLost ? "View results" : "End interview"}
        </button>
      </div>
    </div>
  );
}
