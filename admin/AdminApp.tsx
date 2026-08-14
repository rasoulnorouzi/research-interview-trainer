import { useState } from "react";
import { ApiError } from "./api";
import { Settings } from "./Settings";
import { Roster } from "./Roster";
import { Personas } from "./Personas";
import { Submissions } from "./Submissions";
import { Breakglass } from "./Breakglass";

type Tab = "settings" | "roster" | "personas" | "submissions" | "breakglass";

const TABS: { id: Tab; label: string }[] = [
  { id: "settings", label: "Settings" },
  { id: "roster", label: "Roster" },
  { id: "personas", label: "Personas" },
  { id: "submissions", label: "Submissions" },
  { id: "breakglass", label: "Break-glass" },
];

export function AdminApp() {
  const [tab, setTab] = useState<Tab>("settings");
  const [accessDenied, setAccessDenied] = useState(false);

  // Every screen reports its API errors here through this one callback. A 403
  // means this instructor's email is not on the Access allow-list
  // (worker/access.ts, BACKEND-PLAN.md §7) and nothing on any tab will work,
  // so it replaces the whole dashboard with one banner rather than letting
  // five screens each show their own version of the same failure.
  const onApiError = (err: unknown) => {
    if (err instanceof ApiError && err.status === 403) setAccessDenied(true);
  };

  return (
    <div className="page admin-page">
      <h1>Research Interview Trainer - Instructor Dashboard</h1>

      {accessDenied ? (
        <div className="banner-error">
          Access denied. Your email is not on the dashboard allow-list.
        </div>
      ) : (
        <>
          <nav className="admin-nav">
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                className={tab === t.id ? "active" : ""}
                onClick={() => setTab(t.id)}
              >
                {t.label}
              </button>
            ))}
          </nav>

          {tab === "settings" && <Settings onApiError={onApiError} />}
          {tab === "roster" && <Roster onApiError={onApiError} />}
          {tab === "personas" && <Personas onApiError={onApiError} />}
          {tab === "submissions" && <Submissions onApiError={onApiError} />}
          {tab === "breakglass" && <Breakglass onApiError={onApiError} />}
        </>
      )}
    </div>
  );
}
