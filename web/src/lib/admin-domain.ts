export type AdminRole = "designer" | "admin";
export type DesignerStatus = "active" | "disabled";
export type AdminOperationType = "image_generation" | "video_generation" | "audio_generation" | "upscale" | "remove_background" | "inpaint" | "batch_image" | "seamless_stitch";
export type AdminModelCapability = "generate" | "edit" | "upscale" | "remove_background" | "batch" | "chat" | "video" | "audio";
export type BatchItemStatus = "waiting" | "processing" | "success" | "failed" | "paused" | "cancelled";
export type AdminProviderProtocol = "openai" | "gemini" | "volcengine" | "runninghub" | "codex" | "custom";
export type AdminProviderModelType = "image" | "chat" | "video";
export type AdminWorkflowProviderProtocol = Extract<AdminProviderProtocol, "runninghub" | "custom">;
export type AdminWorkflowCapability = Extract<AdminModelCapability, "generate" | "edit" | "upscale" | "batch">;
export type AdminToolMode = "image-generation" | "detail-enhance" | "image-edit" | "angle-control" | "batch-image-edit" | "seamless-stitch" | "gpt-chat";

export type DesignerAccount = {
    id: string;
    loginName: string;
    password: string;
    name: string;
    role: AdminRole;
    quotaRemaining: number;
    quotaUsed: number;
    quotaLimit: number;
    status: DesignerStatus;
    createdAt: string;
    updatedAt: string;
};

export type DesignerAccountInput = {
    id?: string;
    loginName: string;
    password?: string;
    name: string;
    role: AdminRole;
    quotaRemaining: number;
    quotaUsed?: number;
    quotaLimit: number;
    status: DesignerStatus;
};

export type PricingRule = {
    operationType: AdminOperationType;
    label: string;
    credits: number;
    rmbCost: number;
};

export type AdminModelConfig = {
    id: string;
    name: string;
    modelId: string;
    provider: string;
    capabilities: AdminModelCapability[];
    credits: number;
    rmbCost: number;
    enabled: boolean;
};

export type AdminApiProviderSecretStatus = {
    hasKey: boolean;
    keyPreview: string;
    keyEnv: string;
    hasWalletKey?: boolean;
    walletKeyPreview?: string;
    walletKeyEnv?: string;
    hasVolcengineAccessKey?: boolean;
    volcengineAccessKeyPreview?: string;
    volcengineAccessKeyEnv?: string;
    hasVolcengineSecretKey?: boolean;
    volcengineSecretKeyPreview?: string;
    volcengineSecretKeyEnv?: string;
};

export type AdminApiProviderModel = {
    id: string;
    modelId: string;
    displayName: string;
    modelType: AdminProviderModelType;
    capabilities: AdminModelCapability[];
    protocolOverride?: AdminProviderProtocol;
    enabled: boolean;
    sortOrder: number;
    creditCost: number;
    rmbCost: number;
    priceRuleId?: string;
};

export type AdminApiProvider = {
    id: string;
    name: string;
    baseUrl: string;
    protocol: AdminProviderProtocol;
    imageRequestMode: "openai" | "openai-json" | "openai-video-proxy" | "openai-responses";
    imageGenerationEndpoint: string;
    imageEditEndpoint: string;
    enabled: boolean;
    primary: boolean;
    volcengineProjectName: string;
    volcengineRegion: string;
    models: AdminApiProviderModel[];
    loras: Array<{ id: string; name: string; targetModel: string; strength: number; enabled: boolean; note: string }>;
    runningHubEntries: Array<{ id: string; kind: "app" | "workflow"; title: string; enabled: boolean; hidden: boolean; note: string }>;
    secretStatus: AdminApiProviderSecretStatus;
    createdAt: string;
    updatedAt: string;
};

export type AdminWorkflowTemplate = {
    id: string;
    name: string;
    providerProtocol: AdminWorkflowProviderProtocol;
    providerId: string;
    capability: AdminWorkflowCapability;
    modelId: string;
    creditCost: number;
    rmbCost: number;
    entryCount: number;
    description: string;
};

export type AdminWorkflowConfig = AdminWorkflowTemplate & {
    templateId: string;
    enabled: boolean;
    createdAt: string;
    updatedAt: string;
};

export type UsageLedgerEntry = {
    id: string;
    requestId: string;
    designerId: string;
    operationType: AdminOperationType;
    modelId: string;
    credits: number;
    rmb: number;
    createdAt: string;
    note: string;
};

export type GenerationHistoryRecord = {
    id: string;
    createdAt: string;
    designerId: string;
    projectId: string;
    operationType: AdminOperationType;
    modelId: string;
    prompt: string;
    originalUrls: string[];
    resultUrls: string[];
    quantity: number;
    credits: number;
    rmb: number;
    status: "success" | "failed";
    failureReason?: string;
};

export type ProjectMaterialRecord = {
    id: string;
    projectId: string;
    designerId: string;
    operationType: AdminOperationType;
    title: string;
    url: string;
    createdAt: string;
};

export type BatchTaskItemRecord = {
    id: string;
    status: BatchItemStatus;
    sourceUrl?: string;
    resultUrl?: string;
    failureReason?: string;
    credits: number;
};

