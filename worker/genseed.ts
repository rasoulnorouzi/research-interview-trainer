// Generates seed-personas.sql from src/personas.ts, the origin point for the
// built-in personas (BACKEND-PLAN.md §7, "keep that file in the repo ... it
// is the ultimate restore"). Run via `npm run seed:gen`, which bundles this
// file with esbuild and runs it under Node — it is NOT Worker code and is
// excluded from tsconfig.worker.json for that reason. Never import it from
// anything that runs in the Worker.
//
// The Worker re-appends SHARED_DISCLOSURE_MECHANICS to a persona's
// system_instruction at mint time (mirroring what buildCustomPersona() does
// today for custom personas), so the mechanics text is stripped back out
// here before writing the row. Stored rows hold only the persona-specific
// prompt; the shared rules live in one place, not copied into every row.

import { PERSONAS, SHARED_DISCLOSURE_MECHANICS } from "../src/personas";

function sqlString(value: string): string {
  return "'" + value.replace(/'/g, "''") + "'";
}

function sqlStringOrNull(value: string | undefined): string {
  return value === undefined ? "NULL" : sqlString(value);
}

const lines: string[] = [];

for (const persona of PERSONAS) {
  if (!persona.systemInstruction.endsWith(SHARED_DISCLOSURE_MECHANICS)) {
    throw new Error(
      `genseed: persona "${persona.id}" systemInstruction does not end with ` +
        `SHARED_DISCLOSURE_MECHANICS as expected. Refusing to write a seed ` +
        `row that would silently drop or duplicate the shared mechanics ` +
        `text — check src/personas.ts before re-running.`,
    );
  }
  const strippedInstruction = persona.systemInstruction.slice(
    0,
    persona.systemInstruction.length - SHARED_DISCLOSURE_MECHANICS.length,
  );

  lines.push(
    `INSERT OR REPLACE INTO personas ` +
      `(id, name, title, research_topic, short_bio, voice_name, system_instruction, hidden_core, active, updated_at, updated_by) ` +
      `VALUES (` +
      [
        sqlString(persona.id),
        sqlString(persona.name),
        sqlString(persona.title),
        sqlString(persona.researchTopic),
        sqlString(persona.shortBio),
        sqlString(persona.voiceName),
        sqlString(strippedInstruction),
        sqlStringOrNull(persona.hiddenCore),
        "1",
        "strftime('%s','now')",
        sqlString("seed"),
      ].join(", ") +
      `);`,
  );
}

lines.push("");
lines.push(
  `INSERT OR IGNORE INTO persona_versions (persona_id, snapshot, saved_at, saved_by) ` +
    `SELECT id, json_object('id',id,'name',name,'title',title,'research_topic',research_topic,'short_bio',short_bio,'voice_name',voice_name,'system_instruction',system_instruction,'hidden_core',hidden_core,'active',active), strftime('%s','now'), 'seed' FROM personas;`,
);

console.log(lines.join("\n"));
