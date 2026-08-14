// The instructor dashboard API (BACKEND-PLAN.md §4 "Admin API", §7).
//
// Two rules from §7 are enforced here and cannot be relaxed:
//   - The OpenAI key is WRITE-ONLY. It appears in exactly two places in this
//     file: the masked render (last four characters) and the store after
//     validateApiKey. There is no reveal path, and it is never put in an error
//     or a log line.
//   - Every persona save writes a persona_versions snapshot in the SAME batch
//     as the row itself, so a save without a version is structurally
//     impossible. Snapshots are never deleted and there is no DELETE route.
//
// A student is never hard-deleted either: submissions.student_id references
// the roster, so DELETE means active = 0 (§3, §7).

import { sha256Hex } from "./auth";
import { getSettings, json, readJsonBody, type Env } from "./db";
import { validateApiKey } from "./openai";

const ROSTER_LIST_LIMIT = 500;
const SUBMISSION_LIST_DEFAULT = 100;
const SUBMISSION_LIST_MAX = 500;
// An export capped at the list default would not be an export, so the CSV
// keeps the same filters but its own, larger ceiling. A year of 400 students
// is a few thousand rows.
const SUBMISSION_CSV_DEFAULT = 1000;
const SUBMISSION_CSV_MAX = 5000;
const BREAKGLASS_TTL_SECONDS = 15 * 60;
// D1 accepts large batches, but chunking keeps a 400-row import well inside
// any statement limit and bounds the memory each batch holds.
const IMPORT_BATCH_SIZE = 100;

/** The only settings keys the dashboard may write (§3 settings table). */
const SETTING_KEYS = [
  "openai_api_key",
  "interview_limit_minutes",
  "interview_warn_minutes",
  "sessions_per_day",
  "interview_model",
  "scoring_model",
  "instructor_recipients",
] as const;

const NUMERIC_SETTING_KEYS = ["interview_limit_minutes", "interview_warn_minutes", "sessions_per_day"];

const PERSONA_ID_PATTERN = /^[a-z0-9-]{1,40}$/;

interface PersonaFields {
  name: string;
  title: string;
  researchTopic: string;
  shortBio: string;
  voiceName: string;
  systemInstruction: string;
  hiddenCore: string | null;
  active: number;
}

/**
 * Every /api/admin/* request lands here, and only after index.ts has verified
 * the Cloudflare Access JWT — never re-check it per endpoint and never skip it.
 *
 * `path` is the segments after /api/admin: ["roster", "s1234"] for
 * /api/admin/roster/s1234, [] for /api/admin.
 */
export async function handleAdmin(
  request: Request,
  env: Env,
  instructorEmail: string,
  path: string[],
): Promise<Response> {
  const method = request.method;
  const url = new URL(request.url);

  switch (path[0]) {
    case "settings":
      if (path.length !== 1) break;
      if (method === "GET") return await getSettingsView(env);
      if (method === "PUT") return await putSettings(request, env, instructorEmail);
      return methodNotAllowed();

    case "roster":
      if (path.length === 1) {
        if (method === "GET") return await listRoster(env, url);
        if (method === "POST") return await createRosterEntry(request, env);
        return methodNotAllowed();
      }
      if (path.length === 2 && path[1] === "import" && method === "POST") {
        return await importRoster(request, env);
      }
      if (path.length === 2) {
        if (method === "PATCH") return await patchRosterEntry(request, env, path[1]);
        if (method === "DELETE") return await deactivateRosterEntry(env, path[1]);
        return methodNotAllowed();
      }
      break;

    case "personas":
      if (path.length === 1) {
        if (method === "GET") return await listPersonas(env);
        if (method === "POST") return await createPersona(request, env, instructorEmail);
        return methodNotAllowed();
      }
      if (path.length === 2) {
        if (method === "GET") return await getPersona(env, path[1]);
        if (method === "PUT") return await putPersona(request, env, instructorEmail, path[1]);
        return methodNotAllowed();
      }
      if (path.length === 3 && path[2] === "versions") {
        if (method === "GET") return await listPersonaVersions(env, path[1]);
        return methodNotAllowed();
      }
      break;

    case "submissions":
      if (path.length === 1) {
        if (method !== "GET") return methodNotAllowed();
        return await listSubmissions(env, url);
      }
      if (path.length === 2) {
        if (method !== "GET") return methodNotAllowed();
        return await getSubmission(env, path[1]);
      }
      break;

    case "submissions.csv":
      if (path.length !== 1) break;
      if (method !== "GET") return methodNotAllowed();
      return await submissionsCsv(env, url);

    case "breakglass":
      if (path.length !== 1) break;
      if (method !== "POST") return methodNotAllowed();
      return await breakglass(request, env);
  }

  return json(404, { error: "Not found." });
}

// ---------------------------------------------------------------- settings

interface SettingRow {
  key: string;
  value: string;
  updated_at: number;
  updated_by: string | null;
}

