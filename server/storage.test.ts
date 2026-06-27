import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callApi, createServerState } from "./api";
import { loadServerState, saveServerState } from "./storage";
import type { GenerationRequest, Profile } from "../src/domain/workspace";

function request(patch: Partial<GenerationRequest> = {}): GenerationRequest {
  return {
    projectId: "project-sqlite",
    nodeId: "node-sqlite",
    modelId: "gpt-image-2-low",
    prompt: "make a clean internal product image",
    referenceNodeIds: ["node-sqlite"],
    outputCount: 1,
    operation: "generate",
    ...patch
  };
}

describe("server database storage", () => {
  it("persists platform state in sqlite tables instead of the JSON fallback", () => {
    const dir = mkdtempSync(join(tmpdir(), "designer-canvas-db-"));
    const databasePath = join(dir, "server-state.sqlite");
    try {
      const state = createServerState({ userId: "designer@company.local", designerName: "Mia", creditBalance: 30 });
      callApi(state, "/api/generations", request(), "sqlite-request-1", "designer@company.local");

      saveServerState(databasePath, state);
      const restored = loadServerState(databasePath);
      const restoredProfile = callApi(restored, "/api/profile", undefined, undefined, "designer@company.local") as Profile;
      const duplicate = callApi(restored, "/api/generations", request(), "sqlite-request-1", "designer@company.local") as { errorMessage: string };

      expect(existsSync(databasePath)).toBe(true);
      expect(restoredProfile.creditBalance).toBe(28);
      expect(duplicate.errorMessage).toBe("Duplicate request");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("creates queryable sqlite tables for platform records", async () => {
    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
    const dir = mkdtempSync(join(tmpdir(), "designer-canvas-db-tables-"));
    const databasePath = join(dir, "server-state.sqlite");
    try {
      const state = createServerState({ creditBalance: 30 });
      callApi(state, "/api/generations", request(), "sqlite-request-2");

      saveServerState(databasePath, state);

      const db = new DatabaseSync(databasePath, { readOnly: true });
      const tables = db
        .prepare("select name from sqlite_master where type = 'table' order by name")
        .all()
        .map((row) => String(row.name));
      const historyCount = db.prepare("select count(*) as count from generation_history").get() as { count: number };
      db.close();

      expect(tables).toEqual(
        expect.arrayContaining([
          "accounts",
          "assets",
          "audit_logs",
          "canvas_connections",
          "canvas_nodes",
          "credit_ledger",
          "generation_history",
          "generation_jobs",
          "generation_outputs",
          "model_configs",
          "projects",
          "submitted_requests"
        ])
      );
      expect(historyCount.count).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