export type BatchTaskRecord = {
    id: string;
    projectId: string;
    designerId: string;
    operationType: AdminOperationType;
    modelId: string;
    createdAt: string;
    status: BatchItemStatus;
    items: BatchTaskItemRecord[];
};

export type AuditLogEntry = {
    id: string;
    createdAt: string;
    operatorId: string;
    targetId: string;
    action: string;
    detail: string;
    result: "success" | "failed";
};

export type AdminSession = {
    userId: string;
    loggedInAt: string;
};

export type AdminState = {
    currentOperatorId: string;
    adminSession: AdminSession | null;
    activeDesignerId: string;
    designers: DesignerAccount[];
    pricingRules: PricingRule[];
    apiProviders: AdminApiProvider[];
    workflowTemplates: AdminWorkflowTemplate[];
    workflows: AdminWorkflowConfig[];
    models: AdminModelConfig[];
    ledger: UsageLedgerEntry[];
    history: GenerationHistoryRecord[];
    materials: ProjectMaterialRecord[];
    batchTasks: BatchTaskRecord[];
    auditLogs: AuditLogEntry[];
};

export type EstimateRequest = {
    operationType: AdminOperationType;
    modelId: string;
    quantity?: number;
};

export type UsageChargeRequest = EstimateRequest & {
    requestId: string;
    designerId: string;
    projectId: string;
    prompt: string;
    originalUrls?: string[];
    resultUrls: string[];
    createdAt: string;
    failureReason?: string;
};

export function createDefaultAdminState(now = new Date().toISOString()): AdminState {
    return {
        currentOperatorId: "admin-1",
        adminSession: null,
        activeDesignerId: "designer-1",
        designers: [
            createDesigner("admin-1", "admin-1", "123456", "管理员", "admin", 1000, 0, 1000, now),
            createDesigner("designer-1", "designer-1", "123456", "设计师 A", "designer", 500, 0, 500, now),
            createDesigner("designer-2", "designer-2", "123456", "设计师 B", "designer", 240, 60, 300, now),
        ],
        pricingRules: [
            { operationType: "image_generation", label: "生成一张图", credits: 8, rmbCost: 0.8 },
            { operationType: "audio_generation", label: "生成音频", credits: 10, rmbCost: 0.5 },
            { operationType: "upscale", label: "放大图片", credits: 5, rmbCost: 0.5 },
            { operationType: "remove_background", label: "去背景", credits: 3, rmbCost: 0.3 },
            { operationType: "inpaint", label: "局部编辑", credits: 6, rmbCost: 0.6 },
            { operationType: "batch_image", label: "批量处理每张图", credits: 7, rmbCost: 0.7 },
            { operationType: "seamless_stitch", label: "无缝拼接", credits: 2, rmbCost: 0 },
        ],
        apiProviders: createDefaultApiProviders(now),
        workflowTemplates: createDefaultWorkflowTemplates(),
        workflows: [],
        models: [
            { id: "gpt-image-2", name: "GPT Image 2", modelId: "gpt-image-2", provider: "OpenAI", capabilities: ["generate", "edit"], credits: 4, rmbCost: 0.4, enabled: true },
            { id: "nano-banana", name: "Nano Banana", modelId: "nano-banana", provider: "第三方", capabilities: ["generate", "edit", "batch"], credits: 3, rmbCost: 0.3, enabled: true },
            { id: "recraft", name: "Recraft", modelId: "recraft-v3", provider: "Recraft", capabilities: ["generate", "remove_background"], credits: 2, rmbCost: 0.2, enabled: false },
            { id: "internal-seamless", name: "内部无缝拼接", modelId: "internal-seamless", provider: "内部 AI", capabilities: ["edit"], credits: 0, rmbCost: 0, enabled: true },
        ],
        ledger: [],
        history: [],
        materials: [],
        batchTasks: [],
        auditLogs: [],
    };
}

export function getPublicProviderModels(state: AdminState) {
    return state.apiProviders
        .filter((provider) => provider.enabled)
        .map((provider) => ({
            id: provider.id,
            name: provider.name,
            enabled: provider.enabled,
            models: provider.models
                .filter((model) => model.enabled)
                .sort((a, b) => a.sortOrder - b.sortOrder)
                .map((model) => ({
                    modelId: model.modelId,
                    displayName: model.displayName,
                    modelType: model.modelType,
                    capabilities: model.capabilities,
                    creditCost: model.creditCost,
                    rmbCost: model.rmbCost,
                    enabled: model.enabled,
                })),
        }));
}

export function createAdminWorkflow(input: Omit<AdminWorkflowConfig, "id" | "enabled" | "updatedAt"> & { id?: string; enabled?: boolean; updatedAt?: string }): AdminWorkflowConfig {
    const id = input.id || normalizeWorkflowId(`${input.providerId}-${input.name}`);
    return {
        id,
        templateId: input.templateId,
        name: input.name.trim() || id,
        providerProtocol: input.providerProtocol,
        providerId: input.providerId,
        capability: input.capability,
        modelId: input.modelId,
        creditCost: Math.max(0, Math.floor(input.creditCost)),
        rmbCost: roundMoney(Math.max(0, input.rmbCost)),
        entryCount: Math.max(0, Math.floor(input.entryCount)),
        description: input.description || "",
        enabled: input.enabled ?? true,
        createdAt: input.createdAt,
        updatedAt: input.updatedAt || input.createdAt,
    };
}