/**
 * The masked view, and the only rendering of the OpenAI key anywhere in the
 * Worker (§7, "write-only"). An unset or blank key is simply absent, which is
 * what tells the dashboard to show "not set" rather than a mask over nothing.
 */
async function settingsView(env: Env): Promise<Record<string, { value: string; updatedAt: number; updatedBy: string | null }>> {
  const rows = await env.DB.prepare(
    "SELECT key, value, updated_at, updated_by FROM settings ORDER BY key",
  ).all<SettingRow>();
  const view: Record<string, { value: string; updatedAt: number; updatedBy: string | null }> = {};
  for (const row of rows.results) {
    let value = row.value;
    if (row.key === "openai_api_key") {
      if (value.length === 0) continue;
      value = `sk-...${value.slice(-4)}`;
    }
    view[row.key] = { value, updatedAt: row.updated_at, updatedBy: row.updated_by };
  }
  return view;
}

async function getSettingsView(env: Env): Promise<Response> {
  return json(200, { settings: await settingsView(env) });
}

/**
 * PUT /api/admin/settings, body a partial {key: value} map.
 *
 * Everything is validated before anything is written, and the whole set goes
 * in one batch, so a rejected API key really does mean nothing was saved.
 */
async function putSettings(request: Request, env: Env, instructorEmail: string): Promise<Response> {
  const parsed = await readJsonBody<Record<string, unknown>>(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value;
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return json(400, { error: "Expected an object of settings to update." });
  }

  const entries = Object.entries(body);
  if (entries.length === 0) return json(400, { error: "No settings to update." });

  const updates: [key: string, value: string][] = [];
  for (const [key, raw] of entries) {
    if (!(SETTING_KEYS as readonly string[]).includes(key)) {
      return json(400, { error: `Unknown setting: ${key}.` });
    }

    if (NUMERIC_SETTING_KEYS.includes(key)) {
      const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw.trim()) : NaN;
      if (!Number.isInteger(n) || n <= 0) {
        return json(400, { error: `${key} must be a whole number greater than zero.` });
      }
      updates.push([key, String(n)]);
      continue;
    }

    if (typeof raw !== "string") return json(400, { error: `${key} must be text.` });
    const value = raw.trim();

    if (key === "instructor_recipients") {
      const parts = value.split(",").map((part) => part.trim()).filter((part) => part.length > 0);
      // Reports have to reach the instructors (§0), so an empty list is a
      // configuration error rather than a valid state.
      if (parts.length === 0) return json(400, { error: "instructor_recipients needs at least one address." });
      if (parts.some((part) => !part.includes("@"))) {
        return json(400, { error: "Each instructor recipient must be an email address." });
      }
      updates.push([key, parts.join(",")]);
      continue;
    }

    if (value.length === 0) return json(400, { error: `${key} cannot be empty.` });
    updates.push([key, value]);
  }

  // warn < limit, checked against whichever of the two is not in this request.
  const numericUpdate = new Map(updates.filter(([key]) => NUMERIC_SETTING_KEYS.includes(key)));
  if (numericUpdate.has("interview_limit_minutes") || numericUpdate.has("interview_warn_minutes")) {
    const stored = await getSettings(env, ["interview_limit_minutes", "interview_warn_minutes"]);
    const limit = Number(numericUpdate.get("interview_limit_minutes") ?? stored.interview_limit_minutes);
    const warn = Number(numericUpdate.get("interview_warn_minutes") ?? stored.interview_warn_minutes);
    if (Number.isFinite(limit) && Number.isFinite(warn) && warn >= limit) {
      return json(400, { error: "interview_warn_minutes must be less than interview_limit_minutes." });
    }
  }

  // §7: validate with a cheap authenticated call and refuse to store a key
  // that does not work. Saving a broken key silently is how you discover the
  // problem during a class. The key itself never enters the response below.
  const apiKey = updates.find(([key]) => key === "openai_api_key")?.[1];
  if (apiKey !== undefined) {
    let works = false;
    try {
      works = await validateApiKey(apiKey);
    } catch {
      works = false;
    }
    if (!works) return json(400, { error: "That API key does not work. Nothing was saved." });
  }

  const now = nowSeconds();
  await env.DB.batch(
    updates.map(([key, value]) =>
      env.DB.prepare(
        "INSERT INTO settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?) " +
          "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by",
      ).bind(key, value, now, instructorEmail),
    ),
  );

  return json(200, { settings: await settingsView(env) });
}

// ------------------------------------------------------------------ roster

interface RosterRow {
  student_id: string;
  email: string;
  full_name: string;
  cohort: string | null;
  active: number;
  created_at: number;
}

function rosterView(row: RosterRow) {
  return {
    studentId: row.student_id,
    email: row.email,
    fullName: row.full_name,
    cohort: row.cohort,
    active: row.active === 1,
    createdAt: row.created_at,
  };
}

