import { useEffect, useState } from "react";
import { ApiError } from "./api";
import { Settings } from "./Settings";
import { Roster } from "./Roster";
import { Personas } from "./Personas";
import { Rubric } from "./Rubric";
import { Admins } from "./Admins";
import { Submissions } from "./Submissions";
import { Breakglass } from "./Breakglass";

type Tab = "settings" | "roster" | "personas" | "rubric" | "submissions" | "breakglass"
  | "admins";

const TABS: { id: Tab; label: string }[] = [
  { id: "settings", label: "Settings" },
  { id: "roster", label: "Students" },
  { id: "personas", label: "Personas" },
  { id: "rubric", label: "Rubric" },
  { id: "submissions", label: "Submissions" },
  { id: "breakglass", label: "Break-glass" },
  { id: "admins", label: "Admins" },
];

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

  return (
    <div className="admin-root">
      <div className="page admin-page">
        <header className="app-header no-print">
          <span className="app-name">
            Research Interview Trainer - Instructor Dashboard
          </span>
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

        {accessDenied ? (
          <div className="banner-error">
            Access denied. Your email is not on the dashboard allow-list.
          </div>
        ) : (
          <>
            <nav className="admin-nav no-print">
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

            {tab === "settings" && <Settings onApiError={onApiError} />}
            {tab === "roster" && <Roster onApiError={onApiError} />}
            {tab === "personas" && <Personas onApiError={onApiError} />}
            {tab === "rubric" && <Rubric onApiError={onApiError} />}
            {tab === "submissions" && <Submissions onApiError={onApiError} />}
            {tab === "breakglass" && <Breakglass onApiError={onApiError} />}
            {tab === "admins" && <Admins onApiError={onApiError} />}
          </>
        )}
      </div>
    </div>
  );
}
