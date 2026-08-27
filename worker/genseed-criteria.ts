// Generates seed-criteria.sql from src/criteria.ts, the origin point for the
// built-in scoring rubric (mirrors worker/genseed.ts for personas). Run via
// `npm run seed:gen:criteria`, which bundles this file with esbuild and runs
// it under Node — it is NOT Worker code and is excluded from
// tsconfig.worker.json for that reason. Never import it from anything that
// runs in the Worker.
//
// sort_order steps by 10 per row (10, 20, 30, ...) so the instructor can
// insert a new criterion between two existing ones from the dashboard
// without renumbering everything else.

import { CRITERIA } from "../src/criteria";

function sqlString(value: string): string {
  return "'" + value.replace(/'/g, "''") + "'";
}

const lines: string[] = [];

CRITERIA.forEach((criterion, i) => {
  const sortOrder = (i + 1) * 10;
  lines.push(
    `INSERT OR REPLACE INTO criteria ` +
      `(id, name, description, anchor_low, anchor_mid, anchor_high, scale_max, needs_ground_truth, sort_order, active, updated_at, updated_by) ` +
      `VALUES (` +
      [
        sqlString(criterion.id),
        sqlString(criterion.name),
        sqlString(criterion.description),
        sqlString(criterion.anchorLow),
        sqlString(criterion.anchorMid),
        sqlString(criterion.anchorHigh),
        String(criterion.scaleMax),
        criterion.needsGroundTruth ? "1" : "0",
        String(sortOrder),
        "1",
        "strftime('%s','now')",
        sqlString("seed"),
      ].join(", ") +
      `);`,
  );
});

lines.push("");
lines.push(
  `INSERT OR IGNORE INTO criteria_versions (criterion_id, snapshot, saved_at, saved_by) ` +
    `SELECT id, json_object('id',id,'name',name,'description',description,'anchor_low',anchor_low,'anchor_mid',anchor_mid,'anchor_high',anchor_high,'scale_max',scale_max,'needs_ground_truth',needs_ground_truth,'sort_order',sort_order,'active',active), strftime('%s','now'), 'seed' FROM criteria;`,
);

console.log(lines.join("\n"));