async function listRoster(env: Env, url: URL): Promise<Response> {
  const conditions: string[] = [];
  const binds: unknown[] = [];

  const q = (url.searchParams.get("q") ?? "").trim();
  if (q.length > 0) {
    const pattern = `%${escapeLike(q)}%`;
    conditions.push(
      "(student_id LIKE ? ESCAPE '\\' OR email LIKE ? ESCAPE '\\' OR full_name LIKE ? ESCAPE '\\')",
    );
    binds.push(pattern, pattern, pattern);
  }
  const cohort = (url.searchParams.get("cohort") ?? "").trim();
  if (cohort.length > 0) {
    conditions.push("cohort = ?");
    binds.push(cohort);
  }

  const where = conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : "";
  const rows = await env.DB.prepare(
    `SELECT student_id, email, full_name, cohort, active, created_at FROM roster${where} ORDER BY full_name LIMIT ${ROSTER_LIST_LIMIT}`,
  )
    .bind(...binds)
    .all<RosterRow>();

  return json(200, { students: rows.results.map(rosterView), limit: ROSTER_LIST_LIMIT });
}

async function createRosterEntry(request: Request, env: Env): Promise<Response> {
  const parsed = await readJsonBody<Record<string, unknown>>(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value ?? {};

  const studentId = readText(body.studentId);
  const fullName = readText(body.fullName);
  // Lowercased on every write path. A single capital letter in an import is
  // otherwise an unfindable "the code never arrives" report (§7).
  const email = readText(body.email).toLowerCase();
  const cohort = readText(body.cohort);

  if (studentId.length === 0) return json(400, { error: "studentId is required." });
  if (fullName.length === 0) return json(400, { error: "fullName is required." });
  if (!email.includes("@")) return json(400, { error: "email must be an email address." });

  const clash = await env.DB.prepare("SELECT student_id, email FROM roster WHERE student_id = ? OR email = ?")
    .bind(studentId, email)
    .first<{ student_id: string; email: string }>();
  if (clash) {
    return json(409, {
      error:
        clash.student_id === studentId
          ? `Student ${studentId} is already on the roster.`
          : `${email} already belongs to student ${clash.student_id}.`,
    });
  }

  try {
    await env.DB.prepare(
      "INSERT INTO roster (student_id, email, full_name, cohort, active, created_at) VALUES (?, ?, ?, ?, 1, ?)",
    )
      .bind(studentId, email, fullName, cohort.length > 0 ? cohort : null, nowSeconds())
      .run();
  } catch (err) {
    // Loses the race against a concurrent add; the message stays the same.
    if (isUniqueViolation(err)) return json(409, { error: "That student ID or email is already on the roster." });
    throw err;
  }

  const row = await env.DB.prepare(
    "SELECT student_id, email, full_name, cohort, active, created_at FROM roster WHERE student_id = ?",
  )
    .bind(studentId)
    .first<RosterRow>();
  return json(201, row ? rosterView(row) : { studentId });
}

async function patchRosterEntry(request: Request, env: Env, studentId: string): Promise<Response> {
  const parsed = await readJsonBody<Record<string, unknown>>(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value ?? {};

  const existing = await env.DB.prepare("SELECT student_id FROM roster WHERE student_id = ?")
    .bind(studentId)
    .first<{ student_id: string }>();
  if (!existing) return json(404, { error: `No student with ID ${studentId}.` });

  const sets: string[] = [];
  const binds: unknown[] = [];

  if (body.email !== undefined) {
    const email = readText(body.email).toLowerCase();
    if (!email.includes("@")) return json(400, { error: "email must be an email address." });
    const clash = await env.DB.prepare("SELECT student_id FROM roster WHERE email = ? AND student_id != ?")
      .bind(email, studentId)
      .first<{ student_id: string }>();
    if (clash) return json(409, { error: `${email} already belongs to student ${clash.student_id}.` });
    sets.push("email = ?");
    binds.push(email);
  }
  if (body.fullName !== undefined) {
    const fullName = readText(body.fullName);
    if (fullName.length === 0) return json(400, { error: "fullName cannot be empty." });
    sets.push("full_name = ?");
    binds.push(fullName);
  }
  if (body.cohort !== undefined) {
    const cohort = readText(body.cohort);
    sets.push("cohort = ?");
    binds.push(cohort.length > 0 ? cohort : null);
  }
  if (body.active !== undefined) {
    if (typeof body.active !== "boolean") return json(400, { error: "active must be true or false." });
    sets.push("active = ?");
    binds.push(body.active ? 1 : 0);
  }
  if (sets.length === 0) return json(400, { error: "Nothing to update." });

  binds.push(studentId);
  try {
    await env.DB.prepare(`UPDATE roster SET ${sets.join(", ")} WHERE student_id = ?`)
      .bind(...binds)
      .run();
  } catch (err) {
    if (isUniqueViolation(err)) return json(409, { error: "That email already belongs to another student." });
    throw err;
  }

  const row = await env.DB.prepare(
    "SELECT student_id, email, full_name, cohort, active, created_at FROM roster WHERE student_id = ?",
  )
    .bind(studentId)
    .first<RosterRow>();
  return json(200, row ? rosterView(row) : { studentId });
}

/**
 * DELETE /api/admin/roster/:id deactivates. Never a SQL DELETE: submissions
 * reference the roster, so a real delete either fails or orphans reports
 * (§3, §7 "Deactivate, never delete").
 */
async function deactivateRosterEntry(env: Env, studentId: string): Promise<Response> {
  const result = await env.DB.prepare("UPDATE roster SET active = 0 WHERE student_id = ?").bind(studentId).run();
  if ((result.meta.changes ?? 0) === 0) return json(404, { error: `No student with ID ${studentId}.` });
  return json(200, {
    studentId,
    active: false,
    message: "Student deactivated. Their login is blocked and their reports are kept.",
  });
}

// ----------------------------------------------------------- roster import

interface ImportRow {
  studentId: string;
  email: string;
  fullName: string;
  cohort: string | null;
}

interface ImportProblem {
  line: number;
  reason: string;
}

/**
 * POST /api/admin/roster/import, body {csv, mode}.
 *
 * "preview" diffs against the current roster and applies nothing, because a
 * silent 400-row upsert is unreviewable and enrolment files always arrive
 * with a surprise (§7). "apply" upserts and never deletes or deactivates a
 * student who is absent from the file, so a mid-semester re-run is safe (§3).
 *
 * A quoted-field parser is deliberately not here: a line whose field count is
 * wrong is reported as invalid rather than guessed at.
 */
async function importRoster(request: Request, env: Env): Promise<Response> {
  const parsed = await readJsonBody<{ csv?: unknown; mode?: unknown }>(request);
  if (!parsed.ok) return parsed.response;
  const csv = typeof parsed.value.csv === "string" ? parsed.value.csv : "";
  const mode = parsed.value.mode;
  if (mode !== "preview" && mode !== "apply") {
    return json(400, { error: 'mode must be "preview" or "apply".' });
  }
  if (csv.trim().length === 0) return json(400, { error: "The CSV is empty." });

  const lines = csv.split(/\r?\n/);
  let headerIndex = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim().length > 0) {
      headerIndex = i;
      break;
    }
  }
  if (headerIndex < 0) return json(400, { error: "The CSV is empty." });

  const header = lines[headerIndex].split(",").map((field) => field.trim().toLowerCase());
  const expected = ["student_id", "email", "full_name", "cohort"];
  const withoutCohort = header.length === 3 && expected.slice(0, 3).every((name, i) => header[i] === name);
  const withCohort = header.length === 4 && expected.every((name, i) => header[i] === name);
  if (!withoutCohort && !withCohort) {
    return json(400, { error: "The first row must be a header: student_id,email,full_name,cohort" });
  }
  const fieldCount = header.length;

  const rows: ImportRow[] = [];
  const invalid: ImportProblem[] = [];
  const seenIds = new Set<string>();
  const seenEmails = new Set<string>();

  for (let i = headerIndex + 1; i < lines.length; i++) {
    const raw = lines[i];
    if (raw.trim().length === 0) continue;
    const lineNumber = i + 1;
    const fields = raw.split(",").map((field) => field.trim());
    if (fields.length !== fieldCount) {
      invalid.push({ line: lineNumber, reason: `expected ${fieldCount} fields, found ${fields.length}` });
      continue;
    }
    const studentId = fields[0];
    const email = fields[1].toLowerCase();
    const fullName = fields[2];
    const cohort = fieldCount === 4 && fields[3].length > 0 ? fields[3] : null;

    if (studentId.length === 0) {
      invalid.push({ line: lineNumber, reason: "student_id is empty" });
      continue;
    }
    if (!email.includes("@")) {
      invalid.push({ line: lineNumber, reason: "email is not an email address" });
      continue;
    }
    if (fullName.length === 0) {
      invalid.push({ line: lineNumber, reason: "full_name is empty" });
      continue;
    }
    if (seenIds.has(studentId)) {
      invalid.push({ line: lineNumber, reason: `student_id ${studentId} appears twice in this file` });
      continue;
    }
    if (seenEmails.has(email)) {
      invalid.push({ line: lineNumber, reason: `${email} appears twice in this file` });
      continue;
    }
    seenIds.add(studentId);
    seenEmails.add(email);
    rows.push({ studentId, email, fullName, cohort });
  }

  const current = await env.DB.prepare(
    "SELECT student_id, email, full_name, cohort, active, created_at FROM roster",
  ).all<RosterRow>();
  const byId = new Map<string, RosterRow>();
  const idByEmail = new Map<string, string>();
  for (const row of current.results) {
    byId.set(row.student_id, row);
    idByEmail.set(row.email, row.student_id);
  }

  const applicable: ImportRow[] = [];
  let created = 0;
  let changed = 0;
  let unchanged = 0;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    // The roster's UNIQUE(email) would fail the whole batch on apply, so an
    // email that belongs to a different student is reported, not attempted.
    const owner = idByEmail.get(row.email);
    if (owner !== undefined && owner !== row.studentId) {
      invalid.push({ line: 0, reason: `${row.email} already belongs to student ${owner}` });
      continue;
    }
    const existing = byId.get(row.studentId);
    if (!existing) created++;
    else if (
      existing.email !== row.email ||
      existing.full_name !== row.fullName ||
      (existing.cohort ?? null) !== row.cohort
    ) {
      changed++;
    } else {
      unchanged++;
      // Still upserted on apply: a no-op write is cheaper than a second diff.
    }
    applicable.push(row);
  }

  if (mode === "apply") {
    const now = nowSeconds();
    for (let i = 0; i < applicable.length; i += IMPORT_BATCH_SIZE) {
      const chunk = applicable.slice(i, i + IMPORT_BATCH_SIZE);
      await env.DB.batch(
        chunk.map((row) =>
          env.DB.prepare(
            "INSERT INTO roster (student_id, email, full_name, cohort, active, created_at) VALUES (?, ?, ?, ?, 1, ?) " +
              // active and created_at are deliberately absent from the update:
              // a re-import must not silently reactivate a withdrawn student
              // or rewrite when they were first enrolled.
              "ON CONFLICT(student_id) DO UPDATE SET email = excluded.email, full_name = excluded.full_name, cohort = excluded.cohort",
          ).bind(row.studentId, row.email, row.fullName, row.cohort, now),
        ),
      );
    }
  }

  return json(200, { mode, new: created, changed, unchanged, invalid });
}

