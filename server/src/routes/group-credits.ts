import { Router } from "express";
import { z } from "zod";

import type { Database } from "../db";
import {
  configureGroupCreditPolicy,
  contributePersonalCredits,
  decideGroupCreditRequest,
  getManagedGroupCredits,
  getMyGroupCredits,
  submitGroupCreditRequest,
} from "../group-credits";
import { isGroupLeader } from "../group-scope";
import { assertModuleEnabled } from "../module-flags";
import { requireRole } from "../rbac";
import type { AuthenticatedRequest } from "../types";

const requestSchema = z.object({
  requestId: z.string().trim().min(8).max(200),
  amount: z.number().int().min(1).max(1_000_000),
  reason: z.string().trim().min(2).max(500),
});
const contributionSchema = z.object({
  requestId: z.string().trim().min(8).max(200),
  amount: z.number().int().min(1).max(1_000_000),
});
const decisionSchema = z.object({
  decision: z.enum(["approved", "rejected"]),
  note: z.string().trim().max(500).optional(),
});
const policySchema = z.object({
  monthlySharedCreditLimit: z.number().int().min(0).max(10_000_000),
  perRequestLimit: z.number().int().min(0).max(10_000_000),
  dailyUserLimit: z.number().int().min(0).max(10_000_000),
  monthlyUserLimit: z.number().int().min(0).max(10_000_000),
  applyCurrentPeriod: z.boolean().default(false),
}).superRefine((value, context) => {
  if (value.monthlySharedCreditLimit > 0) {
    for (const key of ["perRequestLimit", "dailyUserLimit", "monthlyUserLimit"] as const) {
      if (value[key] === 0) {
        context.addIssue({ code: "custom", path: [key], message: "启用共享池时领取上限必须大于 0" });
      }
    }
  }
  if (value.perRequestLimit > value.dailyUserLimit && value.dailyUserLimit > 0) {
    context.addIssue({ code: "custom", path: ["perRequestLimit"], message: "单次上限不能超过每日上限" });
  }
  if (value.dailyUserLimit > value.monthlyUserLimit && value.monthlyUserLimit > 0) {
    context.addIssue({ code: "custom", path: ["dailyUserLimit"], message: "每日上限不能超过每月上限" });
  }
});

export function createGroupCreditsRouter(db: Database) {
  const router = Router();
  router.use(async (request, _response, next) => {
    try { await assertModuleEnabled(db, "team"); next(); }
    catch (error) { next(error); }
  });

  router.get("/", async (request, response, next) => {
    try {
      const actor = (request as unknown as AuthenticatedRequest).auth;
      response.json(await getMyGroupCredits(db, actor));
    } catch (error) { next(error); }
  });

  router.post("/requests", async (request, response, next) => {
    try {
      const actor = (request as unknown as AuthenticatedRequest).auth;
      const input = requestSchema.parse(request.body);
      response.status(201).json(await submitGroupCreditRequest(db, { actor, ...input, ip: request.ip }));
    } catch (error) { next(error); }
  });

  router.post("/contributions", async (request, response, next) => {
    try {
      const actor = (request as unknown as AuthenticatedRequest).auth;
      const input = contributionSchema.parse(request.body);
      response.status(201).json(await contributePersonalCredits(db, { actor, ...input, ip: request.ip }));
    } catch (error) { next(error); }
  });
  return router;
}

export function createTeamGroupCreditsRouter(db: Database) {
  const router = Router();
  router.use(async (request, response, next) => {
    const actor = (request as unknown as AuthenticatedRequest).auth;
    if (!isGroupLeader(actor) || !actor.groupId) {
      response.status(403).json({ error: "FORBIDDEN", message: "只有当前小组组长可以审批" }); return;
    }
    try { await assertModuleEnabled(db, "team"); next(); }
    catch (error) { next(error); }
  });
  router.get("/", async (request, response, next) => {
    try {
      const actor = (request as unknown as AuthenticatedRequest).auth;
      response.json(await getManagedGroupCredits(db, actor, actor.groupId!));
    } catch (error) { next(error); }
  });
  router.post("/requests/:id/decision", async (request, response, next) => {
    try {
      const actor = (request as unknown as AuthenticatedRequest).auth;
      const input = decisionSchema.parse(request.body);
      response.json(await decideGroupCreditRequest(db, { actor, requestId: request.params.id, ...input, ip: request.ip }));
    } catch (error) { next(error); }
  });
  return router;
}

export function createAdminGroupCreditsRouter(db: Database) {
  const router = Router();
  router.use(requireRole("super_admin", "department_admin"));
  router.get("/:groupId", async (request, response, next) => {
    try {
      const actor = (request as unknown as AuthenticatedRequest).auth;
      response.json(await getManagedGroupCredits(db, actor, request.params.groupId));
    } catch (error) { next(error); }
  });
  router.patch("/:groupId/policy", async (request, response, next) => {
    try {
      const actor = (request as unknown as AuthenticatedRequest).auth;
      const input = policySchema.parse(request.body);
      response.json(await configureGroupCreditPolicy(db, { actor, groupId: request.params.groupId, ...input, ip: request.ip }));
    } catch (error) { next(error); }
  });
  router.post("/:groupId/requests/:id/decision", async (request, response, next) => {
    try {
      const actor = (request as unknown as AuthenticatedRequest).auth;
      const input = decisionSchema.parse(request.body);
      response.json(await decideGroupCreditRequest(db, { actor, requestId: request.params.id, ...input, ip: request.ip }));
    } catch (error) { next(error); }
  });
  return router;
}
