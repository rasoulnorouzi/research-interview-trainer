import { useEffect, useState } from "react";
import { MeResponse } from "../types";
import { api, ApiError } from "../api";
import { VoicePoweredOrb } from "../components/ui/voice-powered-orb";
import { ORB_HUE } from "./InterviewScreen";

interface Props {
  onLoggedIn: (me: MeResponse) => void;
}

/**
 * The daily email quota is reached (503 from /api/auth/request). The server
 * sends the reset time when Cloudflare gives it; it is shown in the student's
 * own clock, because a UTC time is one more thing to get wrong. Without a
 * time the message still says the wait is hours, not a minute.
 */
function emailLimitMessage(err: unknown): string | null {
  if (!(err instanceof ApiError) || err.status !== 503) return null;
  const at = typeof err.data?.retryAt === "string" ? new Date(err.data.retryAt) : null;
  if (at && !Number.isNaN(at.getTime())) {
    const sameDay = at.toDateString() === new Date().toDateString();
    const time = at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const when = sameDay ? time : `${at.toLocaleDateString([], { weekday: "long" })} ${time}`;
    return `Login emails have reached today's limit. You can request a code again after ${when} (your time). Need to log in sooner? Ask your instructor.`;
  }
  return "Login emails have reached today's limit. Try again later today, or ask your instructor.";
}

/** Mirrors the server's 1-per-60s rate limit on /api/auth/request. */
const RESEND_SECONDS = 60;

export function LoginScreen({ onLoggedIn }: Props) {
  const [step, setStep] = useState<"email" | "code">("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  // Checked by default (instructor decision, 2026-08-31): most students use
  // their own device, and the unchecked default cost them a fresh mailed code
  // every 8 hours. Unticking it still gives the short session for a shared
  // or public computer.
  const [remember, setRemember] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cooldown, setCooldown] = useState(0);

  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  const requestCode = async () => {
    const address = email.trim().toLowerCase();
    if (address.length === 0 || busy) return;
    setBusy(true);
    setError(null);
    setEmail(address);
    try {
      await api("/api/auth/request", {
        method: "POST",
        body: JSON.stringify({ email: address }),
      });
      setCooldown(RESEND_SECONDS);
      // Only a confirmed send opens the code step. Nothing was mailed on any
      // other answer, so asking for a code would be asking for something that
      // does not exist.
      setStep("code");
    } catch (err) {
      // The server's own message: not on the roster, over the rate limit, a
      // failed send, or an unreachable network. It is shown where the address
      // was typed, so a typo can be corrected in place. A resend from the code
      // step lands here too and leaves that step where it is.
      setError(emailLimitMessage(err) ?? (err as Error).message);
    }
    setBusy(false);
  };

  const verify = async () => {
    if (code.trim().length === 0 || busy) return;
    setBusy(true);
    setError(null);
    try {
      const me = await api<MeResponse>("/api/auth/verify", {
        method: "POST",
        body: JSON.stringify({ email, code: code.trim(), remember }),
      });
      onLoggedIn(me);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  const useDifferentAddress = () => {
    setStep("email");
    setCode("");
    setError(null);
  };

  return (
    <div className="login">
      <section className="stage-panel login-hero">
        <div className="orb-wrap orb-wrap-hero">
          <VoicePoweredOrb className="orb-stage" hue={ORB_HUE} />
        </div>
        <h1 className="rise" style={{ ["--d" as string]: 1 }}>Research Interview Trainer</h1>
        <p className="stage-sub rise" style={{ ["--d" as string]: 2 }}>
          Practice qualitative interviewing by speaking with a simulated
          interviewee. Get a report on your technique.
        </p>
      </section>
      <div className="card login-card rise" style={{ ["--d" as string]: 3 }}>
        <p className="lede">
          Log in with the university email address you are enrolled with.
        </p>

        {error && <div className="banner-error">{error}</div>}

        {step === "email" ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void requestCode();
            }}
          >
            <h2>Log in</h2>
            <div className="field">
              <label htmlFor="email">University email address</label>
              <input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="email"
                autoFocus
              />
            </div>
            <div className="btn-row">
              <button className="btn" type="submit" disabled={busy || email.trim().length === 0}>
                {busy ? "Sending…" : "Send me a code"}
              </button>
            </div>
          </form>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void verify();
            }}
          >
            <h2>Enter your code</h2>
            <p>
              We sent a 6-digit code to {email}. It can take a minute to arrive.
              If it is not in your inbox, check your spam or junk folder.
            </p>
            <div className="field">
              <label htmlFor="code">6-digit code</label>
              <input
                id="code"
                type="text"
                className="code-input"
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                autoFocus
              />
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={remember}
                  onChange={(e) => setRemember(e.target.checked)}
                />
                Remember this device
              </label>
            </div>
            <div className="btn-row">
              <button className="btn" type="submit" disabled={busy || code.length === 0}>
                {busy ? "Checking…" : "Log in"}
              </button>
              <button
                className="link-btn"
                type="button"
                onClick={() => void requestCode()}
                disabled={busy || cooldown > 0}
              >
                {cooldown > 0 ? `Send it again (${cooldown}s)` : "Send it again"}
              </button>
              <button className="link-btn" type="button" onClick={useDifferentAddress}>
                Use a different address
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