// ---------------------------------------------------------------- personas

interface PersonaRow {
  id: string;
  name: string;
  title: string;
  research_topic: string;
  short_bio: string;
  voice_name: string;
  system_instruction: string;
  hidden_core: string | null;
  active: number;
  updated_at: number;
  updated_by: string | null;
}

async function listPersonas(env: Env): Promise<Response> {
  const rows = await env.DB.prepare(
    "SELECT id, name, title, active, updated_at, updated_by FROM personas ORDER BY name",
  ).all<{ id: string; name: string; title: string; active: number; updated_at: number; updated_by: string | null }>();
  return json(200, {
    personas: rows.results.map((row) => ({
      id: row.id,
      name: row.name,
      title: row.title,
      active: row.active === 1,
      updatedAt: row.updated_at,
      updatedBy: row.updated_by,
    })),
  });
}

/**
 * The admin surface is the one legitimate place the spoilers are visible: it
 * is behind Access, and system_instruction plus hidden_core are exactly what
 * the editor exists to edit (§7). GET /api/personas, the student route in
 * index.ts, must stay narrow.
 */
async function getPersona(env: Env, id: string): Promise<Response> {
  const row = await env.DB.prepare(
    "SELECT id, name, title, research_topic, short_bio, voice_name, system_instruction, hidden_core, active, updated_at, updated_by FROM personas WHERE id = ?",
  )
    .bind(id)
    .first<PersonaRow>();
  if (!row) return json(404, { error: `No persona with ID ${id}.` });
  return json(200, {
    id: row.id,
    name: row.name,
    title: row.title,
    researchTopic: row.research_topic,
    shortBio: row.short_bio,
    voiceName: row.voice_name,
    systemInstruction: row.system_instruction,
    hiddenCore: row.hidden_core,
    active: row.active === 1,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
  });
}

