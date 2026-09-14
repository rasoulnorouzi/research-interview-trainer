import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ApiError } from "./api";
import { VoicePoweredOrb } from "../src/components/ui/voice-powered-orb";
import { Settings } from "./Settings";
import { Roster } from "./Roster";
import { Personas } from "./Personas";
import { Rubric } from "./Rubric";
import { Submissions } from "./Submissions";
import { Breakglass } from "./Breakglass";

type Tab = "settings" | "roster" | "personas" | "rubric" | "submissions" | "breakglass";

const TABS: { id: Tab; label: string }[] = [
  { id: "settings", label: "Settings" },
  { id: "roster", label: "Students" },
  { id: "personas", label: "Personas" },
  { id: "rubric", label: "Rubric" },
  { id: "submissions", label: "Submissions" },
  { id: "breakglass", label: "Break-glass" },
];

/** Hue shift for the dashboard's orb: turns the student app's violet and
 *  cyan into greens, the dashboard's colour. */
const ADMIN_ORB_HUE = 95;

/** The active tab lives in location.hash (#roster), so Back moves between the
 *  tabs the instructor has visited instead of leaving the dashboard. An
 *  unknown or empty hash falls back to the first tab. */
function tabFromHash(): Tab {
  const id = window.location.hash.replace(/^#/, "");
  return TABS.some((t) => t.id === id) ? (id as Tab) : "settings";
}

export function AdminApp() {
  const [tab, setTab] = useState<Tab>(tabFromHash);
  const [accessDenied, setAccessDenied] = useState(false);

  useEffect(() => {
    const onHashChange = () => setTab(tabFromHash());
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  // Setting the hash is what pushes the history entry; the listener above
  // then moves the tab, so a click and a Back press take the same path.
  const selectTab = (id: Tab) => {
    if (id === tabFromHash()) return;
    window.location.hash = id;
  };

  // Every screen reports its API errors here through this one callback. A 403
  // means this instructor's email is not on the Access allow-list
  // (worker/access.ts, BACKEND-PLAN.md §7) and nothing on any tab will work,
  // so it replaces the whole dashboard with one banner rather than letting
  // five screens each show their own version of the same failure.
  const onApiError = (err: unknown) => {
    if (err instanceof ApiError && err.status === 403) setAccessDenied(true);
  };

  // The segmented tab bar's highlight slides to the active tab: its offset and
  // width go to CSS as --x and --w. Re-measured when the bar resizes.
  const navRef = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const nav = navRef.current;
    if (!nav) return;
    const place = () => {
      const active = nav.querySelector<HTMLButtonElement>("button.active");
      if (!active) return;
      nav.style.setProperty("--x", `${active.offsetLeft - 4}px`);
      nav.style.setProperty("--w", `${active.offsetWidth}px`);
      // On a phone the bar scrolls sideways; keep the active tab in view.
      if (nav.scrollWidth > nav.clientWidth) {
        nav.scrollTo({ left: active.offsetLeft - 24, behavior: "smooth" });
      }
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(nav);
    return () => observer.disconnect();
  }, [tab, accessDenied]);

  return (
    <div className="admin-root">
      <div className="page admin-page">
        <header className="app-header no-print">
          <span className="app-name">Research Interview Trainer</span>
          {/* Access owns the session, so logging out is a navigation to an
              edge path rather than anything this app can do:
              /cdn-cgi/access/logout is handled by Cloudflare before the Worker
              sees it. Same origin, so a plain link is the whole
              implementation. Kept outside the access-denied branch below,
              because switching account is exactly what a denied instructor
              needs. */}
          <span className="app-user">
            <a
              className="link-btn"
              href="/cdn-cgi/access/logout"
              title="Ends your Cloudflare Access session."
            >
              Log out
            </a>
          </span>
        </header>

        <section className="stage-panel admin-hero no-print">
          <div className="orb-wrap admin-orb">
            <VoicePoweredOrb className="orb-stage" hue={ADMIN_ORB_HUE} idleSpeed={0.25} />
          </div>
          <div>
            <span className="eyebrow rise" style={{ ["--d" as string]: 0 }}>Instructor</span>
            <h1 className="rise" style={{ ["--d" as string]: 1 }}>Dashboard</h1>
            <p className="stage-sub rise" style={{ ["--d" as string]: 2 }}>
              Students, interviewees, the rubric and every report, in one place.
            </p>
          </div>
        </section>

        {accessDenied ? (
          <div className="banner-error">
            Access denied. Your email is not on the dashboard allow-list.
          </div>
        ) : (
          <>
            <nav className="admin-nav no-print" ref={navRef}>
              {TABS.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  className={tab === t.id ? "active" : ""}
                  onClick={() => selectTab(t.id)}
                >
                  {t.label}
                </button>
              ))}
            </nav>

            {/* Keyed by tab, so every tab change replays the entrance motion. */}
            <main className="screen" key={tab}>
              {tab === "settings" && <Settings onApiError={onApiError} />}
              {tab === "roster" && <Roster onApiError={onApiError} />}
              {tab === "personas" && <Personas onApiError={onApiError} />}
              {tab === "rubric" && <Rubric onApiError={onApiError} />}
              {tab === "submissions" && <Submissions onApiError={onApiError} />}
              {tab === "breakglass" && <Breakglass onApiError={onApiError} />}
            </main>
          </>
        )}
      </div>
    </div>
  );
}