export function upsertAdminWorkflow(state: AdminState, request: { operatorId: string; workflow: AdminWorkflowConfig; createdAt: string }) {
    if (!isAdmin(state, request.operatorId)) return failedAdminAction(state, request.operatorId, request.workflow.id, "配置工作流", "非管理员不能配置工作流", request.createdAt);
    const workflow = createAdminWorkflow({ ...request.workflow, updatedAt: request.createdAt });
    const nextState = {
        ...state,
        workflows: state.workflows.some((item) => item.id === workflow.id) ? state.workflows.map((item) => (item.id === workflow.id ? workflow : item)) : [workflow, ...state.workflows],
    };
    return successfulAdminAction(nextState, request.operatorId, workflow.id, "配置工作流", `${workflow.name}（${workflow.enabled ? "启用" : "停用"}）`, request.createdAt);
}

export function deleteAdminWorkflow(state: AdminState, request: { operatorId: string; workflowId: string; createdAt: string }) {
    if (!isAdmin(state, request.operatorId)) return failedAdminAction(state, request.operatorId, request.workflowId, "删除工作流", "非管理员不能删除工作流", request.createdAt);
    const workflow = state.workflows.find((item) => item.id === request.workflowId);
    if (!workflow) return failedAdminAction(state, request.operatorId, request.workflowId, "删除工作流", "工作流不存在", request.createdAt);
    const nextState = { ...state, workflows: state.workflows.filter((item) => item.id !== request.workflowId) };
    return successfulAdminAction(nextState, request.operatorId, request.workflowId, "删除工作流", workflow.name, request.createdAt);
}

export function createBatchTaskFromToolMode(
    state: AdminState,
    input: {
        toolMode: AdminToolMode;
        requestId: string;
        designerId: string;
        projectId: string;
        modelId: string;
        sourceUrls: string[];
        resultUrls: string[];
        failures?: Array<{ sourceUrl: string; reason: string }>;
        createdAt: string;
    },
): BatchTaskRecord {
    const operationType = toolModeOperation(input.toolMode);
    const credits = estimateAdminCredits(state, { operationType, modelId: input.modelId, quantity: 1 }).credits;
    const failures = new Map((input.failures || []).map((item) => [item.sourceUrl, item.reason]));
    const items = input.sourceUrls.map((sourceUrl, index): BatchTaskItemRecord => {
        const resultUrl = input.resultUrls[index];
        const failureReason = failures.get(sourceUrl);
        return {
            id: `${input.requestId}-item-${index + 1}`,
            status: resultUrl ? "success" : failureReason ? "failed" : "waiting",
            sourceUrl,
            resultUrl,
            failureReason,
            credits: resultUrl ? credits : 0,
        };
    });
    const hasProcessing = items.some((item) => item.status === "waiting" || item.status === "processing");
    const hasSuccess = items.some((item) => item.status === "success");
    return {
        id: `batch-${input.requestId}`,
        projectId: input.projectId,
        designerId: input.designerId,
        operationType,
        modelId: input.modelId,
        createdAt: input.createdAt,
        status: hasProcessing ? "processing" : hasSuccess ? "success" : "failed",
        items,
    };
}

export function createHistoryRecordFromToolMode(
    state: AdminState,
    input: {
        toolMode: AdminToolMode;
        requestId: string;
        designerId: string;
        projectId: string;
        modelId: string;
        prompt: string;
        sourceUrls: string[];
        resultUrls: string[];
        createdAt: string;
        failureReason?: string;
    },
): GenerationHistoryRecord {
    const operationType = toolModeOperation(input.toolMode);
    const estimate = input.failureReason ? { credits: 0, rmb: 0 } : estimateAdminCredits(state, { operationType, modelId: input.modelId, quantity: Math.max(1, input.resultUrls.length) });
    return {
        id: `history-${input.requestId}`,
        createdAt: input.createdAt,
        designerId: input.designerId,
        projectId: input.projectId,
        operationType,
        modelId: input.modelId,
        prompt: input.prompt,
        originalUrls: input.sourceUrls,
        resultUrls: input.resultUrls,
        quantity: Math.max(1, input.resultUrls.length),
        credits: estimate.credits,
        rmb: estimate.rmb,
        status: input.failureReason ? "failed" : "success",
        failureReason: input.failureReason,
    };
}

export function authenticateAdminSession(state: AdminState, userId: string, loggedInAt = new Date().toISOString()): { ok: true; session: AdminSession } | { ok: false; reason: string; session: null } {
    const user = state.designers.find((item) => item.id === userId || item.loginName === userId);
    if (!user || user.status !== "active") return { ok: false, reason: "账号不可用", session: null };
    if (user.role !== "admin") return { ok: false, reason: "只有管理员可以进入后台", session: null };
    return { ok: true, session: { userId: user.id, loggedInAt } };
}

export function authenticateUserAccount(state: AdminState, loginName: string, password: string, role: AdminRole): { ok: true; account: DesignerAccount } | { ok: false; reason: string } {
    const normalizedLogin = normalizeLoginName(loginName);
    const account = state.designers.find((item) => normalizeLoginName(item.loginName || item.id) === normalizedLogin);
    if (!account || account.status !== "active") return { ok: false, reason: "账号不存在或已停用" };
    if (account.role !== role) return { ok: false, reason: role === "admin" ? "只有管理员账号可以进入后台" : "请选择设计师账号登录" };
    if ((account.password || "") !== password) return { ok: false, reason: "账号或密码不正确" };
    return { ok: true, account };
}