async function createPersona(request: Request, env: Env, instructorEmail: string): Promise<Response> {
  const parsed = await readJsonBody<Record<string, unknown>>(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value ?? {};

  const id = readText(body.id).toLowerCase();
  if (!PERSONA_ID_PATTERN.test(id)) {
    return json(400, { error: "id must be 1 to 40 characters of lowercase letters, digits and hyphens." });
  }
  const fields = readPersonaFields(body, null);
  if ("error" in fields) return json(400, { error: fields.error });

  const clash = await env.DB.prepare("SELECT id FROM personas WHERE id = ?").bind(id).first<{ id: string }>();
  if (clash) return json(409, { error: `A persona with ID ${id} already exists.` });

  const now = nowSeconds();
  try {
    // The row and its first snapshot in ONE batch. §7: persona_versions is not
    // optional, so a persona that exists without a version must be impossible.
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO personas (id, name, title, research_topic, short_bio, voice_name, system_instruction, hidden_core, active, updated_at, updated_by) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).bind(
        id,
        fields.name,
        fields.title,
        fields.researchTopic,
        fields.shortBio,
        fields.voiceName,
        fields.systemInstruction,
        fields.hiddenCore,
        fields.active,
        now,
        instructorEmail,
      ),
      env.DB.prepare(
        "INSERT INTO persona_versions (persona_id, snapshot, saved_at, saved_by) VALUES (?, ?, ?, ?)",
      ).bind(id, snapshotJson(id, fields), now, instructorEmail),
    ]);
  } catch (err) {
    if (isUniqueViolation(err)) return json(409, { error: `A persona with ID ${id} already exists.` });
    throw err;
  }

  return await getPersona(env, id);
}

