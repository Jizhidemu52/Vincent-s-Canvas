import { describe, expect, test } from "bun:test";

import {
    applyDesignerCreditChange,
    applyUsageCharge,
    authenticateAdminSession,
    authenticateUserAccount,
    canAccessAdmin,
    createDefaultAdminState,
    estimateAdminCredits,
    getPublicProviderModels,
    createAdminWorkflow,
    createBatchTaskFromToolMode,
    createHistoryRecordFromToolMode,
    deleteAdminWorkflow,
    saveAdminApiProviderSecret,
    upsertDesignerAccount,
    upsertAdminWorkflow,
    upsertAdminApiProvider,
    upsertAdminModel,
    upsertPricingRule,
} from "../src/lib/admin-domain";

describe("admin-domain", () => {
    test("estimates credits from operation rule and enabled model price", () => {
        const state = createDefaultAdminState("2026-07-08T00:00:00.000Z");
        const cost = estimateAdminCredits(state, {
            operationType: "image_generation",
            modelId: "gpt-image-2",
            quantity: 3,
        });

        expect(cost.credits).toBe(36);
        expect(cost.rmb).toBe(3.6);
        expect(cost.breakdown).toEqual({
            operationCredits: 8,
            modelCredits: 4,
            quantity: 3,
            unitCredits: 12,
        });
    });

    test("does not charge twice for the same request id", () => {
        let state = createDefaultAdminState("2026-07-08T00:00:00.000Z");
        const request = {
            requestId: "request-1",
            designerId: "designer-1",
            operationType: "image_generation" as const,
            modelId: "gpt-image-2",
            quantity: 2,
            projectId: "project-1",
            prompt: "test prompt",
            resultUrls: ["blob:one", "blob:two"],
            createdAt: "2026-07-08T00:01:00.000Z",
        };

        const first = applyUsageCharge(state, request);
        expect(first.ok).toBe(true);
        state = first.state;
        const afterFirst = state.designers.find((designer) => designer.id === "designer-1");
        expect(afterFirst?.quotaRemaining).toBe(476);
        expect(afterFirst?.quotaUsed).toBe(24);
        expect(state.ledger).toHaveLength(1);

        const second = applyUsageCharge(state, request);
        expect(second.ok).toBe(true);
        expect(second.duplicate).toBe(true);
        const afterSecond = second.state.designers.find((designer) => designer.id === "designer-1");
        expect(afterSecond?.quotaRemaining).toBe(476);
        expect(afterSecond?.quotaUsed).toBe(24);
        expect(second.state.ledger).toHaveLength(1);
    });

    test("blocks usage when quota is insufficient and leaves no dirty ledger", () => {
        const state = {
            ...createDefaultAdminState("2026-07-08T00:00:00.000Z"),
            designers: [
                {
                    id: "designer-1",
                    loginName: "designer-1",
                    password: "123456",
                    name: "低额度设计师",
                    role: "designer" as const,
                    quotaRemaining: 5,
                    quotaUsed: 0,
                    quotaLimit: 5,
                    status: "active" as const,
                    createdAt: "2026-07-08T00:00:00.000Z",
                    updatedAt: "2026-07-08T00:00:00.000Z",
                },
            ],
        };

        const result = applyUsageCharge(state, {
            requestId: "request-over-limit",
            designerId: "designer-1",
            operationType: "image_generation",
            modelId: "gpt-image-2",
            quantity: 1,
            projectId: "project-1",
            prompt: "test prompt",
            resultUrls: [],
            createdAt: "2026-07-08T00:01:00.000Z",
        });

        expect(result.ok).toBe(false);
        expect(result.reason).toBe("额度不足");
        expect(result.state.designers[0]?.quotaRemaining).toBe(5);
        expect(result.state.ledger).toHaveLength(0);
    });

    test("prevents non-admins from changing quota, pricing, and model config", () => {
        const state = createDefaultAdminState("2026-07-08T00:00:00.000Z");

        expect(applyDesignerCreditChange(state, { operatorId: "designer-1", designerId: "designer-2", amount: 10, reason: "manual", createdAt: "2026-07-08T00:02:00.000Z" }).ok).toBe(false);
        expect(upsertPricingRule(state, { operatorId: "designer-1", rule: { operationType: "upscale", label: "放大图片", credits: 99, rmbCost: 9.9 }, createdAt: "2026-07-08T00:02:00.000Z" }).ok).toBe(false);
        expect(upsertAdminModel(state, { operatorId: "designer-1", model: { id: "internal", name: "内部模型", modelId: "internal-v1", provider: "内部", capabilities: ["generate"], credits: 1, rmbCost: 0.1, enabled: true }, createdAt: "2026-07-08T00:02:00.000Z" }).ok).toBe(false);
    });

    test("only active admins can create an admin session", () => {
        const state = createDefaultAdminState("2026-07-08T00:00:00.000Z");

        const adminLogin = authenticateAdminSession(state, "admin-1", "2026-07-08T00:03:00.000Z");
        expect(adminLogin.ok).toBe(true);
        expect(adminLogin.session?.userId).toBe("admin-1");
        expect(canAccessAdmin(state, adminLogin.session)).toBe(true);

        const designerLogin = authenticateAdminSession(state, "designer-1", "2026-07-08T00:03:00.000Z");
        expect(designerLogin.ok).toBe(false);
        expect(designerLogin.reason).toBe("只有管理员可以进入后台");
        expect(canAccessAdmin(state, designerLogin.session)).toBe(false);
    });

    test("admins can open designer accounts and password login respects role and status", () => {
        let state = createDefaultAdminState("2026-07-08T00:00:00.000Z");
        const created = upsertDesignerAccount(state, {
            operatorId: "admin-1",
            account: {
                loginName: "designer-new",
                password: "new-pass",
                name: "新设计师",
                role: "designer",
                status: "active",
                quotaRemaining: 300,
                quotaLimit: 500,
            },
            createdAt: "2026-07-08T00:07:00.000Z",
        });
        expect(created.ok).toBe(true);
        state = created.state;

        const login = authenticateUserAccount(state, "designer-new", "new-pass", "designer");
        expect(login.ok).toBe(true);
        expect(login.account?.name).toBe("新设计师");
        expect(authenticateUserAccount(state, "designer-new", "bad-pass", "designer").ok).toBe(false);
        expect(authenticateUserAccount(state, "designer-new", "new-pass", "admin").ok).toBe(false);

        const disabled = upsertDesignerAccount(state, {
            operatorId: "admin-1",
            account: {
                id: login.account!.id,
                loginName: "designer-new",
                name: "新设计师",
                role: "designer",
                status: "disabled",
                quotaRemaining: 300,
                quotaLimit: 500,
            },
            createdAt: "2026-07-08T00:08:00.000Z",
        });
        expect(disabled.ok).toBe(true);
        expect(authenticateUserAccount(disabled.state, "designer-new", "new-pass", "designer").ok).toBe(false);
    });

    test("prevents non-admins from opening or editing accounts", () => {
        const state = createDefaultAdminState("2026-07-08T00:00:00.000Z");
        const result = upsertDesignerAccount(state, {
            operatorId: "designer-1",
            account: {
                loginName: "illegal",
                password: "pass",
                name: "非法账号",
                role: "designer",
                status: "active",
                quotaRemaining: 100,
                quotaLimit: 100,
            },
            createdAt: "2026-07-08T00:09:00.000Z",
        });

        expect(result.ok).toBe(false);
        expect(result.state.designers.some((designer) => designer.loginName === "illegal")).toBe(false);
    });

    test("public provider models expose no secret metadata", () => {
        const state = createDefaultAdminState("2026-07-08T00:00:00.000Z");
        const publicProviders = getPublicProviderModels(state);

        expect(publicProviders.length).toBeGreaterThan(0);
        expect(publicProviders[0]).not.toHaveProperty("secretStatus");
        expect(JSON.stringify(publicProviders)).not.toContain("keyPreview");
        expect(JSON.stringify(publicProviders)).not.toContain("API_PROVIDER");
    });

    test("provider secrets are stored as status only and never plaintext", () => {
        const state = createDefaultAdminState("2026-07-08T00:00:00.000Z");
        const result = saveAdminApiProviderSecret(state, {
            operatorId: "admin-1",
            providerId: "openai-compatible",
            secretName: "api_key",
            value: "sk-live-secret-value",
            createdAt: "2026-07-08T00:04:00.000Z",
        });

        expect(result.ok).toBe(true);
        const provider = result.state.apiProviders.find((item) => item.id === "openai-compatible");
        expect(provider?.secretStatus.hasKey).toBe(true);
        expect(provider?.secretStatus.keyPreview).toBe("******alue");
        expect(JSON.stringify(result.state)).not.toContain("sk-live-secret-value");
    });

    test("prevents non-admins from changing providers and provider secrets", () => {
        const state = createDefaultAdminState("2026-07-08T00:00:00.000Z");
        const provider = state.apiProviders[0]!;

        expect(upsertAdminApiProvider(state, { operatorId: "designer-1", provider: { ...provider, name: "Changed" }, createdAt: "2026-07-08T00:05:00.000Z" }).ok).toBe(false);
        expect(saveAdminApiProviderSecret(state, { operatorId: "designer-1", providerId: provider.id, secretName: "api_key", value: "secret", createdAt: "2026-07-08T00:05:00.000Z" }).ok).toBe(false);
    });

    test("ships provider workflow templates without exposing provider secrets", () => {
        const state = createDefaultAdminState("2026-07-08T00:00:00.000Z");

        expect(state.workflowTemplates.map((item) => item.providerProtocol)).toEqual(["runninghub", "custom", "custom"]);
        expect(state.workflowTemplates.map((item) => item.capability)).toEqual(["upscale", "edit", "batch"]);
        expect(JSON.stringify(state.workflowTemplates)).not.toContain("keyPreview");
        expect(JSON.stringify(state.workflowTemplates)).not.toContain("secretStatus");
    });

    test("admins can create update and delete workflow configs", () => {
        let state = createDefaultAdminState("2026-07-08T00:00:00.000Z");
        const workflow = createAdminWorkflow({
            templateId: "runninghub-upscale",
            name: "高清放大",
            providerId: "runninghub",
            providerProtocol: "runninghub",
            capability: "upscale",
            modelId: "runninghub-workflow",
            creditCost: 12,
            rmbCost: 1.2,
            entryCount: 2,
            createdAt: "2026-07-08T00:01:00.000Z",
        });

        const created = upsertAdminWorkflow(state, { operatorId: "admin-1", workflow, createdAt: "2026-07-08T00:02:00.000Z" });
        expect(created.ok).toBe(true);
        state = created.state;
        expect(state.workflows).toHaveLength(1);
        expect(state.workflows[0]?.enabled).toBe(true);

        const blocked = upsertAdminWorkflow(state, { operatorId: "designer-1", workflow: { ...workflow, name: "非法修改" }, createdAt: "2026-07-08T00:03:00.000Z" });
        expect(blocked.ok).toBe(false);
        expect(blocked.state.workflows[0]?.name).toBe("高清放大");

        const removed = deleteAdminWorkflow(state, { operatorId: "admin-1", workflowId: workflow.id, createdAt: "2026-07-08T00:04:00.000Z" });
        expect(removed.ok).toBe(true);
        expect(removed.state.workflows).toHaveLength(0);
    });

    test("tool modes create admin batch and history records with operation-specific metadata", () => {
        const state = createDefaultAdminState("2026-07-08T00:00:00.000Z");
        const batch = createBatchTaskFromToolMode(state, {
            toolMode: "detail-enhance",
            requestId: "detail-1",
            designerId: "designer-1",
            projectId: "tool-detail-enhance",
            modelId: "gpt-image-2",
            sourceUrls: ["source-a.png", "source-b.png"],
            resultUrls: ["result-a.png"],
            failures: [{ sourceUrl: "source-b.png", reason: "provider timeout" }],
            createdAt: "2026-07-08T00:05:00.000Z",
        });

        expect(batch.operationType).toBe("upscale");
        expect(batch.items.map((item) => item.status)).toEqual(["success", "failed"]);
        expect(batch.items[1]?.failureReason).toBe("provider timeout");

        const history = createHistoryRecordFromToolMode(state, {
            toolMode: "angle-control",
            requestId: "angle-1",
            designerId: "designer-1",
            projectId: "tool-angle-control",
            modelId: "gpt-image-2",
            prompt: "front view product render",
            sourceUrls: ["source.png"],
            resultUrls: ["result.png"],
            createdAt: "2026-07-08T00:06:00.000Z",
        });

        expect(history.operationType).toBe("inpaint");
        expect(history.projectId).toBe("tool-angle-control");
        expect(history.originalUrls).toEqual(["source.png"]);
        expect(history.resultUrls).toEqual(["result.png"]);
    });
});
