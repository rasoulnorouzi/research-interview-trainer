// The Worker entry point: one route table, one admin guard, one error wrapper.
// The API surface is the seven student endpoints of BACKEND-PLAN.md §4 plus
// the admin prefix. Treat an addition to it as a decision, not a detail (§9).

import { handleAdmin } from "./admin";
import { handleAuthLogout, handleAuthRequest, handleAuthVerify, handleMe, handleRedeem, identify } from "./auth";
import { identifyInstructor } from "./access";
import { json, type Env } from "./db";
import { handleReport, handleSession } from "./report";
import type { PersonaSummary } from "../shared/types";

type Handler = (request: Request, env: Env) => Response | Promise<Response>;

// Exact paths, no parameter capture: every parameterised route in §4 lives
// under /api/admin, which parses its own segments.
const ROUTES: [method: string, path: string, handler: Handler][] = [
  ["POST", "/api/auth/request", handleAuthRequest],
  ["POST", "/api/auth/verify", handleAuthVerify],
  ["POST", "/api/auth/logout", handleAuthLogout],
  ["GET", "/api/auth/redeem", handleRedeem],
  ["GET", "/api/me", handleMe],
  ["GET", "/api/personas", handlePersonas],
  ["POST", "/api/session", handleSession],
  ["POST", "/api/report", handleReport],
];

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // One try/catch around every handler. This is the last-resort guard against
    // an exception carrying the OpenAI key, a query, or a student's data into a
    // response body, so the catch logs and the client learns nothing (§7, §10).
    try {
      const url = new URL(request.url);
      const path = url.pathname.replace(/\/+$/, "") || "/";
      const segments = path.split("/").filter(Boolean);

      // run_worker_first only covers /api/*, so this is a safety net, not a path
      // real traffic takes.
      if (segments[0] !== "api") return await env.ASSETS.fetch(request);

      if (segments[1] === "admin") {
        // The single Access check for the whole admin surface. It lives here and
        // nowhere else, so a missing check on an individual admin endpoint is
        // structurally impossible — BACKEND-PLAN.md §10 names that the top risk.
        const instructor = await identifyInstructor(request, env);
        if (!instructor) return json(403, { error: "Access denied." });
        return await handleAdmin(request, env, instructor.email, segments.slice(2));
      }

      for (const [method, pattern, handler] of ROUTES) {
        if (pattern !== path) continue;
        if (method !== request.method) return json(405, { error: "Method not allowed." });
        return await handler(request, env);
      }
      return json(404, { error: "Not found." });
    } catch (err) {
      console.error("worker error:", err instanceof Error ? err.message : String(err));
      return json(500, { error: "Internal error." });
    }
  },
} satisfies ExportedHandler<Env>;

/**
 * GET /api/personas. The column list is explicit: system_instruction and
 * hidden_core are not selected, so no student-facing response can carry a
 * spoiler even by accident. Never widen this to SELECT * (§4).
 */
async function handlePersonas(request: Request, env: Env): Promise<Response> {
  const session = await identify(request, env);
  if (!session) return json(401, { error: "Not logged in." });
  const rows = await env.DB.prepare(
    "SELECT id, name, title, research_topic, short_bio FROM personas WHERE active = 1 ORDER BY name",
  ).all<{ id: string; name: string; title: string; research_topic: string; short_bio: string }>();
  const personas: PersonaSummary[] = rows.results.map((row) => ({
    id: row.id,
    name: row.name,
    title: row.title,
    researchTopic: row.research_topic,
    shortBio: row.short_bio,
  }));
  return json(200, personas);
}
