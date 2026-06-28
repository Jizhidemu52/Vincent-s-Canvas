import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adjustAccountCredits, callApi, configureModelPricing, createServerState } from "./api";
import { loadServerState, saveServerState } from "./storage";
import type { GenerationRequest, GenerationResult, Profile } from "../src/domain/workspace";

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
      const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
      const db = new DatabaseSync(databasePath);
      try {
        db.exec("delete from platform_state");
      } finally {
        db.close();
      }
      const restored = loadServerState(databasePath);
      const restoredProfile = callApi(restored, "/api/profile", undefined, undefined, "designer@company.local") as Profile;
      const duplicate = callApi(restored, "/api/generations", request(), "sqlite-request-1", "designer@company.local") as { errorMessage: string };
      const otherDesigner = callApi(restored, "/api/generations", request(), "sqlite-request-1", "other@company.local") as GenerationResult;
      const otherProfile = callApi(restored, "/api/profile", undefined, undefined, "other@company.local") as Profile;
      const jobs = callApi(restored, "/api/admin/jobs", undefined, undefined, "admin@company.local") as ReturnType<typeof createServerState>["generationJobs"];

      expect(existsSync(databasePath)).toBe(true);
      expect(restoredProfile.creditBalance).toBe(28);
      expect(duplicate.errorMessage).toBe("Duplicate request");
      expect(otherDesigner.status).toBe("succeeded");
      expect(otherProfile.creditBalance).toBe(26);
      expect(jobs).toEqual(expect.arrayContaining([expect.objectContaining({ userId: "designer@company.local", status: "succeeded" })]));
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
      configureModelPricing(state, { modelId: "gpt-image-2-low", cost: 2, priceCents: 150, currency: "CNY" }, "admin@company.local");
      callApi(state, "/api/generations", request(), "sqlite-request-2");
      adjustAccountCredits(state, { targetUserId: "alice@company.local", delta: 25, reason: "monthly allocation" }, "admin@company.local");

      saveServerState(databasePath, state);

      const db = new DatabaseSync(databasePath, { readOnly: true });
      let tables: string[];
      let historyCount: { count: number };
      let jobCount: { count: number };
      let outputCount: { count: number };
      let outputRecord: { job_id: string; user_id: string; output_json: string };
      let historyBilling: { price_cents: number; currency: string };
      let ledgerRows: Array<{ user_id: string; model_id: string; credit_cost: number; price_cents: number | null; currency: string | null }>;
      try {
        tables = db
          .prepare("select name from sqlite_master where type = 'table' order by name")
          .all()
          .map((row) => String(row.name));
        historyCount = db.prepare("select count(*) as count from generation_history").get() as { count: number };
        jobCount = db.prepare("select count(*) as count from generation_jobs").get() as { count: number };
        outputCount = db.prepare("select count(*) as count from generation_outputs").get() as { count: number };
        outputRecord = db.prepare("select job_id, user_id, output_json from generation_outputs").get() as {
          job_id: string;
          user_id: string;
          output_json: string;
        };
        historyBilling = db.prepare("select price_cents, currency from generation_history").get() as { price_cents: number; currency: string };
        ledgerRows = db
          .prepare("select user_id, model_id, credit_cost, price_cents, currency from credit_ledger order by model_id")
          .all() as Array<{ user_id: string; model_id: string; credit_cost: number; price_cents: number | null; currency: string | null }>;
      } finally {
        db.close();
      }

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
      expect(jobCount.count).toBe(1);
      expect(outputCount.count).toBe(1);
      expect(outputRecord).toMatchObject({ job_id: "job-history-1", user_id: "designer-demo" });
      expect(JSON.parse(outputRecord.output_json)).toMatchObject({
        name: "GPT Image 2 Low output 1.jpg",
        source: "mock://openai/generate/node-sqlite/1"
      });
      expect(historyBilling).toEqual({ price_cents: 150, currency: "CNY" });
      expect(ledgerRows).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ user_id: "alice@company.local", model_id: "admin-credit-adjustment", credit_cost: 25, price_cents: null, currency: null }),
          expect.objectContaining({ user_id: "designer-demo", model_id: "gpt-image-2-low", credit_cost: 2, price_cents: 150, currency: "CNY" })
        ])
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
