import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { buildApprovalResolutionRef } from "../infra/approval-resolution-ref.js";
import { createUpdateRun } from "../infra/update-run-ledger.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "./openclaw-state-db-contract.js";
import {
  closeOpenClawStateDatabaseForTest,
  detectOpenClawStateDatabaseSchemaMigrations,
  openOpenClawStateDatabase,
  repairOpenClawStateDatabaseSchema,
} from "./openclaw-state-db.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "./openclaw-state-schema.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  vi.useRealTimers();
});

function createLegacyFixture(deferred: boolean) {
  const options = { env: { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-plugin-decisions-v18-") } };
  const initial = openOpenClawStateDatabase(options);
  initial.db.exec(OPENCLAW_STATE_SCHEMA_SQL);
  if (deferred) {
    createUpdateRun({ trigger: "cli", before: { version: "2026.9.2" } }, options);
  }
  const path = initial.path;
  closeOpenClawStateDatabaseForTest();
  const db = new DatabaseSync(path);
  try {
    const currentSql = db
      .prepare("SELECT sql FROM sqlite_schema WHERE name = 'operator_approvals'")
      .get()?.sql;
    if (typeof currentSql !== "string") {
      throw new Error("operator approval table missing");
    }
    const legacySql = currentSql
      .replaceAll(
        "'allow-once', 'allow-15m', 'allow-session', 'allow-always'",
        "'allow-once', 'allow-always'",
      )
      .replace("\n  CHECK (kind = 'plugin' OR decision NOT IN ('allow-15m', 'allow-session')),", "")
      .replace("AND (decision = 'allow-once' OR kind = 'plugin')", "AND decision = 'allow-once'");
    const resolutionRef = buildApprovalResolutionRef({
      approvalId: "approval",
      approvalKind: "plugin",
    });
    db.exec(`DROP TABLE operator_approvals; ${legacySql};
      PRAGMA user_version = 18;
      UPDATE schema_meta SET schema_version = 18;
      DELETE FROM config_machine_state WHERE state_key = 'state.schema.contentVersion';
      INSERT INTO operator_approvals (
        approval_id, resolution_ref, kind, status, presentation_json, authorization_json,
        resolver_actor_json, reviewer_device_ids_json, audience_session_keys_json,
        runtime_epoch, source_run_id, created_at_ms, expires_at_ms, updated_at_ms,
        decision, terminal_reason, resolved_at_ms, resolver_kind, resolver_id
      ) VALUES ('approval', '${resolutionRef}', 'plugin', 'allowed', '{"title":"Request"}',
        '{"requester":"original"}', '{"senderId":"owner"}', '[]', '["session"]',
        'epoch', 'run', 1, 100, 2, 'allow-once', 'user', 2, 'channel', 'owner');
      INSERT INTO operator_approval_execution_identities VALUES ('approval', 'context', 'execution');
      INSERT INTO operator_approval_standing_grants (
        grant_id, minted_by_approval_id, agent_id, cron_job_id, job_config_revision,
        operation_binding, created_at_ms
      ) VALUES ('existing-grant', 'approval', 'main', 'job', 'revision', 'binding', 2);
      INSERT INTO operator_approval_standing_grant_generations VALUES ('existing-grant', 1);
    `);
    return {
      options,
      path,
      approval: db.prepare("SELECT * FROM operator_approvals").all(),
      identity: db.prepare("SELECT * FROM operator_approval_execution_identities").all(),
      grants: db.prepare("SELECT * FROM operator_approval_standing_grants").all(),
      generations: db.prepare("SELECT * FROM operator_approval_standing_grant_generations").all(),
    };
  } finally {
    db.close();
  }
}

describe("scoped plugin approval decision storage upgrade", () => {
  it.each([
    { via: "runtime", deferred: false },
    { via: "doctor", deferred: false },
    { via: "doctor", deferred: true },
  ] as const)(
    "preserves approval provenance and children through $via (deferred: $deferred)",
    ({ via, deferred }) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(Date.parse("2026-10-12T00:00:00Z"));
      const fixture = createLegacyFixture(deferred);
      expect(detectOpenClawStateDatabaseSchemaMigrations(fixture.options)).toContainEqual({
        kind: "plugin-approval-decisions-v19",
        path: fixture.path,
      });
      if (via === "doctor") {
        expect(repairOpenClawStateDatabaseSchema(fixture.options).warnings).toEqual([]);
      }
      const { db } = openOpenClawStateDatabase(fixture.options);
      expect(db.prepare("SELECT * FROM operator_approvals").all()).toEqual(fixture.approval);
      expect(db.prepare("SELECT * FROM operator_approval_execution_identities").all()).toEqual(
        fixture.identity,
      );
      expect(db.prepare("SELECT * FROM operator_approval_standing_grants").all()).toEqual(
        fixture.grants,
      );
      expect(
        db.prepare("SELECT * FROM operator_approval_standing_grant_generations").all(),
      ).toEqual(fixture.generations);
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(db.prepare("PRAGMA foreign_keys").get()).toMatchObject({ foreign_keys: 1 });
      expect(db.prepare("PRAGMA user_version").get()).toMatchObject({
        user_version: deferred ? 18 : OPENCLAW_STATE_SCHEMA_VERSION,
      });
      if (deferred) {
        expect(
          db
            .prepare(
              "SELECT value_json FROM config_machine_state WHERE state_key = 'state.schema.contentVersion'",
            )
            .get(),
        ).toMatchObject({ value_json: "19" });
      }
      for (const decision of [
        "allow-once",
        "allow-15m",
        "allow-session",
        "allow-always",
      ] as const) {
        db.prepare(
          "UPDATE operator_approvals SET decision = ?, updated_at_ms = 3, consumed_at_ms = 3, consumed_by = 'run' WHERE approval_id = 'approval'",
        ).run(decision);
        expect(
          db.prepare("SELECT decision, consumed_by FROM operator_approvals").get(),
        ).toMatchObject({ decision, consumed_by: "run" });
      }
      for (const kind of ["exec", "system-agent"]) {
        for (const decision of ["allow-15m", "allow-session"]) {
          expect(() =>
            db
              .prepare(
                "UPDATE operator_approvals SET kind = ?, decision = ?, consumed_at_ms = NULL, consumed_by = NULL",
              )
              .run(kind, decision),
          ).toThrow(/CHECK/);
        }
        expect(() =>
          db.prepare("UPDATE operator_approvals SET kind = ?, decision = 'allow-always'").run(kind),
        ).toThrow(/CHECK/);
      }
      closeOpenClawStateDatabaseForTest();
      expect(
        openOpenClawStateDatabase(fixture.options)
          .db.prepare("SELECT decision, consumed_by FROM operator_approvals")
          .get(),
      ).toMatchObject({ decision: "allow-always", consumed_by: "run" });
      expect(detectOpenClawStateDatabaseSchemaMigrations(fixture.options)).toEqual([]);
    },
  );
});
