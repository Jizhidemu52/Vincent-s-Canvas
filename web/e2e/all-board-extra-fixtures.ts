import type { BrowserContext } from "@playwright/test";
import { moduleDefinitions, toolDefinitions } from "../../shared/feature-catalog";
import type { PerformanceDashboard } from "../src/services/api/performance";
import type { MockCanvasApi } from "./fixtures";

export const OWNER = "00000000-0000-4000-8000-000000000099";
export const GROUP = "40000000-0000-4000-8000-000000000001";
export const AUDIO_TASK = "40000000-0000-4000-8000-000000000002";
const imageModel = { id: "10000000-0000-4000-8000-000000000001", modelId: "gpt-image-2", name: "E2E Image", capabilities: ["generate", "edit", "batch"], creditCost: 0, rmbCost: 0 };
const audioModel = { id: "10000000-0000-4000-8000-000000000002", modelId: "gpt-4o-mini-tts", name: "E2E Speech", capabilities: ["audio"], creditCost: 0, rmbCost: 0 };

/** Two-second real PCM file. The UI must retain these bytes, not a sample/PNG stand-in. */
export function fixtureWav() {
    const samples = 16_000, wav = Buffer.alloc(44 + samples * 2);
    wav.write("RIFF", 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8);
    wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(8_000, 24); wav.writeUInt32LE(16_000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
    wav.write("data", 36); wav.writeUInt32LE(wav.length - 44, 40);
    for (let index = 0; index < samples; index++) wav.writeInt16LE(Math.round(Math.sin(index * 2 * Math.PI * 220 / 8_000) * 4_000), 44 + index * 2);
    return wav;
}

export async function configureCanvasTools(context: BrowserContext, api: MockCanvasApi, disabled: string[] = []) {
    await context.route("**/api/models", route => route.fulfill({ json: { models: [imageModel, audioModel], prices: [],
        tools: toolDefinitions.map(tool => ({ ...tool, enabled: !disabled.includes(tool.toolKey), configurationVersion: 1,
            modelConfigId: tool.toolKey === "canvas-audio" ? audioModel.id : imageModel.id })) } }));
    await context.route("**/api/tasks/preflight", route => route.fulfill({ json: { ok: true, normalized: {} } }));
    await context.route("**/api/tasks/by-request/*", route => {
        const requestId = decodeURIComponent(new URL(route.request().url()).pathname.split("/").at(-1)!);
        return route.fulfill({ json: { task: [...api.tasks.values()].find(task => task.requestId === requestId) } });
    });
}

export async function configureAudioTask(context: BrowserContext, api: MockCanvasApi, wav: Buffer) {
    await context.route(/\/api\/tasks(?:\?.*)?$/, route => {
        if (route.request().method() !== "POST") return route.fallback();
        const input = route.request().postDataJSON();
        if (input.operationType !== "audio_generation") return route.fallback();
        api.submissions.push(input);
        const task = { ...input, id: AUDIO_TASK, userId: OWNER, status: "queued", resultUrls: [], failureReason: null, createdAt: new Date().toISOString() };
        api.tasks.set(AUDIO_TASK, task); api.assetBytes.set(AUDIO_TASK, wav);
        api.assets.set(AUDIO_TASK, { id: AUDIO_TASK, ownerUserId: OWNER, status: "ready", mimeType: "audio/wav", contentUrl: `/api/assets/${AUDIO_TASK}/content` });
        return route.fulfill({ status: 201, json: { task } });
    });
    await context.route("**/api/assets/*/content", route => {
        const id = new URL(route.request().url()).pathname.split("/")[3], asset = api.assets.get(id);
        return asset?.mimeType?.startsWith("audio/")
            ? route.fulfill({ contentType: asset.mimeType, body: api.assetBytes.get(id) || wav }) : route.fallback();
    });
}

const date = "2026-11-06T08:00:00Z";
const policy = { monthlySharedCreditLimit: 1_000, perRequestLimit: 50, dailyUserLimit: 100, monthlyUserLimit: 300 };
const request = { id: "team-request", requestId: "seed-claim", userId: OWNER, userName: "隔离设计师", amount: 10, reason: "E2E 团队批量改图", status: "pending", decisionNote: null, createdAt: date, reviewedAt: null };
const history = { id: "team-task", userId: OWNER, userName: "隔离设计师", operationType: "inpaint", modelName: "E2E Image", prompt: "E2E 本组原始提示词", credits: 12, rmbCost: 0.12, status: "success", failureReason: null, createdAt: date };

function performanceData(): PerformanceDashboard {
    return {
        period: { from: "2026-11-01T00:00:00+08:00", to: "2026-11-08T00:00:00+08:00" },
        metrics: { requestedOutputs: 4, validOutputs: 3, naturalDailyAverage: 0.43, activeDailyAverage: 3, successCount: 3, failedCount: 1, cancelledCount: 0,
            successRate: 75, batchCompletionRate: 75, averageDurationSeconds: 15, reworkRate: 0, onTimeDeliveryRate: 100, totalCredits: 12, totalRmbCost: 0.12,
            averageCreditsPerOutput: 4, averageCostPerOutput: 0.04, averageCostPerAdopted: 0.06, downloadRate: 66.67, averageUsabilityScore: 60 },
        trend: [{ date: "2026-11-06", outputs: 3, success: 3, failed: 1, credits: 12 }],
        directions: [{ direction: "apparel", count: 3, rate: 100 }],
        funnel: [{ stage: "generated", count: 3, rate: 100 }, { stage: "downloaded", count: 2, rate: 66.67 }],
        designers: [{ userId: OWNER, userName: "隔离设计师", departmentName: "E2E 设计部", groupName: "E2E 设计组", outputs: 3,
            successRate: 75, downloadRate: 66.67, reuseRate: 0, adoptionRate: 66.67, deliveryRate: 33.33, usabilityScore: 60, credits: 12, rmbCost: 0.12, topDirection: "apparel" }],
        failureReasons: [{ reason: "E2E 模拟失败", count: 1 }],
        tasks: [{ ...history, queuedAt: date, completedAt: date }],
        assets: [{ id: "performance-asset", userName: "隔离设计师", departmentName: "E2E 设计部", groupName: "E2E 设计组", projectName: "E2E 项目",
            operationType: "inpaint", modelName: "E2E Image", prompt: "E2E 效能成果提示词", primaryDirection: "apparel", secondaryDirections: [], adminDirectionTags: [],
            directionRuleVersion: "fixture", createdAt: date, resultStatus: "adopted", usabilityScore: 60 }],
        options: { users: [{ value: OWNER, label: "隔离设计师", departmentId: null, groupId: GROUP }], departments: [], groups: [] }, comparisons: null,
    };
}

export async function configureTeam(context: BrowserContext, api: MockCanvasApi, options: {
    credits?: boolean; groupRole?: "member" | "leader" | "none"; teamEnabled?: boolean; performanceEnabled?: boolean; denyPerformance?: boolean;
} = {}) {
    const groupRole = options.groupRole || "member", credits = options.credits !== false;
    const reads: string[] = [], writes: Array<{ path: string; input: any }> = [];
    const mine = { groupId: GROUP, periodStart: "2026-11-01", poolBalance: 500, policy, wallet: { grantedCredits: 20, availableCredits: 15, spentCredits: 5 }, requests: [] as any[] };
    const managed = { groupId: GROUP, period: { periodStart: "2026-11-01", fixedCredits: 1_000, contributedCredits: 0, allocatedCredits: 500, expiredCredits: 0, poolBalance: 500 }, policy, requests: [structuredClone(request)], wallets: [], ledger: [] };
    const dashboard = performanceData();
    let creditBalance = 100;
    await context.route("**/api/deployment", route => route.fulfill({ json: { authenticationEnabled: true, creditsEnabled: credits, rolePortalsEnabled: true, oaLoginEnabled: false } }));
    await context.route("**/api/auth/session", route => route.fulfill({ json: { user: { id: OWNER, username: "e2e", displayName: "隔离设计师", role: "designer", status: "active", creditBalance,
        ...(groupRole !== "none" ? { groupId: GROUP, groupName: "E2E 设计组", groupRole } : {}) } } }));
    await context.route("**/api/modules", route => route.fulfill({ json: { modules: moduleDefinitions.map(item => ({ moduleKey: item.moduleKey,
        enabled: item.moduleKey === "team" ? options.teamEnabled !== false : item.moduleKey === "performance" ? options.performanceEnabled !== false : true })) } }));
    await context.route(/\/api\/(?:team(?:\/|\?|$)|performance(?:\/|\?|$)|group-credits(?:\/|\?|$))/, route => {
        const req = route.request(), url = new URL(req.url()), path = url.pathname;
        if (req.method() === "GET") reads.push(path + url.search);
        else writes.push({ path, input: req.postDataJSON() });
        const json = (value: unknown, status = 200) => route.fulfill({ status, json: value });
        if (path === "/api/group-credits") return json(mine);
        if (path === "/api/group-credits/requests") {
            mine.requests.push({ ...request, ...req.postDataJSON(), id: "member-request" });
            return json({ id: "member-request", status: "pending", duplicate: false });
        }
        if (path === "/api/group-credits/contributions") {
            creditBalance -= req.postDataJSON().amount; mine.poolBalance += req.postDataJSON().amount;
            return json({ poolBalance: mine.poolBalance, personalBalance: creditBalance, duplicate: false });
        }
        if (groupRole !== "leader") return json({ error: "FORBIDDEN", message: "只有管理员和小组组长可以查看设计效能" }, 403);
        if (path === "/api/team") return json({ group: { id: GROUP, name: "E2E 设计组", code: "E2E", departmentName: "E2E 设计部", memberCount: 1 },
            members: [{ id: OWNER, displayName: "隔离设计师", username: "e2e", status: "active", role: "leader", effectiveAt: date, creditBalance, monthlyCreditLimit: 100 }],
            summary: { taskCount: 4, successCount: 3, credits: 12, rmbCost: 0.12 } });
        if (path === "/api/team/history") return json({ history: [history] });
        if (path === "/api/team/audit") return json({ auditLogs: [] });
        if (path === "/api/team/group-credits") return json(managed);
        if (path === "/api/team/history/export") return route.fulfill({ contentType: "text/csv;charset=utf-8", body: "user,prompt,status\nE2E,E2E 本组原始提示词,success\n" });
        if (path === "/api/team/group-credits/requests/team-request/decision") {
            managed.requests[0].status = req.postDataJSON().decision;
            return json({ status: managed.requests[0].status, duplicate: false });
        }
        if (path === "/api/performance") return options.denyPerformance ? json({ error: "FORBIDDEN", message: "E2E_SCOPE_DENIED" }, 403) : json(dashboard);
        if (path === "/api/performance/assets/performance-asset/direction") {
            dashboard.assets[0].primaryDirection = req.postDataJSON().primaryDirection;
            return json({ direction: req.postDataJSON() });
        }
        api.unexpected.push(`${req.method()} ${path}`);
        return json({ message: "Unknown extra QA API" }, 501);
    });
    return { reads, writes, dashboard, mine, managed };
}
