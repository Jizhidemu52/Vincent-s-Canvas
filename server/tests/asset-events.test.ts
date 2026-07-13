import { describe, expect, test } from "bun:test";

import { canManageResultState, projectAssetEvents, type AssetEventRecord } from "../src/asset-events";
import type { SessionUser } from "../src/types";

const event = (
  id: string,
  eventType: AssetEventRecord["eventType"],
  firstEffective = true,
  sourceEventId: string | null = null,
): AssetEventRecord => ({
  id,
  sequenceNo: Number(id),
  assetId: "asset-a",
  designerUserId: "designer-a",
  actorUserId: "designer-a",
  departmentId: "dept-a",
  groupId: null,
  projectId: null,
  projectExternalId: null,
  taskId: null,
  modelConfigId: null,
  eventType,
  prompt: "test prompt",
  credits: 2,
  rmbCost: 0.2,
  firstEffective,
  sourceEventId,
  occurredAt: `2026-07-13T00:00:${id.padStart(2, "0")}Z`,
  metadata: {},
});

const actor = (id: string, role: SessionUser["role"], departmentId: string | null): SessionUser => ({
  id, role, departmentId, username: id, displayName: id, email: null, employeeNo: null,
  departmentName: null, status: "active", mustChangePassword: false, mfaEnabled: false,
  groupId: null, groupName: null, groupRole: null,
  creditBalance: 0, creditLimit: 0, monthlyCreditLimit: 0, temporaryCreditAdjustment: 0,
  creditPeriodStart: "2026-07-01", creditResetAt: "2026-08-01",
});

describe("asset event projections", () => {
  test("scores each first effective behavior once and caps the result at 100", () => {
    const projection = projectAssetEvents([
      event("1", "asset.generated", false),
      event("2", "asset.candidate_added"),
      event("3", "asset.candidate_added", false),
      event("4", "asset.project_added"),
      event("5", "asset.edited"),
      event("6", "asset.reused"),
      event("7", "asset.downloaded"),
      event("8", "asset.downloaded", false),
      event("9", "asset.exported"),
      event("10", "asset.adopted"),
      event("11", "asset.delivered"),
    ]);

    expect(projection.usabilityScore).toBe(100);
    expect(projection.downloadCount).toBe(2);
    expect(projection.firstDownloadedAt).toBe("2026-07-13T00:00:07Z");
    expect(projection.resultStatus).toBe("delivered");
  });

  test("replays append-only reversals without deleting the original event", () => {
    const projection = projectAssetEvents([
      event("1", "asset.generated", false),
      event("2", "asset.adopted"),
      event("3", "asset.event_reversed", false, "2"),
    ]);

    expect(projection.resultStatus).toBe("unused");
    expect(projection.usabilityScore).toBe(0);
    expect(projection.eventCount).toBe(1);
  });

  test("limits result-state management to company or matching department administrators", () => {
    expect(canManageResultState(actor("root", "super_admin", null), "designer-a", "dept-a")).toBe(true);
    expect(canManageResultState(actor("manager", "department_admin", "dept-a"), "designer-a", "dept-a")).toBe(true);
    expect(canManageResultState(actor("manager", "department_admin", "dept-b"), "designer-a", "dept-a")).toBe(false);
    expect(canManageResultState(actor("designer-a", "designer", "dept-a"), "designer-a", "dept-a")).toBe(false);
    const leader = { ...actor("leader", "designer", "dept-a"), groupId: "group-a", groupName: "A组", groupRole: "leader" as const };
    expect(canManageResultState(leader, "designer-a", "dept-a", "group-a")).toBe(true);
    expect(canManageResultState(leader, "designer-b", "dept-a", "group-b")).toBe(false);
    expect(canManageResultState({ ...leader, groupRole: "member" }, "designer-a", "dept-a", "group-a")).toBe(false);
  });
});