/**
 * PUT /api/admin/personas/:id — the full field set, plus a snapshot, in one
 * batch. Restoring an old version is just a PUT of that snapshot's fields, so
 * there is no restore endpoint and no way to save without recording history.
 */
async function putPersona(request: Request, env: Env, instructorEmail: string, id: string): Promise<Response> {
  const parsed = await readJsonBody<Record<string, unknown>>(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value ?? {};

  const existing = await env.DB.prepare("SELECT active FROM personas WHERE id = ?")
    .bind(id)
    .first<{ active: number }>();
  if (!existing) return json(404, { error: `No persona with ID ${id}.` });

  const fields = readPersonaFields(body, existing.active);
  if ("error" in fields) return json(400, { error: fields.error });

  const now = nowSeconds();
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE personas SET name = ?, title = ?, research_topic = ?, short_bio = ?, voice_name = ?, " +
        "system_instruction = ?, hidden_core = ?, active = ?, updated_at = ?, updated_by = ? WHERE id = ?",
    ).bind(
      fields.name,
      fields.title,
      fields.researchTopic,
      fields.shortBio,
      fields.voiceName,
      fields.systemInstruction,
      fields.hiddenCore,
      fields.active,
      now,
      instructorEmail,
      id,
    ),
    env.DB.prepare(
      "INSERT INTO persona_versions (persona_id, snapshot, saved_at, saved_by) VALUES (?, ?, ?, ?)",
    ).bind(id, snapshotJson(id, fields), now, instructorEmail),
  ]);

  return await getPersona(env, id);
}

/**
 * The history, newest first. Each row carries its snapshot in the same shape
 * PUT accepts, because restoring a version is a PUT of these fields. Seed
 * snapshots are written by genseed.ts in the column names of the table, so the
 * snapshot is normalised here rather than trusted to be one shape.
 */
async function listPersonaVersions(env: Env, id: string): Promise<Response> {
  const persona = await env.DB.prepare("SELECT id FROM personas WHERE id = ?").bind(id).first<{ id: string }>();
  if (!persona) return json(404, { error: `No persona with ID ${id}.` });

  const rows = await env.DB.prepare(
    "SELECT id, snapshot, saved_at, saved_by FROM persona_versions WHERE persona_id = ? ORDER BY saved_at DESC, id DESC",
  )
    .bind(id)
    .all<{ id: number; snapshot: string; saved_at: number; saved_by: string | null }>();

  const versions = rows.results.map((row) => ({
    id: row.id,
    savedAt: row.saved_at,
    savedBy: row.saved_by,
    snapshot: parseSnapshot(row.snapshot),
  }));
  return json(200, { personaId: id, versions });
}

function readPersonaFields(
  body: Record<string, unknown>,
  currentActive: number | null,
): PersonaFields | { error: string } {
  const name = readText(body.name);
  const title = readText(body.title);
  const researchTopic = readText(body.researchTopic);
  const shortBio = readText(body.shortBio);
  const voiceName = readText(body.voiceName);
  const systemInstruction = typeof body.systemInstruction === "string" ? body.systemInstruction.trim() : "";
  const hiddenCoreRaw = body.hiddenCore;
  const hiddenCore =
    typeof hiddenCoreRaw === "string" && hiddenCoreRaw.trim().length > 0 ? hiddenCoreRaw.trim() : null;

  for (const [label, value] of [
    ["name", name],
    ["title", title],
    ["researchTopic", researchTopic],
    ["shortBio", shortBio],
    ["voiceName", voiceName],
    ["systemInstruction", systemInstruction],
  ] as const) {
    if (value.length === 0) return { error: `${label} is required.` };
  }

  let active = currentActive ?? 1;
  if (body.active !== undefined) {
    if (typeof body.active !== "boolean") return { error: "active must be true or false." };
    active = body.active ? 1 : 0;
  }

  return { name, title, researchTopic, shortBio, voiceName, systemInstruction, hiddenCore, active };
}

/** The full row as saved, in the table's column names (matches genseed.ts). */
function snapshotJson(id: string, fields: PersonaFields): string {
  return JSON.stringify({
    id,
    name: fields.name,
    title: fields.title,
    research_topic: fields.researchTopic,
    short_bio: fields.shortBio,
    voice_name: fields.voiceName,
    system_instruction: fields.systemInstruction,
    hidden_core: fields.hiddenCore,
    active: fields.active,
  });
}

