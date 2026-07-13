import { describe, expect, test } from "bun:test";

import type { AssetEventRecord } from "../src/asset-events";
import { classifyDesignDirection } from "../src/design-direction";
import { aggregatePerformance, previousCalendarMonth } from "../src/performance";
import { resolveRange } from "../src/routes/performance";

describe("design performance", () => {
  test("classifies by admin tag, tool, operation and prompt in that order", () => {
    expect(classifyDesignDirection({ operationType: "upscale", adminTags: ["pattern"] }).primaryDirection).toBe("pattern");
    expect(classifyDesignDirection({ operationType: "inpaint", tool: "angle-control" }).primaryDirection).toBe("angle_control");
    expect(classifyDesignDirection({ operationType: "seamless_stitch", prompt: "服装款式" }).primaryDirection).toBe("seamless_stitch");
    const prompt = classifyDesignDirection({ operationType: "image_generation", prompt: "夏季女装连衣裙商品图" });
    expect(prompt.primaryDirection).toBe("apparel");
    expect(prompt.secondaryDirections).toContain("product");
    expect(prompt.ruleVersion).toBe("v1");
  });

  test("uses Shanghai boundaries and preserves explicit custom ranges", () => {
    const custom = resolveRange("custom", "2026-06-30T16:00:00.000Z", "2026-07-31T16:00:00.000Z");
    expect(custom).toEqual({ from: "2026-06-30T16:00:00.000Z", to: "2026-07-31T16:00:00.000Z" });
    const today = resolveRange("today");
    expect(new Date(today.to).getTime() - new Date(today.from).getTime()).toBe(86_400_000);
    expect(today.from.endsWith("T16:00:00.000Z")).toBe(true);
    expect(previousCalendarMonth("2026-01-15T16:00:00.000Z")).toEqual({
      from: "2025-11-30T16:00:00.000Z", to: "2025-12-31T16:00:00.000Z",
    });
  });

  test("keeps empty denominators null instead of inventing percentages", () => {
    const result = aggregatePerformance([], [], [], [], {
      from: "2026-06-30T16:00:00.000Z", to: "2026-07-31T16:00:00.000Z",
    }, { users: [], departments: [], groups: [] });
    expect(result.metrics.validOutputs).toBe(0);
    expect(result.metrics.activeDailyAverage).toBeNull();
    expect(result.metrics.successRate).toBeNull();
    expect(result.metrics.downloadRate).toBeNull();
    expect(result.metrics.onTimeDeliveryRate).toBeNull();
  });

  test("deduplicates funnel events and calculates rework and on-time delivery", () => {
    const task = { id: "task", userId: "user", userName: "张三", departmentId: "dept", departmentName: "设计部", groupId: "group",
      operationType: "image_generation", modelName: "Image", prompt: "商品图", status: "success", credits: 4, rmbCost: 0.8,
      requestedOutputs: 1, queuedAt: "2026-07-02T01:00:00.000Z", startedAt: "2026-07-02T01:00:00.000Z",
      completedAt: "2026-07-02T01:01:00.000Z", failureReason: null, batchId: null, deadlineAt: "2026-07-03T00:00:00.000Z" };
    const asset = { id: "asset", userId: "user", userName: "张三", departmentId: "dept", departmentName: "设计部", groupId: "group",
      groupName: "A组", taskId: "task", projectId: null, projectName: null, operationType: "image_generation", modelName: "Image",
      prompt: "商品图", primaryDirection: "product" as const, secondaryDirections: [], directionRuleVersion: "v1", directionEvidence: {},
      adminDirectionTags: [], createdAt: "2026-07-02T01:01:00.000Z", taskDeadlineAt: "2026-07-03T00:00:00.000Z", projectDeadlineAt: null };
    const event = (id: string, eventType: AssetEventRecord["eventType"], occurredAt: string, firstEffective = true): AssetEventRecord => ({
      id, sequenceNo: Number(id), assetId: "asset", designerUserId: "user", actorUserId: "user", departmentId: "dept", groupId: "group",
      projectId: null, projectExternalId: null, taskId: "task", modelConfigId: null, eventType, prompt: "商品图", credits: 4,
      rmbCost: 0.8, firstEffective, sourceEventId: null, occurredAt, metadata: {},
    });
    const result = aggregatePerformance([task], [asset], [
      event("1", "asset.generated", "2026-07-02T01:01:00.000Z"),
      event("2", "asset.downloaded", "2026-07-02T01:02:00.000Z"),
      event("3", "asset.downloaded", "2026-07-02T01:03:00.000Z", false),
      event("4", "asset.adopted", "2026-07-02T01:04:00.000Z"),
      event("5", "asset.edited", "2026-07-02T01:05:00.000Z"),
      event("6", "asset.delivered", "2026-07-02T02:00:00.000Z"),
    ], [], { from: "2026-07-01T16:00:00.000Z", to: "2026-07-03T16:00:00.000Z" }, { users: [], departments: [], groups: [] });
    expect(result.metrics.downloadRate).toBe(100);
    expect(result.metrics.reworkRate).toBe(100);
    expect(result.metrics.onTimeDeliveryRate).toBe(100);
    expect(result.metrics.averageDurationSeconds).toBe(60);
    expect(result.funnel.find((item) => item.stage === "downloaded")?.count).toBe(1);
  });
});
