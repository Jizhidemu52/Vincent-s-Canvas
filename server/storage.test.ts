import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adjustAccountCredits, callApi, configureModelPricing, createServerState, getAssetContent, saveWorkspaceSnapshot } from "./api";
import { loadServerState, saveServerState } from "./storage";
import { addAssetToProject, createInitialWorkspace, createProject } from "../src/domain/workspace";
import type { GenerationRequest, GenerationResult, HistoryEntry, Profile } from "../src/domain/workspace";

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
  it("merges new default provider models into older persisted registries without losing admin pricing", () => {
    const dir = mkdtempSync(join(tmpdir(), "designer-canvas-model-migration-"));
    const statePath = join(dir, "server-state.json");
    try {
      const oldState = createServerState({ creditBalance: 30 });
      oldState.models = oldState.models
        .filter((model) => !["recraft-v3", "runninghub-fashion-workflow", "comfyui-fashion-workflow"].includes(model.id))
        .map((model) => (model.id === "gpt-image-2-medium" ? { ...model, cost: 9, priceCents: 450, currency: "CNY" } : model));

      saveServerState(statePath, oldState);
      const restored = loadServerState(statePath);
      const restoredModels = callApi(restored, "/api/models") as ReturnType<typeof createServerState>["models"];

      expect(restoredModels.find((model) => model.id === "gpt-image-2-medium")).toMatchObject({ cost: 9, priceCents: 450, currency: "CNY" });
      expect(restoredModels.find((model) => model.id === "recraft-v3")).toMatchObject({ provider: "recraft", capability: ["generate", "edit"] });
      expect(restoredModels.find((model) => model.id === "runninghub-fashion-workflow")).toMatchObject({ provider: "runninghub" });
      expect(restoredModels.find((model) => model.id === "comfyui-fashion-workflow")).toMatchObject({ provider: "comfyui" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("persists platform state in sqlite tables instead of the JSON fallback", () => {
    const dir = mkdtempSync(join(tmpdir(), "designer-canvas-db-"));
    const databasePath = join(dir, "server-state.sqlite");
    try {
      const state = createServerState({ userId: "designer@company.local", designerName: "Mia", creditBalance: 30 });
      callApi(state, "/api/generations", request(), "sqlite-request-1", "designer@company.local");
      const asset = callApi(
        state,
        "/api/assets" as never,
        {
          title: "sqlite-reference.png",
          source: "data:image/png;base64,aGVsbG8=",
          tags: ["reference"]
        } as never,
        undefined,
        "designer@company.local"
      ) as { id: string; source: string };

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
      const restoredAssetContent = getAssetContent(restored, asset.id, "designer@company.local");

      expect(existsSync(databasePath)).toBe(true);
      expect(restoredProfile.creditBalance).toBe(28);
      expect(asset.source).toBe(`/api/assets/${encodeURIComponent(asset.id)}/content`);
      expect(restoredAssetContent).toHaveProperty("bytes");
      if ("bytes" in restoredAssetContent) {
        expect(restoredAssetContent.bytes.toString("utf8")).toBe("hello");
      }
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
      const { workspace, project } = createProject(createInitialWorkspace(state.profile), "SQLite trace board");
      const withReference = addAssetToProject(workspace, project.id, {
        name: "sqlite-reference.png",
        source: "/uploads/sqlite-reference.png",
        width: 640,
        height: 800
      });
      const source = withReference.projects[0].nodes[0];
      saveWorkspaceSnapshot(state, withReference);
      callApi(
        state,
        "/api/generations",
        request({
          projectId: project.id,
          nodeId: source.id,
          referenceNodeIds: [source.id],
          outputCount: 2,
          providerSettings: { size: "1536x1024", quality: "high", preset: "catalog" }
        }),
        "sqlite-request-2"
      );
      adjustAccountCredits(state, { targetUserId: "alice@company.local", delta: 25, reason: "monthly allocation" }, "admin@company.local");

      saveServerState(databasePath, state);

      const db = new DatabaseSync(databasePath, { readOnly: true });
      let tables: string[];
      let historyCount: { count: number };
      let jobCount: { count: number };
      let outputCount: { count: number };
      let outputRecord: { job_id: string; user_id: string; output_json: string };
      let historyRecord: {
        price_cents: number;
        currency: string;
        operation: string;
        output_count: number;
        reference_count: number;
        designer_name: string;
        prompt: string;
        history_json: string;
      };
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
        historyRecord = db
          .prepare(
            "select price_cents, currency, operation, output_count, reference_count, designer_name, prompt, history_json from generation_history"
          )
          .get() as typeof historyRecord;
        ledgerRows = db
          .prepare("select user_id, model_id, credit_cost, price_cents, currency from credit_ledger order by model_id")
          .all() as Array<{ user_id: string; model_id: string; credit_cost: number; price_cents: number | null; currency: string | null }>;
      } finally {
        db.close();
      }

      expect(tables).toEqual(
        expect.arrayContaining([
          "accounts",
          "asset_blobs",
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
      expect(outputCount.count).toBe(2);
      expect(outputRecord).toMatchObject({ job_id: "job-history-1", user_id: "designer-demo" });
      expect(JSON.parse(outputRecord.output_json)).toMatchObject({
        name: "GPT Image 2 Low output 1.jpg",
        source: `mock://openai/generate/${source.id}/1`
      });
      expect(historyRecord).toMatchObject({
        price_cents: 150,
        currency: "CNY",
        operation: "generate",
        output_count: 2,
        reference_count: 1,
        designer_name: "Demo Designer",
        prompt: "make a clean internal product image"
      });
      const persistedHistory = JSON.parse(historyRecord.history_json) as HistoryEntry;
      expect(persistedHistory).toMatchObject({
        projectId: project.id,
        projectName: "SQLite trace board",
        nodeId: source.id,
        modelId: "gpt-image-2-low",
        prompt: "make a clean internal product image",
        outputCount: 2,
        creditCost: 4,
        userId: "designer-demo",
        designerName: "Demo Designer",
        operation: "generate",
        referenceCount: 1,
        references: [{ name: "sqlite-reference.png", source: "/uploads/sqlite-reference.png", width: 640, height: 800 }],
        outputs: [
          { name: "GPT Image 2 Low output 1.jpg", source: `mock://openai/generate/${source.id}/1`, width: 1536, height: 1024 },
          { name: "GPT Image 2 Low output 2.jpg", source: `mock://openai/generate/${source.id}/2`, width: 1536, height: 1024 }
        ],
        providerSettings: { size: "1536x1024", quality: "high", preset: "catalog" }
      });
      expect(ledgerRows).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ user_id: "alice@company.local", model_id: "admin-credit-adjustment", credit_cost: 25, price_cents: null, currency: null }),
          expect.objectContaining({ user_id: "designer-demo", model_id: "gpt-image-2-low", credit_cost: 4, price_cents: 150, currency: "CNY" })
        ])
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