function parseSnapshot(raw: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const row = parsed as Record<string, unknown>;
  return {
    name: row.name ?? "",
    title: row.title ?? "",
    researchTopic: row.research_topic ?? "",
    shortBio: row.short_bio ?? "",
    voiceName: row.voice_name ?? "",
    systemInstruction: row.system_instruction ?? "",
    hiddenCore: row.hidden_core ?? null,
    active: row.active !== 0,
  };
}

// ------------------------------------------------------------- submissions

interface SubmissionListRow {
  id: string;
  student_id: string;
  full_name: string;
  cohort: string | null;
  persona_id: string;
  started_at: number;
  duration_ms: number;
  overall_score: number | null;
  emailed_at: number | null;
}

interface SubmissionFilters {
  where: string;
  binds: unknown[];
  order: string;
  limit: number;
}

/** ?cohort=, ?from=, ?to= (unix seconds on started_at), ?sort=duration, ?limit=. */
function submissionFilters(url: URL, defaultLimit: number, maxLimit: number): SubmissionFilters {
  const conditions: string[] = [];
  const binds: unknown[] = [];

  const cohort = (url.searchParams.get("cohort") ?? "").trim();
  if (cohort.length > 0) {
    conditions.push("r.cohort = ?");
    binds.push(cohort);
  }
  const from = Number(url.searchParams.get("from") ?? "");
  if (Number.isFinite(from) && url.searchParams.get("from")) {
    conditions.push("s.started_at >= ?");
    binds.push(from);
  }
  const to = Number(url.searchParams.get("to") ?? "");
  if (Number.isFinite(to) && url.searchParams.get("to")) {
    conditions.push("s.started_at <= ?");
    binds.push(to);
  }

  const requested = Number(url.searchParams.get("limit") ?? "");
  const limit = Number.isInteger(requested) && requested > 0 ? Math.min(requested, maxLimit) : defaultLimit;

  // Sorting by duration descending is the instructor's overrun check (§7).
  const order = url.searchParams.get("sort") === "duration" ? "s.duration_ms DESC" : "s.started_at DESC";

  return { where: conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : "", binds, order, limit };
}

async function listSubmissions(env: Env, url: URL): Promise<Response> {
  const filters = submissionFilters(url, SUBMISSION_LIST_DEFAULT, SUBMISSION_LIST_MAX);
  // The four big JSON columns are not selected: a list of 500 reports would
  // otherwise carry 500 full transcripts.
  const rows = await env.DB.prepare(
    "SELECT s.id, s.student_id, r.full_name, r.cohort, s.persona_id, s.started_at, s.duration_ms, s.overall_score, s.emailed_at " +
      `FROM submissions s JOIN roster r ON r.student_id = s.student_id${filters.where} ` +
      `ORDER BY ${filters.order} LIMIT ${filters.limit}`,
  )
    .bind(...filters.binds)
    .all<SubmissionListRow>();

  return json(200, {
    submissions: rows.results.map((row) => ({
      id: row.id,
      studentId: row.student_id,
      fullName: row.full_name,
      cohort: row.cohort,
      personaId: row.persona_id,
      startedAt: row.started_at,
      durationMs: row.duration_ms,
      overallScore: row.overall_score,
      emailedAt: row.emailed_at,
    })),
    limit: filters.limit,
  });
}

async function getSubmission(env: Env, id: string): Promise<Response> {
  const row = await env.DB.prepare(
    "SELECT s.id, s.student_id, r.full_name, r.cohort, s.persona_id, s.started_at, s.ended_at, s.duration_ms, " +
      "s.overall_score, s.scores_json, s.feedback_json, s.metrics_json, s.transcript_json, s.emailed_at, s.created_at " +
      "FROM submissions s JOIN roster r ON r.student_id = s.student_id WHERE s.id = ?",
  )
    .bind(id)
    .first<
      SubmissionListRow & {
        ended_at: number;
        scores_json: string;
        feedback_json: string;
        metrics_json: string;
        transcript_json: string;
        created_at: number;
      }
    >();
  if (!row) return json(404, { error: "No submission with that ID." });

  return json(200, {
    id: row.id,
    studentId: row.student_id,
    fullName: row.full_name,
    cohort: row.cohort,
    personaId: row.persona_id,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    durationMs: row.duration_ms,
    overallScore: row.overall_score,
    scores: parseJson(row.scores_json),
    feedback: parseJson(row.feedback_json),
    metrics: parseJson(row.metrics_json),
    transcript: parseJson(row.transcript_json),
    emailedAt: row.emailed_at,
    createdAt: row.created_at,
  });
}

/**
 * GET /api/admin/submissions.csv — one row per submission, one extra column
 * per rubric criterion, in the order the scores were stored. A criterion that
 * was not assessable is an empty cell, not a zero: they are different things
 * (CLAUDE.md, scoring).
 */