export function canAccessAdmin(state: AdminState, session: AdminSession | null | undefined) {
    if (!session) return false;
    return isAdmin(state, session.userId);
}

export function estimateAdminCredits(state: AdminState, request: EstimateRequest) {
    const quantity = normalizeQuantity(request.quantity);
    const rule = state.pricingRules.find((item) => item.operationType === request.operationType);
    const model = state.models.find((item) => item.id === request.modelId || item.modelId === request.modelId);
    const operationCredits = Math.max(0, rule?.credits || 0);
    const modelCredits = model?.enabled ? Math.max(0, model.credits) : 0;
    const unitCredits = operationCredits + modelCredits;
    const operationRmb = Math.max(0, rule?.rmbCost || 0);
    const modelRmb = model?.enabled ? Math.max(0, model.rmbCost) : 0;

    return {
        credits: unitCredits * quantity,
        rmb: roundMoney((operationRmb + modelRmb) * quantity),
        breakdown: {
            operationCredits,
            modelCredits,
            quantity,
            unitCredits,
        },
    };
}

export function applyUsageCharge(state: AdminState, request: UsageChargeRequest): { ok: true; state: AdminState; duplicate?: boolean; credits: number; rmb: number } | { ok: false; state: AdminState; reason: string } {
    const existing = state.ledger.find((item) => item.requestId === request.requestId);
    if (existing) return { ok: true, state, duplicate: true, credits: existing.credits, rmb: existing.rmb };

    const designer = state.designers.find((item) => item.id === request.designerId);
    if (!designer || designer.status !== "active") return { ok: false, state, reason: "账号不可用" };

    const model = state.models.find((item) => item.id === request.modelId || item.modelId === request.modelId);
    if (!model?.enabled) return { ok: false, state, reason: "模型未启用" };

    if (request.failureReason) {
        return {
            ok: true,
            state: {
                ...state,
                history: [buildHistoryRecord(state, request, 0, 0, "failed"), ...state.history],
            },
            credits: 0,
            rmb: 0,
        };
    }

    const estimate = estimateAdminCredits(state, request);
    if (designer.quotaRemaining < estimate.credits) return { ok: false, state, reason: "额度不足" };

    const nextDesigner = {
        ...designer,
        quotaRemaining: designer.quotaRemaining - estimate.credits,
        quotaUsed: designer.quotaUsed + estimate.credits,
        updatedAt: request.createdAt,
    };
    const ledgerEntry: UsageLedgerEntry = {
        id: `ledger-${request.requestId}`,
        requestId: request.requestId,
        designerId: designer.id,
        operationType: request.operationType,
        modelId: model.id,
        credits: estimate.credits,
        rmb: estimate.rmb,
        createdAt: request.createdAt,
        note: `${request.operationType} x ${normalizeQuantity(request.quantity)}`,
    };
    const materialRecords = request.resultUrls.map((url, index) => ({
        id: `material-${request.requestId}-${index + 1}`,
        projectId: request.projectId,
        designerId: designer.id,
        operationType: request.operationType,
        title: `生成结果 ${index + 1}`,
        url,
        createdAt: request.createdAt,
    }));

    return {
        ok: true,
        state: {
            ...state,
            designers: state.designers.map((item) => (item.id === designer.id ? nextDesigner : item)),
            ledger: [ledgerEntry, ...state.ledger],
            history: [buildHistoryRecord(state, request, estimate.credits, estimate.rmb, "success"), ...state.history],
            materials: [...materialRecords, ...state.materials],
        },
        credits: estimate.credits,
        rmb: estimate.rmb,
    };
}

export function applyDesignerCreditChange(state: AdminState, request: { operatorId: string; designerId: string; amount: number; reason: string; createdAt: string }) {
    if (!isAdmin(state, request.operatorId)) return failedAdminAction(state, request.operatorId, request.designerId, "调整额度", "非管理员不能修改额度", request.createdAt);
    const designer = state.designers.find((item) => item.id === request.designerId);
    if (!designer) return failedAdminAction(state, request.operatorId, request.designerId, "调整额度", "账号不存在", request.createdAt);

    const nextRemaining = clamp(designer.quotaRemaining + request.amount, 0, designer.quotaLimit);
    const nextState = {
        ...state,
        designers: state.designers.map((item) => (item.id === designer.id ? { ...item, quotaRemaining: nextRemaining, updatedAt: request.createdAt } : item)),
    };
    return successfulAdminAction(nextState, request.operatorId, request.designerId, "调整额度", `${request.reason}：${request.amount > 0 ? "增加" : "扣减"} ${Math.abs(request.amount)} 积分`, request.createdAt);
}