async function submissionsCsv(env: Env, url: URL): Promise<Response> {
  const filters = submissionFilters(url, SUBMISSION_CSV_DEFAULT, SUBMISSION_CSV_MAX);
  const rows = await env.DB.prepare(
    "SELECT s.id, s.student_id, r.full_name, r.cohort, s.persona_id, s.started_at, s.duration_ms, s.overall_score, s.emailed_at, s.scores_json " +
      `FROM submissions s JOIN roster r ON r.student_id = s.student_id${filters.where} ` +
      `ORDER BY ${filters.order} LIMIT ${filters.limit}`,
  )
    .bind(...filters.binds)
    .all<SubmissionListRow & { scores_json: string }>();

  const criterionIds: string[] = [];
  const scoresByRow: Record<string, number | null>[] = [];
  for (const row of rows.results) {
    const scores: Record<string, number | null> = {};
    const parsed = parseJson(row.scores_json);
    if (Array.isArray(parsed)) {
      for (const entry of parsed) {
        if (entry === null || typeof entry !== "object") continue;
        const criterion = entry as { id?: unknown; score?: unknown };
        if (typeof criterion.id !== "string") continue;
        if (!criterionIds.includes(criterion.id)) criterionIds.push(criterion.id);
        scores[criterion.id] = typeof criterion.score === "number" ? criterion.score : null;
      }
    }
    scoresByRow.push(scores);
  }

  const header = [
    "student_id",
    "full_name",
    "cohort",
    "persona_id",
    "started_at_iso",
    "duration_ms",
    "overall_score",
    ...criterionIds,
  ];
  const lines = [header.map(csvField).join(",")];
  for (let i = 0; i < rows.results.length; i++) {
    const row = rows.results[i];
    const scores = scoresByRow[i];
    lines.push(
      [
        row.student_id,
        row.full_name,
        row.cohort ?? "",
        row.persona_id,
        isoFromUnix(row.started_at),
        String(row.duration_ms),
        row.overall_score === null ? "" : String(row.overall_score),
        ...criterionIds.map((id) => (scores[id] === undefined || scores[id] === null ? "" : String(scores[id]))),
      ]
        .map(csvField)
        .join(","),
    );
  }

  return new Response(lines.join("\r\n") + "\r\n", {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="submissions-${isoFromUnix(nowSeconds()).slice(0, 10)}.csv"`,
      "cache-control": "no-store",
    },
  });
}

// -------------------------------------------------------------- breakglass

/**
 * POST /api/admin/breakglass, body {studentId} (§6).
 *
 * A few students never receive the mailed code, for reasons neither they nor
 * the instructor can see. This mints a single-use link the instructor hands
 * over out of band. The token is opaque and 32 hex characters, NOT a six-digit
 * code: it travels outside email, so it has to be unguessable rather than
 * typeable. Only its SHA-256 is stored, and auth.ts handleRedeem consumes it.
 *
 * The address is the roster's, never one supplied with the request, which is
 * the same property the mailed-code flow rests on.
 */
async function breakglass(request: Request, env: Env): Promise<Response> {
  const parsed = await readJsonBody<{ studentId?: unknown }>(request);
  if (!parsed.ok) return parsed.response;
  const studentId = readText(parsed.value.studentId);
  if (studentId.length === 0) return json(400, { error: "studentId is required." });

  const student = await env.DB.prepare(
    "SELECT student_id, email, full_name FROM roster WHERE student_id = ? AND active = 1",
  )
    .bind(studentId)
    .first<{ student_id: string; email: string; full_name: string }>();
  if (!student) return json(404, { error: `No active student with ID ${studentId}.` });

  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const token = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  const now = nowSeconds();
  // One live code per address, same as a mailed code: this replaces any
  // outstanding one rather than leaving two ways in.
  await env.DB.prepare(
    "INSERT OR REPLACE INTO login_codes (email, code_hash, expires_at, attempts, requested_at) VALUES (?, ?, ?, 0, ?)",
  )
    .bind(student.email, await sha256Hex(token), now + BREAKGLASS_TTL_SECONDS, now)
    .run();

  return json(200, {
    url: `/api/auth/redeem?token=${token}`,
    expiresInMinutes: BREAKGLASS_TTL_SECONDS / 60,
    studentId: student.student_id,
    fullName: student.full_name,
  });
}

// ----------------------------------------------------------------- helpers

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function methodNotAllowed(): Response {
  return json(405, { error: "Method not allowed." });
}

function readText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** % and _ are wildcards in LIKE, so a search for "a_b" must not match "axb". */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * started_at is unix seconds (§3). Values that are plainly milliseconds are
 * converted rather than rendered as the year 55000, so a mismatch with whatever
 * writes submissions shows up as a plausible date instead of a broken export.
 */
function isoFromUnix(value: number): string {
  const ms = value > 1e11 ? value : value * 1000;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

/** RFC 4180: quote only when needed, and double an embedded quote. */
function csvField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Error && /UNIQUE constraint failed/i.test(err.message);
}