export function setDesignerQuotaLimit(state: AdminState, request: { operatorId: string; designerId: string; quotaLimit: number; createdAt: string }) {
    if (!isAdmin(state, request.operatorId)) return failedAdminAction(state, request.operatorId, request.designerId, "设置额度上限", "非管理员不能设置额度上限", request.createdAt);
    const designer = state.designers.find((item) => item.id === request.designerId);
    if (!designer) return failedAdminAction(state, request.operatorId, request.designerId, "设置额度上限", "账号不存在", request.createdAt);
    const quotaLimit = Math.max(0, Math.floor(request.quotaLimit));
    const nextState = {
        ...state,
        designers: state.designers.map((item) => (item.id === designer.id ? { ...item, quotaLimit, quotaRemaining: Math.min(item.quotaRemaining, quotaLimit), updatedAt: request.createdAt } : item)),
    };
    return successfulAdminAction(nextState, request.operatorId, request.designerId, "设置额度上限", `额度上限设为 ${quotaLimit}`, request.createdAt);
}

export function upsertDesignerAccount(state: AdminState, request: { operatorId: string; account: DesignerAccountInput; createdAt: string }) {
    if (!isAdmin(state, request.operatorId)) return failedAdminAction(state, request.operatorId, request.account.id || request.account.loginName, "开通账号", "非管理员不能开通或修改账号", request.createdAt);
    const loginName = normalizeLoginName(request.account.loginName);
    if (!loginName) return failedAdminAction(state, request.operatorId, request.account.id || "", "开通账号", "登录账号必填", request.createdAt);
    const existing = request.account.id ? state.designers.find((item) => item.id === request.account.id) : state.designers.find((item) => normalizeLoginName(item.loginName || item.id) === loginName);
    const duplicate = state.designers.find((item) => item.id !== existing?.id && normalizeLoginName(item.loginName || item.id) === loginName);
    if (duplicate) return failedAdminAction(state, request.operatorId, duplicate.id, "开通账号", "登录账号已存在", request.createdAt);
    if (!existing && !request.account.password?.trim()) return failedAdminAction(state, request.operatorId, loginName, "开通账号", "新账号必须设置初始密码", request.createdAt);

    const quotaLimit = Math.max(0, Math.floor(request.account.quotaLimit));
    const quotaUsed = Math.max(0, Math.floor(request.account.quotaUsed ?? existing?.quotaUsed ?? 0));
    const quotaRemaining = clamp(Math.floor(request.account.quotaRemaining), 0, quotaLimit);
    const account: DesignerAccount = {
        id: existing?.id || request.account.id?.trim() || loginName,
        loginName,
        password: request.account.password?.trim() || existing?.password || "",
        name: request.account.name.trim() || loginName,
        role: request.account.role,
        quotaRemaining,
        quotaUsed,
        quotaLimit,
        status: request.account.status,
        createdAt: existing?.createdAt || request.createdAt,
        updatedAt: request.createdAt,
    };
    const nextState = {
        ...state,
        designers: existing ? state.designers.map((item) => (item.id === existing.id ? account : item)) : [account, ...state.designers],
        activeDesignerId: state.designers.some((item) => item.id === state.activeDesignerId) ? state.activeDesignerId : account.role === "designer" ? account.id : state.activeDesignerId,
    };
    return successfulAdminAction(nextState, request.operatorId, account.id, existing ? "修改账号" : "开通账号", `${account.name}（${account.role === "admin" ? "管理员" : "设计师"}，${account.status === "active" ? "启用" : "停用"}）`, request.createdAt);
}

export function upsertPricingRule(state: AdminState, request: { operatorId: string; rule: PricingRule; createdAt: string }) {
    if (!isAdmin(state, request.operatorId)) return failedAdminAction(state, request.operatorId, request.rule.operationType, "修改价格规则", "非管理员不能修改价格", request.createdAt);
    const rule = { ...request.rule, credits: Math.max(0, Math.floor(request.rule.credits)), rmbCost: roundMoney(Math.max(0, request.rule.rmbCost)) };
    const nextState = {
        ...state,
        pricingRules: state.pricingRules.some((item) => item.operationType === rule.operationType) ? state.pricingRules.map((item) => (item.operationType === rule.operationType ? rule : item)) : [rule, ...state.pricingRules],
    };
    return successfulAdminAction(nextState, request.operatorId, rule.operationType, "修改价格规则", `${rule.label}：${rule.credits} 积分 / ${rule.rmbCost} 元`, request.createdAt);
}

export function upsertAdminModel(state: AdminState, request: { operatorId: string; model: AdminModelConfig; createdAt: string }) {
    if (!isAdmin(state, request.operatorId)) return failedAdminAction(state, request.operatorId, request.model.id, "配置模型", "非管理员不能配置模型", request.createdAt);
    const model = {
        ...request.model,
        credits: Math.max(0, Math.floor(request.model.credits)),
        rmbCost: roundMoney(Math.max(0, request.model.rmbCost)),
    };
    const nextState = {
        ...state,
        models: state.models.some((item) => item.id === model.id) ? state.models.map((item) => (item.id === model.id ? model : item)) : [model, ...state.models],
    };
    return successfulAdminAction(nextState, request.operatorId, model.id, "配置模型", `${model.name}（${model.enabled ? "启用" : "停用"}）`, request.createdAt);
}

export function upsertAdminApiProvider(state: AdminState, request: { operatorId: string; provider: AdminApiProvider; createdAt: string }) {
    if (!isAdmin(state, request.operatorId)) return failedAdminAction(state, request.operatorId, request.provider.id, "配置 Provider", "非管理员不能配置 Provider", request.createdAt);
    const provider = normalizeApiProvider(request.provider, request.createdAt);
    const nextProviders = state.apiProviders.some((item) => item.id === provider.id)
        ? state.apiProviders.map((item) => (item.id === provider.id ? provider : provider.primary ? { ...item, primary: false } : item))
        : [provider, ...state.apiProviders.map((item) => (provider.primary ? { ...item, primary: false } : item))];
    const nextState = { ...state, apiProviders: nextProviders };
    return successfulAdminAction(nextState, request.operatorId, provider.id, "配置 Provider", `${provider.name}，${provider.enabled ? "启用" : "停用"}`, request.createdAt);
}

export function saveAdminApiProviderSecret(state: AdminState, request: { operatorId: string; providerId: string; secretName: "api_key" | "wallet_api_key" | "volcengine_access_key_id" | "volcengine_secret_access_key"; value: string; createdAt: string }) {
    if (!isAdmin(state, request.operatorId)) return failedAdminAction(state, request.operatorId, request.providerId, "更新 Provider 密钥", "非管理员不能更新 Provider 密钥", request.createdAt);
    const provider = state.apiProviders.find((item) => item.id === request.providerId);
    if (!provider) return failedAdminAction(state, request.operatorId, request.providerId, "更新 Provider 密钥", "Provider 不存在", request.createdAt);
    if (!request.value.trim()) return failedAdminAction(state, request.operatorId, request.providerId, "更新 Provider 密钥", "密钥不能为空", request.createdAt);

    const nextState = {
        ...state,
        apiProviders: state.apiProviders.map((item) => (item.id === request.providerId ? { ...item, secretStatus: applySecretStatus(item, request.secretName, request.value), updatedAt: request.createdAt } : item)),
    };
    return successfulAdminAction(nextState, request.operatorId, request.providerId, "更新 Provider 密钥", `${provider.name} ${secretLabel(request.secretName)} 已保存为脱敏状态`, request.createdAt);
}

export function clearAdminApiProviderSecret(state: AdminState, request: { operatorId: string; providerId: string; secretName: "api_key" | "wallet_api_key" | "volcengine_access_key_id" | "volcengine_secret_access_key"; createdAt: string }) {
    if (!isAdmin(state, request.operatorId)) return failedAdminAction(state, request.operatorId, request.providerId, "清除 Provider 密钥", "非管理员不能清除 Provider 密钥", request.createdAt);
    const provider = state.apiProviders.find((item) => item.id === request.providerId);
    if (!provider) return failedAdminAction(state, request.operatorId, request.providerId, "清除 Provider 密钥", "Provider 不存在", request.createdAt);
    const nextState = {
        ...state,
        apiProviders: state.apiProviders.map((item) => (item.id === request.providerId ? { ...item, secretStatus: clearSecretStatus(item, request.secretName), updatedAt: request.createdAt } : item)),
    };
    return successfulAdminAction(nextState, request.operatorId, request.providerId, "清除 Provider 密钥", `${provider.name} ${secretLabel(request.secretName)} 已清除`, request.createdAt);
}

export function createAuditLog(input: Omit<AuditLogEntry, "id">): AuditLogEntry {
    return {
        id: `audit-${input.createdAt}-${input.operatorId}-${input.action}-${input.targetId}`,
        ...input,
    };
}

function createDesigner(id: string, loginName: string, password: string, name: string, role: AdminRole, quotaRemaining: number, quotaUsed: number, quotaLimit: number, now: string): DesignerAccount {
    return { id, loginName, password, name, role, quotaRemaining, quotaUsed, quotaLimit, status: "active", createdAt: now, updatedAt: now };
}

function createDefaultApiProviders(now: string): AdminApiProvider[] {
    return [
        normalizeApiProvider(
            {
                id: "openai-compatible",
                name: "OpenAI 兼容接口",
                baseUrl: "https://api.openai.com/v1",
                protocol: "openai",
                imageRequestMode: "openai",
                imageGenerationEndpoint: "",
                imageEditEndpoint: "",
                enabled: true,
                primary: true,
                volcengineProjectName: "",
                volcengineRegion: "",
                models: [createProviderModel("gpt-image-2", "GPT Image 2", "image", ["generate", "edit"], 10, 0.12, 10), createProviderModel("gpt-5.5", "GPT 5.5", "chat", ["generate"], 2, 0.02, 20)],
                loras: [],
                runningHubEntries: [],
                secretStatus: createSecretStatus("openai-compatible"),
                createdAt: now,
                updatedAt: now,
            },
            now,
        ),
        normalizeApiProvider(
            {
                id: "runninghub",
                name: "RunningHub",
                baseUrl: "",
                protocol: "runninghub",
                imageRequestMode: "openai",
                imageGenerationEndpoint: "",
                imageEditEndpoint: "",
                enabled: false,
                primary: false,
                volcengineProjectName: "",
                volcengineRegion: "",
                models: [createProviderModel("runninghub-workflow", "RunningHub Workflow", "image", ["generate", "edit", "batch"], 8, 0.08, 30)],
                loras: [],
                runningHubEntries: [],
                secretStatus: createSecretStatus("runninghub"),
                createdAt: now,
                updatedAt: now,
            },
            now,
        ),
        normalizeApiProvider(
            {
                id: "internal-ai",
                name: "内部 AI",
                baseUrl: "",
                protocol: "custom",
                imageRequestMode: "openai-json",
                imageGenerationEndpoint: "",
                imageEditEndpoint: "/std/tohwkdpj",
                enabled: true,
                primary: false,
                volcengineProjectName: "",
                volcengineRegion: "",
                models: [createProviderModel("internal-seamless", "内部无缝拼接", "image", ["edit"], 2, 0, 35)],
                loras: [],
                runningHubEntries: [],
                secretStatus: createSecretStatus("internal-ai"),
                createdAt: now,
                updatedAt: now,
            },
            now,
        ),
        normalizeApiProvider(
            {
                id: "volcengine",
                name: "火山引擎",
                baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
                protocol: "volcengine",
                imageRequestMode: "openai",
                imageGenerationEndpoint: "",
                imageEditEndpoint: "",
                enabled: false,
                primary: false,
                volcengineProjectName: "default",
                volcengineRegion: "cn-beijing",
                models: [createProviderModel("doubao-seedance-2.0", "豆包 Seedance", "video", ["generate"], 12, 0.18, 40)],
                loras: [],
                runningHubEntries: [],
                secretStatus: createSecretStatus("volcengine"),
                createdAt: now,
                updatedAt: now,
            },
            now,
        ),
    ];
}

function createDefaultWorkflowTemplates(): AdminWorkflowTemplate[] {
    return [
        {
            id: "runninghub-upscale",
            name: "RunningHub 高清放大",
            providerProtocol: "runninghub",
            providerId: "runninghub",
            capability: "upscale",
            modelId: "runninghub-workflow",
            creditCost: 12,
            rmbCost: 1.2,
            entryCount: 4,
            description: "承接参考项目里的 RunningHub 工作流能力，用于放大、修复和增强图片。",
        },
        {
            id: "comfyui-edit",
            name: "ComfyUI 局部编辑",
            providerProtocol: "custom",
            providerId: "comfyui-local",
            capability: "edit",
            modelId: "comfyui-workflow",
            creditCost: 8,
            rmbCost: 0.8,
            entryCount: 3,
            description: "统一管理本地或局域网 ComfyUI 工作流，不暴露执行密钥到前端。",
        },
        {
            id: "local-batch",
            name: "本地批量处理",
            providerProtocol: "custom",
            providerId: "local-workflow",
            capability: "batch",
            modelId: "local-batch-workflow",
            creditCost: 6,
            rmbCost: 0.4,
            entryCount: 2,
            description: "用于批量任务编排，每张图片独立状态、独立失败原因。",
        },
    ];
}

function createProviderModel(modelId: string, displayName: string, modelType: AdminProviderModelType, capabilities: AdminModelCapability[], creditCost: number, rmbCost: number, sortOrder: number): AdminApiProviderModel {
    return { id: modelId, modelId, displayName, modelType, capabilities, enabled: true, sortOrder, creditCost, rmbCost };
}

function normalizeApiProvider(provider: AdminApiProvider, now: string): AdminApiProvider {
    const id = normalizeProviderId(provider.id);
    const protocol = normalizeProviderProtocol(id, provider.protocol);
    return {
        ...provider,
        id,
        name: provider.name.trim() || id,
        baseUrl: shouldHideProviderBaseUrl(protocol) ? "" : provider.baseUrl.trim(),
        protocol,
        imageRequestMode: provider.imageRequestMode || "openai",
        models: provider.models.map((model, index) => ({
            ...model,
            id: model.id || `${id}-${model.modelId}`,
            modelId: model.modelId.trim(),
            displayName: model.displayName.trim() || model.modelId.trim(),
            capabilities: model.capabilities || [],
            sortOrder: Number.isFinite(model.sortOrder) ? model.sortOrder : index + 1,
            creditCost: Math.max(0, Math.floor(model.creditCost || 0)),
            rmbCost: roundMoney(Math.max(0, model.rmbCost || 0)),
            enabled: Boolean(model.enabled),
        })),
        secretStatus: provider.secretStatus || createSecretStatus(id),
        createdAt: provider.createdAt || now,
        updatedAt: now,
    };
}

function normalizeProviderId(value: string) {
    return (
        value
            .trim()
            .toLowerCase()
            .replace(/[^a-z0-9_-]+/g, "-")
            .replace(/^-+|-+$/g, "") || "custom-provider"
    );
}

function normalizeWorkflowId(value: string) {
    return (
        value
            .trim()
            .toLowerCase()
            .replace(/[^a-z0-9_-]+/g, "-")
            .replace(/^-+|-+$/g, "") || "workflow"
    );
}

export function toolModeOperation(mode: AdminToolMode): AdminOperationType {
    if (mode === "batch-image-edit") return "batch_image";
    if (mode === "seamless-stitch") return "seamless_stitch";
    if (mode === "detail-enhance") return "upscale";
    if (mode === "image-edit" || mode === "angle-control") return "inpaint";
    if (mode === "gpt-chat") return "image_generation";
    return "image_generation";
}

function normalizeProviderProtocol(id: string, protocol: AdminProviderProtocol): AdminProviderProtocol {
    if (id === "runninghub") return "runninghub";
    if (id === "volcengine") return "volcengine";
    return protocol || "openai";
}

function shouldHideProviderBaseUrl(protocol: AdminProviderProtocol) {
    return protocol === "codex";
}

function createSecretStatus(providerId: string): AdminApiProviderSecretStatus {
    return {
        hasKey: false,
        keyPreview: "",
        keyEnv: providerEnvName(providerId),
        walletKeyEnv: "RUNNINGHUB_WALLET_API_KEY",
        volcengineAccessKeyEnv: "VOLCENGINE_ACCESS_KEY_ID",
        volcengineSecretKeyEnv: "VOLCENGINE_SECRET_ACCESS_KEY",
    };
}

function providerEnvName(providerId: string) {
    if (providerId === "runninghub") return "RUNNINGHUB_API_KEY";
    if (providerId === "volcengine") return "ARK_API_KEY";
    if (providerId === "internal-ai") return "INTERNAL_AI_APP_KEY";
    return `API_PROVIDER_${providerId.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_KEY`;
}

function applySecretStatus(provider: AdminApiProvider, secretName: "api_key" | "wallet_api_key" | "volcengine_access_key_id" | "volcengine_secret_access_key", value: string): AdminApiProviderSecretStatus {
    const preview = maskSecretPreview(value);
    if (secretName === "wallet_api_key") return { ...provider.secretStatus, hasWalletKey: true, walletKeyPreview: preview, walletKeyEnv: "RUNNINGHUB_WALLET_API_KEY" };
    if (secretName === "volcengine_access_key_id") return { ...provider.secretStatus, hasVolcengineAccessKey: true, volcengineAccessKeyPreview: preview, volcengineAccessKeyEnv: "VOLCENGINE_ACCESS_KEY_ID" };
    if (secretName === "volcengine_secret_access_key") return { ...provider.secretStatus, hasVolcengineSecretKey: true, volcengineSecretKeyPreview: preview, volcengineSecretKeyEnv: "VOLCENGINE_SECRET_ACCESS_KEY" };
    return { ...provider.secretStatus, hasKey: true, keyPreview: preview, keyEnv: providerEnvName(provider.id) };
}

function clearSecretStatus(provider: AdminApiProvider, secretName: "api_key" | "wallet_api_key" | "volcengine_access_key_id" | "volcengine_secret_access_key"): AdminApiProviderSecretStatus {
    if (secretName === "wallet_api_key") return { ...provider.secretStatus, hasWalletKey: false, walletKeyPreview: "" };
    if (secretName === "volcengine_access_key_id") return { ...provider.secretStatus, hasVolcengineAccessKey: false, volcengineAccessKeyPreview: "" };
    if (secretName === "volcengine_secret_access_key") return { ...provider.secretStatus, hasVolcengineSecretKey: false, volcengineSecretKeyPreview: "" };
    return { ...provider.secretStatus, hasKey: false, keyPreview: "" };
}

function maskSecretPreview(value: string) {
    const normalized = value.trim();
    if (!normalized) return "";
    return `******${normalized.slice(-4)}`;
}

function secretLabel(secretName: string) {
    if (secretName === "wallet_api_key") return "钱包 Key";
    if (secretName === "volcengine_access_key_id") return "火山 AK";
    if (secretName === "volcengine_secret_access_key") return "火山 SK";
    return "API Key";
}

function buildHistoryRecord(state: AdminState, request: UsageChargeRequest, credits: number, rmb: number, status: GenerationHistoryRecord["status"]): GenerationHistoryRecord {
    const model = state.models.find((item) => item.id === request.modelId || item.modelId === request.modelId);
    return {
        id: `history-${request.requestId}`,
        createdAt: request.createdAt,
        designerId: request.designerId,
        projectId: request.projectId,
        operationType: request.operationType,
        modelId: model?.id || request.modelId,
        prompt: request.prompt,
        originalUrls: request.originalUrls || [],
        resultUrls: request.resultUrls,
        quantity: normalizeQuantity(request.quantity),
        credits,
        rmb,
        status,
        failureReason: request.failureReason,
    };
}

function isAdmin(state: AdminState, operatorId: string) {
    return state.designers.some((item) => item.id === operatorId && item.role === "admin" && item.status === "active");
}

export function normalizeDesignerAccount(account: DesignerAccount): DesignerAccount {
    return {
        ...account,
        loginName: normalizeLoginName(account.loginName || account.id),
        password: account.password || "123456",
    };
}

function successfulAdminAction(state: AdminState, operatorId: string, targetId: string, action: string, detail: string, createdAt: string) {
    return {
        ok: true as const,
        state: {
            ...state,
            auditLogs: [createAuditLog({ operatorId, targetId, action, detail, result: "success", createdAt }), ...state.auditLogs],
        },
    };
}

function failedAdminAction(state: AdminState, operatorId: string, targetId: string, action: string, detail: string, createdAt: string) {
    return {
        ok: false as const,
        reason: detail,
        state: {
            ...state,
            auditLogs: [createAuditLog({ operatorId, targetId, action, detail, result: "failed", createdAt }), ...state.auditLogs],
        },
    };
}

function normalizeQuantity(quantity: number | undefined) {
    return Math.max(1, Math.floor(Math.abs(Number(quantity)) || 1));
}

function clamp(value: number, min: number, max: number) {
    return Math.min(max, Math.max(min, value));
}

function normalizeLoginName(value: string) {
    return value.normalize("NFKC").trim().toLocaleLowerCase("zh-CN");
}

function roundMoney(value: number) {
    return Math.round(value * 100) / 100;
}
