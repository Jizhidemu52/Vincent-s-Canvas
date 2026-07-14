import { describe, expect, test } from "bun:test";
import { Pool } from "pg";

import { settleReservation } from "../../src/billing";

const runIntegration = process.env.RUN_INTEGRATION_TESTS === "true";
const integration = runIntegration ? describe : describe.skip;
const baseUrl = process.env.INTEGRATION_BASE_URL ?? "http://127.0.0.1:3100";

type ApiResponse<T> = { response: Response; body: T };

async function api<T>(
  path: string,
  options: RequestInit = {},
  cookie?: string,
): Promise<ApiResponse<T>> {
  const headers = new Headers(options.headers);
  if (options.body && !headers.has("content-type"))
    headers.set("content-type", "application/json");
  if (cookie) headers.set("cookie", cookie);
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers,
    redirect: "manual",
  });
  const contentType = response.headers.get("content-type") ?? "";
  const body = (
    contentType.includes("application/json")
      ? await response.json()
      : await response.text()
  ) as T;
  return { response, body };
}

async function login(
  identifier: string,
  password: string,
  portal: "designer" | "admin",
) {
  const result = await api<{
    user: { id: string; mustChangePassword: boolean; mfaEnabled: boolean };
  }>("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ identifier, password, portal }),
  });
  expect(result.response.status).toBe(200);
  const cookie = result.response.headers.get("set-cookie")?.split(";", 1)[0];
  expect(cookie).toBeTruthy();
  return { cookie: cookie!, user: result.body.user };
}

async function changePassword(
  cookie: string,
  currentPassword: string,
  newPassword: string,
) {
  const result = await api(
    "/api/auth/change-password",
    {
      method: "POST",
      body: JSON.stringify({ currentPassword, newPassword }),
    },
    cookie,
  );
  expect(result.response.status).toBe(204);
}

integration("production identity and RBAC", () => {
  test("enforces onboarding, account scope, 100-user import, durable sessions and project isolation", async () => {
    const admin = await login("admin", "AdminStart2026", "admin");
    expect(admin.user.mustChangePassword).toBe(true);

    const beforePassword = await api<{ error: string }>(
      "/api/admin/departments",
      {},
      admin.cookie,
    );
    expect(beforePassword.response.status).toBe(403);
    expect(beforePassword.body.error).toBe("PASSWORD_CHANGE_REQUIRED");

    await changePassword(admin.cookie, "AdminStart2026", "AdminReady2026");
    const afterPassword = await api<{ departments: unknown[] }>(
      "/api/admin/departments",
      {},
      admin.cookie,
    );
    expect(afterPassword.response.status).toBe(200);

    const restoredSession = await api<{
      user: { mustChangePassword: boolean };
    }>("/api/auth/session", {}, admin.cookie);
    expect(restoredSession.response.status).toBe(200);
    expect(restoredSession.body.user).toMatchObject({
      mustChangePassword: false,
    });

    const integrations = await api<{
      wecom: { configured: boolean; missing: string[] };
      objectStorage: { configured: boolean };
    }>("/api/admin/integrations/status", {}, admin.cookie);
    expect(integrations.response.status).toBe(200);
    expect(integrations.body.wecom).toMatchObject({
      configured: false,
      missing: [
        "WECOM_CORP_ID",
        "WECOM_AGENT_ID",
        "WECOM_SECRET",
        "WECOM_CALLBACK_URL",
      ],
    });
    expect(JSON.stringify(integrations.body)).not.toContain("server-secret");

    const createDepartment = async (name: string, code: string) => {
      const result = await api<{ department: { id: string } }>(
        "/api/admin/departments",
        {
          method: "POST",
          body: JSON.stringify({ name, code }),
        },
        admin.cookie,
      );
      if (result.response.status !== 201) {
        throw new Error(
          `Department creation failed (${result.response.status}): ${JSON.stringify(result.body)}`,
        );
      }
      return result.body.department.id;
    };
    const departmentA = await createDepartment("设计一部", "design-a");
    const departmentB = await createDepartment("设计二部", "design-b");

    const createAccount = async (input: Record<string, unknown>) => {
      const result = await api<{
        user: { id: string; departmentId: string; role: string };
      }>(
        "/api/admin/accounts",
        {
          method: "POST",
          body: JSON.stringify(input),
        },
        admin.cookie,
      );
      if (result.response.status !== 201) {
        throw new Error(
          `Account creation failed (${result.response.status}): ${JSON.stringify(result.body)}`,
        );
      }
      return result.body.user;
    };
    const designerA = await createAccount({
      username: "设计师甲",
      displayName: "设计师甲",
      email: "designer-a@company.test",
      employeeNo: "D-A-001",
      password: "DesignerStart2026",
      role: "designer",
      departmentId: departmentA,
      creditBalance: 500,
      creditLimit: 500,
    });
    const designerB = await createAccount({
      username: "designer-b",
      displayName: "Designer B",
      email: "designer-b@company.test",
      employeeNo: "D-B-001",
      password: "DesignerStart2026",
      role: "designer",
      departmentId: departmentB,
      creditBalance: 500,
      creditLimit: 500,
    });
    await createAccount({
      username: "manager-a",
      displayName: "设计一部管理员",
      email: "manager-a@company.test",
      employeeNo: "M-A-001",
      password: "ManagerStart2026",
      role: "department_admin",
      departmentId: departmentA,
      creditBalance: 0,
      creditLimit: 0,
    });

    const bulkAccounts = Array.from({ length: 100 }, (_, index) => ({
      username: `batch-designer-${String(index + 1).padStart(3, "0")}`,
      displayName: `批量设计师 ${index + 1}`,
      email: `batch-${index + 1}@company.test`,
      employeeNo: `BATCH-${String(index + 1).padStart(3, "0")}`,
      password: "BatchDesigner2026",
      role: "designer",
      departmentId: departmentA,
      creditBalance: 100,
      creditLimit: 100,
    }));
    const bulk = await api<{ created: number; failures: unknown[] }>(
      "/api/admin/accounts/bulk",
      {
        method: "POST",
        body: JSON.stringify({ accounts: bulkAccounts }),
      },
      admin.cookie,
    );
    expect(bulk.response.status).toBe(201);
    expect(bulk.body).toEqual({ created: 100, failures: [] });

    const chineseLogin = await login(
      "设计师甲",
      "DesignerStart2026",
      "designer",
    );
    const emailLogin = await login(
      "designer-b@company.test",
      "DesignerStart2026",
      "designer",
    );
    const englishUsernameLogin = await login(
      "designer-b",
      "DesignerStart2026",
      "designer",
    );
    const employeeLogin = await login("M-A-001", "ManagerStart2026", "admin");

    const designerBeforePassword = await api<{ error: string }>(
      "/api/projects",
      {},
      chineseLogin.cookie,
    );
    expect(designerBeforePassword.body.error).toBe("PASSWORD_CHANGE_REQUIRED");
    await changePassword(
      chineseLogin.cookie,
      "DesignerStart2026",
      "DesignerReady2026",
    );
    await changePassword(
      emailLogin.cookie,
      "DesignerStart2026",
      "DesignerBReady2026",
    );
    const revokedEnglishUsernameSession = await api<{ error: string }>(
      "/api/auth/session",
      {},
      englishUsernameLogin.cookie,
    );
    expect(revokedEnglishUsernameSession.response.status).toBe(401);
    expect(revokedEnglishUsernameSession.body.error).toBe("SESSION_EXPIRED");
    await changePassword(
      employeeLogin.cookie,
      "ManagerStart2026",
      "ManagerReady2026",
    );

    const groupA = await api<{ group: { id: string } }>(
      "/api/admin/groups",
      { method: "POST", body: JSON.stringify({ name: "花型一组", code: "pattern-a", departmentId: departmentA }) },
      admin.cookie,
    );
    expect(groupA.response.status).toBe(201);
    const groupB = await api<{ group: { id: string } }>(
      "/api/admin/groups",
      { method: "POST", body: JSON.stringify({ name: "商品图组", code: "product-a", departmentId: departmentA }) },
      admin.cookie,
    );
    expect(groupB.response.status).toBe(201);
    const temporaryGroup = await api<{ group: { id: string } }>(
      "/api/admin/groups",
      { method: "POST", body: JSON.stringify({ name: "临时设计组", code: "temporary-a", departmentId: departmentA }) },
      admin.cookie,
    );
    expect(temporaryGroup.response.status).toBe(201);
    const departmentAccounts = await api<{ users: Array<{ id: string; username: string }> }>("/api/admin/accounts", {}, employeeLogin.cookie);
    const batchMember = departmentAccounts.body.users.find((user) => user.username === "batch-designer-001")!;
    const transferredMember = departmentAccounts.body.users.find((user) => user.username === "batch-designer-002")!;
    expect(batchMember.id).toBeTruthy();
    expect(transferredMember.id).toBeTruthy();
    const assignTemporaryMember = await api(
      `/api/admin/groups/${temporaryGroup.body.group.id}/members`,
      { method: "POST", body: JSON.stringify({ userId: transferredMember.id, role: "member" }) },
      employeeLogin.cookie,
    );
    expect(assignTemporaryMember.response.status).toBe(204);
    const disableTemporaryGroup = await api(
      `/api/admin/groups/${temporaryGroup.body.group.id}`,
      { method: "PATCH", body: JSON.stringify({ status: "disabled" }) },
      employeeLogin.cookie,
    );
    expect(disableTemporaryGroup.response.status).toBe(200);
    const assignAfterGroupDisable = await api(
      `/api/admin/groups/${groupB.body.group.id}/members`,
      { method: "POST", body: JSON.stringify({ userId: transferredMember.id, role: "member" }) },
      employeeLogin.cookie,
    );
    expect(assignAfterGroupDisable.response.status).toBe(204);
    const assignLeader = await api(
      `/api/admin/groups/${groupA.body.group.id}/members`,
      { method: "POST", body: JSON.stringify({ userId: designerA.id, role: "leader" }) },
      admin.cookie,
    );
    expect(assignLeader.response.status).toBe(204);
    const assignMember = await api(
      `/api/admin/groups/${groupA.body.group.id}/members`,
      { method: "POST", body: JSON.stringify({ userId: batchMember.id, role: "member" }) },
      employeeLogin.cookie,
    );
    expect(assignMember.response.status).toBe(204);
    const memberLogin = await login("batch-designer-001", "BatchDesigner2026", "designer");
    await changePassword(memberLogin.cookie, "BatchDesigner2026", "BatchDesignerReady2026");
    const duplicateGroup = await api<{ error: string }>(
      `/api/admin/groups/${groupB.body.group.id}/members`,
      { method: "POST", body: JSON.stringify({ userId: designerA.id, role: "member" }) },
      admin.cookie,
    );
    expect(duplicateGroup.response.status).toBe(409);
    expect(duplicateGroup.body.error).toBe("GROUP_MEMBERSHIP_CONFLICT");
    const crossDepartmentMember = await api<{ error: string }>(
      `/api/admin/groups/${groupA.body.group.id}/members`,
      { method: "POST", body: JSON.stringify({ userId: designerB.id, role: "member" }) },
      admin.cookie,
    );
    expect(crossDepartmentMember.response.status).toBe(400);
    expect(crossDepartmentMember.body.error).toBe("INVALID_GROUP_MEMBER");
    const leaderSession = await api<{ user: { groupId: string; groupRole: string } }>("/api/auth/session", {}, chineseLogin.cookie);
    expect(leaderSession.body.user).toMatchObject({ groupId: groupA.body.group.id, groupRole: "leader" });
    const leaderTeam = await api<{ group: { id: string }; members: unknown[] }>("/api/team", {}, chineseLogin.cookie);
    expect(leaderTeam.response.status).toBe(200);
    expect(leaderTeam.body.group.id).toBe(groupA.body.group.id);
    expect(leaderTeam.body.members).toHaveLength(2);
    const ordinaryTeamAttempt = await api<{ error: string }>("/api/team", {}, emailLogin.cookie);
    expect(ordinaryTeamAttempt.response.status).toBe(403);
    expect(ordinaryTeamAttempt.body.error).toBe("FORBIDDEN");

    const configureGroupPool = await api(
      `/api/admin/group-credits/${groupA.body.group.id}/policy`,
      { method: "PATCH", body: JSON.stringify({ monthlySharedCreditLimit: 120, perRequestLimit: 40,
        dailyUserLimit: 50, monthlyUserLimit: 80, applyCurrentPeriod: true }) },
      employeeLogin.cookie,
    );
    expect(configureGroupPool.response.status).toBe(200);
    const memberPool = await api<{ poolBalance: number; wallet: { availableCredits: number } }>(
      "/api/group-credits", {}, memberLogin.cookie,
    );
    expect(memberPool.response.status).toBe(200);
    expect(memberPool.body).toMatchObject({ poolBalance: 120, wallet: { availableCredits: 0 } });
    const claimRequestId = `integration-group-claim-${crypto.randomUUID()}`;
    const claim = await api<{ id: string; status: string; duplicate: boolean }>(
      "/api/group-credits/requests",
      { method: "POST", body: JSON.stringify({ requestId: claimRequestId, amount: 30, reason: "批量商品图任务" }) },
      memberLogin.cookie,
    );
    expect(claim.response.status).toBe(201);
    expect(claim.body).toMatchObject({ status: "pending", duplicate: false });
    const duplicateClaim = await api<{ id: string; duplicate: boolean }>(
      "/api/group-credits/requests",
      { method: "POST", body: JSON.stringify({ requestId: claimRequestId, amount: 30, reason: "重复提交" }) },
      memberLogin.cookie,
    );
    expect(duplicateClaim.body).toMatchObject({ id: claim.body.id, duplicate: true });
    const approveClaim = await api<{ status: string; duplicate: boolean }>(
      `/api/team/group-credits/requests/${claim.body.id}/decision`,
      { method: "POST", body: JSON.stringify({ decision: "approved" }) },
      chineseLogin.cookie,
    );
    expect(approveClaim.response.status).toBe(200);
    expect(approveClaim.body).toEqual({ status: "approved", duplicate: false });
    const duplicateApprove = await api<{ status: string; duplicate: boolean }>(
      `/api/team/group-credits/requests/${claim.body.id}/decision`,
      { method: "POST", body: JSON.stringify({ decision: "approved" }) },
      chineseLogin.cookie,
    );
    expect(duplicateApprove.body).toEqual({ status: "approved", duplicate: true });
    const approvedPool = await api<{ poolBalance: number; wallet: { availableCredits: number } }>(
      "/api/group-credits", {}, memberLogin.cookie,
    );
    expect(approvedPool.body).toMatchObject({ poolBalance: 90, wallet: { availableCredits: 30 } });

    const concurrentClaims = await Promise.all([1, 2].map((index) => api<{ id: string }>(
      "/api/group-credits/requests",
      { method: "POST", body: JSON.stringify({ requestId: `integration-concurrent-${index}-${crypto.randomUUID()}`, amount: 20, reason: `并发申请 ${index}` }) },
      memberLogin.cookie,
    )));
    const concurrentDecisions = await Promise.all(concurrentClaims.map((item) => api<{ status?: string; error?: string }>(
      `/api/team/group-credits/requests/${item.body.id}/decision`,
      { method: "POST", body: JSON.stringify({ decision: "approved" }) },
      chineseLogin.cookie,
    )));
    expect(concurrentDecisions.map((item) => item.response.status).sort()).toEqual([200, 409]);
    const afterConcurrent = await api<{ wallet: { availableCredits: number }; poolBalance: number }>(
      "/api/group-credits", {}, memberLogin.cookie,
    );
    expect(afterConcurrent.body).toMatchObject({ wallet: { availableCredits: 50 }, poolBalance: 70 });

    const leaderClaim = await api<{ id: string }>(
      "/api/group-credits/requests",
      { method: "POST", body: JSON.stringify({ requestId: `integration-leader-self-${crypto.randomUUID()}`, amount: 10, reason: "组长本人申请" }) },
      chineseLogin.cookie,
    );
    const selfApproval = await api<{ error: string }>(
      `/api/team/group-credits/requests/${leaderClaim.body.id}/decision`,
      { method: "POST", body: JSON.stringify({ decision: "approved" }) },
      chineseLogin.cookie,
    );
    expect(selfApproval.response.status).toBe(403);
    expect(selfApproval.body.error).toBe("SELF_APPROVAL_FORBIDDEN");
    const rejectLeaderClaim = await api(
      `/api/admin/group-credits/${groupA.body.group.id}/requests/${leaderClaim.body.id}/decision`,
      { method: "POST", body: JSON.stringify({ decision: "rejected", note: "测试拒绝" }) },
      admin.cookie,
    );
    expect(rejectLeaderClaim.response.status).toBe(200);

    const contribute = await api<{ poolBalance: number; personalBalance: number }>(
      "/api/group-credits/contributions",
      { method: "POST", body: JSON.stringify({ requestId: `integration-contribution-${crypto.randomUUID()}`, amount: 50 }) },
      memberLogin.cookie,
    );
    expect(contribute.response.status).toBe(201);
    expect(contribute.body).toMatchObject({ poolBalance: 120, personalBalance: 50 });

    const designerAdminAttempt = await api<{ error: string }>(
      "/api/admin/accounts",
      {},
      chineseLogin.cookie,
    );
    expect(designerAdminAttempt.response.status).toBe(403);
    expect(designerAdminAttempt.body.error).toBe("FORBIDDEN");
    const designerIntegrationAttempt = await api<{ error: string }>(
      "/api/admin/integrations/status",
      {},
      chineseLogin.cookie,
    );
    expect(designerIntegrationAttempt.response.status).toBe(403);
    expect(designerIntegrationAttempt.body.error).toBe("FORBIDDEN");
    const designerInternalAiAttempt = await api<{ error: string }>(
      "/api/admin/internal-ai",
      {},
      chineseLogin.cookie,
    );
    expect(designerInternalAiAttempt.response.status).toBe(403);
    expect(designerInternalAiAttempt.body.error).toBe("FORBIDDEN");

    const configureInternalAi = await api<{
      seamlessUrl: string;
      hasAppKey: boolean;
      appKeyPreview: string;
    }>(
      "/api/admin/internal-ai",
      {
        method: "PUT",
        body: JSON.stringify({
          seamlessUrl: "https://internal-ai.company.test/std/tohwkdpj",
          appKey: "integration-internal-app-key",
        }),
      },
      admin.cookie,
    );
    expect(configureInternalAi.response.status).toBe(200);
    expect(configureInternalAi.body).toMatchObject({
      seamlessUrl: "https://internal-ai.company.test/std/tohwkdpj",
      hasAppKey: true,
    });
    expect(JSON.stringify(configureInternalAi.body)).not.toContain(
      "integration-internal-app-key",
    );

    const publicModels = await api<{
      models: Array<{ id: string; modelId: string; creditCost: number }>;
      prices: Array<{ operationType: string; credits: number }>;
    }>("/api/models", {}, chineseLogin.cookie);
    expect(publicModels.response.status).toBe(200);
    const internalSeamlessModel = publicModels.body.models.find(
      (model) => model.modelId === "internal-seamless",
    );
    expect(internalSeamlessModel?.creditCost).toBe(0);
    expect(
      publicModels.body.prices.find(
        (price) => price.operationType === "seamless_stitch",
      )?.credits,
    ).toBe(2);
    expect(
      publicModels.body.prices.find(
        (price) => price.operationType === "audio_generation",
      )?.credits,
    ).toBe(10);

    const audioProvider = await api<{ provider: { id: string } }>(
      "/api/admin/model-configuration/providers",
      {
        method: "POST",
        body: JSON.stringify({
          name: "Integration Audio Provider",
          protocol: "openai",
          baseUrl: "https://api.openai.com/v1",
          enabled: true,
          credentials: { apiKey: "integration-audio-key" },
        }),
      },
      admin.cookie,
    );
    expect(audioProvider.response.status).toBe(201);
    expect(JSON.stringify(audioProvider.body)).not.toContain(
      "integration-audio-key",
    );
    const audioModel = await api<{ model: { id: string } }>(
      "/api/admin/model-configuration/models",
      {
        method: "POST",
        body: JSON.stringify({
          providerId: audioProvider.body.provider.id,
          name: "Integration Audio Model",
          modelId: "integration-audio-v1",
          capabilities: ["audio"],
          creditCost: 3,
          rmbCost: 0.1,
          concurrencyLimit: 2,
          enabled: true,
        }),
      },
      admin.cookie,
    );
    expect(audioModel.response.status).toBe(201);

    const designerModules = await api<{ modules: Array<{ moduleKey: string; enabled: boolean }> }>(
      "/api/modules",
      {},
      chineseLogin.cookie,
    );
    expect(designerModules.response.status).toBe(200);
    expect(designerModules.body.modules.find((module) => module.moduleKey === "seamless-stitch")?.enabled).toBe(true);
    expect(designerModules.body.modules.find((module) => module.moduleKey === "performance")?.enabled).toBe(true);
    const promptModel = internalSeamlessModel!;
    const invalidPromptTemplate = await api<{ error: string }>(
      "/api/prompt-templates",
      { method: "POST", body: JSON.stringify({ title: "", prompt: "", targetTool: "image-edit" }) },
      memberLogin.cookie,
    );
    expect(invalidPromptTemplate.response.status).toBe(400);
    expect(invalidPromptTemplate.body.error).toBe("VALIDATION_ERROR");
    const createPromptTemplate = await api<{ template: { id: string; currentVersionId: string } }>(
      "/api/prompt-templates",
      { method: "POST", body: JSON.stringify({
        title: "白底商品图", prompt: "保持服装结构与面料，生成干净的白底商品图", targetTool: "image-edit",
        modelConfigId: promptModel.id, parameters: { width: 1024, height: 1024, quantity: 2 },
        category: "商品图", tags: ["白底", "电商"], notes: "组内测试模板",
      }) },
      memberLogin.cookie,
    );
    expect(createPromptTemplate.response.status).toBe(201);
    const promptTemplateId = createPromptTemplate.body.template.id;
    const ownPromptList = await api<{ templates: Array<{ id: string; title: string }>; total: number }>(
      "/api/prompt-templates?scope=personal&favorite=false", {}, memberLogin.cookie,
    );
    expect(ownPromptList.response.status).toBe(200);
    expect(ownPromptList.body.templates).toContainEqual(expect.objectContaining({ id: promptTemplateId, title: "白底商品图" }));
    const crossDesignerPromptCopy = await api<{ error: string }>(
      `/api/prompt-templates/${promptTemplateId}/copy`, { method: "POST" }, chineseLogin.cookie,
    );
    expect(crossDesignerPromptCopy.response.status).toBe(404);
    expect(crossDesignerPromptCopy.body.error).toBe("NOT_FOUND");
    const auditedPromptView = await api<{ template: { id: string; prompt: string } }>(
      `/api/admin/prompt-templates/${promptTemplateId}/audit-view`, {}, employeeLogin.cookie,
    );
    expect(auditedPromptView.response.status).toBe(200);
    expect(auditedPromptView.body.template).toMatchObject({ id: promptTemplateId, prompt: "保持服装结构与面料，生成干净的白底商品图" });
    const submitRequestId = `integration-prompt-submit-${crypto.randomUUID()}`;
    const promptSubmission = await api<{ submission: { id: string; duplicate: boolean } }>(
      `/api/prompt-templates/${promptTemplateId}/submit`,
      { method: "POST", body: JSON.stringify({ requestId: submitRequestId }) }, memberLogin.cookie,
    );
    expect(promptSubmission.response.status).toBe(201);
    expect(promptSubmission.body.submission.duplicate).toBe(false);
    const duplicatePromptSubmission = await api<{ submission: { id: string; duplicate: boolean } }>(
      `/api/prompt-templates/${promptTemplateId}/submit`,
      { method: "POST", body: JSON.stringify({ requestId: submitRequestId }) }, memberLogin.cookie,
    );
    expect(duplicatePromptSubmission.response.status).toBe(200);
    expect(duplicatePromptSubmission.body.submission).toMatchObject({ id: promptSubmission.body.submission.id, duplicate: true });
    const leaderPromptQueue = await api<{ submissions: Array<{ id: string; prompt: string }> }>(
      "/api/prompt-templates/review/submissions", {}, chineseLogin.cookie,
    );
    expect(leaderPromptQueue.response.status).toBe(200);
    expect(leaderPromptQueue.body.submissions).toContainEqual(expect.objectContaining({ id: promptSubmission.body.submission.id, prompt: "保持服装结构与面料，生成干净的白底商品图" }));
    const approvePrompt = await api<{ submission: { status: string; publication: { templateId: string } } }>(
      `/api/prompt-templates/review/submissions/${promptSubmission.body.submission.id}`,
      { method: "POST", body: JSON.stringify({ decision: "approve", note: "可供本组复用" }) }, chineseLogin.cookie,
    );
    expect(approvePrompt.response.status).toBe(200);
    expect(approvePrompt.body.submission.status).toBe("approved");
    const duplicatePromptReview = await api<{ error: string }>(
      `/api/prompt-templates/review/submissions/${promptSubmission.body.submission.id}`,
      { method: "POST", body: JSON.stringify({ decision: "approve" }) }, chineseLogin.cookie,
    );
    expect(duplicatePromptReview.response.status).toBe(409);
    expect(duplicatePromptReview.body.error).toBe("SUBMISSION_ALREADY_REVIEWED");
    const teamPromptId = approvePrompt.body.submission.publication.templateId;
    const memberTeamPrompts = await api<{ templates: Array<{ id: string }> }>(
      "/api/prompt-templates?scope=team", {}, memberLogin.cookie,
    );
    expect(memberTeamPrompts.body.templates.map((item) => item.id)).toContain(teamPromptId);
    const otherDepartmentTeamPrompts = await api<{ templates: Array<{ id: string }> }>(
      "/api/prompt-templates?scope=team", {}, emailLogin.cookie,
    );
    expect(otherDepartmentTeamPrompts.body.templates).toHaveLength(0);
    const resolveRequestId = `integration-prompt-resolve-${crypto.randomUUID()}`;
    const resolvedPrompt = await api<{ reuseToken: string; pricing: { modelChanged: boolean; estimate: { totalCredits: number } } }>(
      `/api/prompt-templates/${teamPromptId}/resolve`,
      { method: "POST", body: JSON.stringify({ requestId: resolveRequestId, mode: "fill" }) }, memberLogin.cookie,
    );
    expect(resolvedPrompt.response.status).toBe(200);
    expect(resolvedPrompt.body.pricing.modelChanged).toBe(false);
    const initialPromptCredits = resolvedPrompt.body.pricing.estimate.totalCredits;
    const hydratedPrompt = await api<{ template: { prompt: string; parameters: { quantity: number } }; mode: string }>(
      `/api/prompt-templates/reuse/${resolvedPrompt.body.reuseToken}`, {}, memberLogin.cookie,
    );
    expect(hydratedPrompt.response.status).toBe(200);
    expect(hydratedPrompt.body).toMatchObject({ mode: "fill", template: { prompt: "保持服装结构与面料，生成干净的白底商品图", parameters: { quantity: 2 } } });
    const updatePromptPrice = await api(
      `/api/admin/model-configuration/models/${promptModel.id}`,
      { method: "PATCH", body: JSON.stringify({ creditCost: promptModel.creditCost + 3 }) }, admin.cookie,
    );
    expect(updatePromptPrice.response.status).toBe(200);
    const repricedPrompt = await api<{ pricing: { estimate: { totalCredits: number } } }>(
      `/api/prompt-templates/${teamPromptId}/resolve`,
      { method: "POST", body: JSON.stringify({ requestId: `integration-prompt-reprice-${crypto.randomUUID()}`, mode: "fill" }) }, memberLogin.cookie,
    );
    expect(repricedPrompt.body.pricing.estimate.totalCredits).toBe(initialPromptCredits + 6);
    const replacementModel = await api<{ model: { id: string } }>(
      "/api/admin/model-configuration/models",
      { method: "POST", body: JSON.stringify({ providerId: audioProvider.body.provider.id, name: "Integration Prompt Replacement", modelId: "integration-prompt-replacement", capabilities: ["edit"], creditCost: 1, rmbCost: 0.05, concurrencyLimit: 2, enabled: true }) },
      admin.cookie,
    );
    expect(replacementModel.response.status).toBe(201);
    const disablePromptModel = await api(
      `/api/admin/model-configuration/models/${promptModel.id}`,
      { method: "PATCH", body: JSON.stringify({ enabled: false, replacementModelConfigId: replacementModel.body.model.id }) }, admin.cookie,
    );
    expect(disablePromptModel.response.status).toBe(200);
    const replacedPrompt = await api<{ pricing: { modelChanged: boolean; reason: string; selectedModel: { id: string } } }>(
      `/api/prompt-templates/${teamPromptId}/resolve`,
      { method: "POST", body: JSON.stringify({ requestId: `integration-prompt-replacement-${crypto.randomUUID()}`, mode: "fill" }) }, memberLogin.cookie,
    );
    expect(replacedPrompt.body.pricing).toMatchObject({ modelChanged: true, reason: "replacement", selectedModel: { id: replacementModel.body.model.id } });
    const publicationRequestId = `integration-prompt-public-${crypto.randomUUID()}`;
    const publicPrompt = await api<{ publication: { templateId: string; duplicate: boolean } }>(
      `/api/prompt-templates/${teamPromptId}/promote-public`,
      { method: "POST", body: JSON.stringify({ requestId: publicationRequestId }) }, admin.cookie,
    );
    expect(publicPrompt.response.status).toBe(201);
    const duplicatePublicPrompt = await api<{ publication: { templateId: string; duplicate: boolean } }>(
      `/api/prompt-templates/${teamPromptId}/promote-public`,
      { method: "POST", body: JSON.stringify({ requestId: publicationRequestId }) }, admin.cookie,
    );
    expect(duplicatePublicPrompt.response.status).toBe(200);
    expect(duplicatePublicPrompt.body.publication).toMatchObject({ templateId: publicPrompt.body.publication.templateId, duplicate: true });
    const publicPromptList = await api<{ templates: Array<{ id: string }> }>(
      "/api/prompt-templates?scope=public", {}, emailLogin.cookie,
    );
    expect(publicPromptList.body.templates.map((item) => item.id)).toContain(publicPrompt.body.publication.templateId);
    const disablePrompts = await api(
      "/api/admin/modules", { method: "PATCH", body: JSON.stringify({ moduleKey: "prompts", enabled: false }) }, admin.cookie,
    );
    expect(disablePrompts.response.status).toBe(200);
    const disabledPromptList = await api<{ error: string }>("/api/prompt-templates?scope=public", {}, memberLogin.cookie);
    expect(disabledPromptList.response.status).toBe(403);
    expect(disabledPromptList.body.error).toBe("MODULE_DISABLED");
    const reenablePrompts = await api(
      "/api/admin/modules", { method: "PATCH", body: JSON.stringify({ moduleKey: "prompts", enabled: true }) }, admin.cookie,
    );
    expect(reenablePrompts.response.status).toBe(200);
    const restorePromptModel = await api(
      `/api/admin/model-configuration/models/${promptModel.id}`,
      { method: "PATCH", body: JSON.stringify({ enabled: true, replacementModelConfigId: null, creditCost: promptModel.creditCost }) }, admin.cookie,
    );
    expect(restorePromptModel.response.status).toBe(200);
    const adminPerformance = await api<{ metrics: { validOutputs: number }; options: { departments: unknown[] } }>(
      "/api/performance?preset=month", {}, admin.cookie,
    );
    expect(adminPerformance.response.status).toBe(200);
    expect(adminPerformance.body.metrics.validOutputs).toBeGreaterThanOrEqual(0);
    expect(adminPerformance.body.options.departments.length).toBeGreaterThanOrEqual(2);
    const managerPerformance = await api<{ options: { departments: unknown[]; users: Array<{ departmentId: string }> } }>(
      "/api/performance?preset=month", {}, employeeLogin.cookie,
    );
    expect(managerPerformance.response.status).toBe(200);
    expect(managerPerformance.body.options.departments).toHaveLength(0);
    expect(managerPerformance.body.options.users.every((user) => user.departmentId === departmentA)).toBe(true);
    const leaderPerformance = await api<{ options: { groups: Array<{ value: string; label: string; departmentId: string }>; users: Array<{ groupId: string }> } }>(
      "/api/performance?preset=month", {}, chineseLogin.cookie,
    );
    expect(leaderPerformance.response.status).toBe(200);
    expect(leaderPerformance.body.options.groups).toEqual([{ value: groupA.body.group.id, label: "花型一组", departmentId: departmentA }]);
    expect(leaderPerformance.body.options.users.every((user) => user.groupId === groupA.body.group.id)).toBe(true);
    const ordinaryPerformance = await api<{ error: string }>("/api/performance?preset=month", {}, emailLogin.cookie);
    expect(ordinaryPerformance.response.status).toBe(403);
    expect(ordinaryPerformance.body.error).toBe("FORBIDDEN");
    const invalidPerformanceRange = await api<{ error: string }>(
      "/api/performance?preset=custom&from=2026-07-10T00%3A00%3A00.000Z&to=2026-07-01T00%3A00%3A00.000Z", {}, admin.cookie,
    );
    expect(invalidPerformanceRange.response.status).toBe(400);
    const disabledPerformanceModule = await api(
      "/api/admin/modules",
      { method: "PATCH", body: JSON.stringify({ moduleKey: "performance", enabled: false }) },
      admin.cookie,
    );
    expect(disabledPerformanceModule.response.status).toBe(200);
    const disabledPerformance = await api<{ error: string; moduleKey: string }>("/api/performance?preset=month", {}, chineseLogin.cookie);
    expect(disabledPerformance.response.status).toBe(403);
    expect(disabledPerformance.body).toMatchObject({ error: "MODULE_DISABLED", moduleKey: "performance" });
    const reenabledPerformanceModule = await api(
      "/api/admin/modules",
      { method: "PATCH", body: JSON.stringify({ moduleKey: "performance", enabled: true }) },
      admin.cookie,
    );
    expect(reenabledPerformanceModule.response.status).toBe(200);
    const managerModuleAttempt = await api<{ error: string }>(
      "/api/admin/modules",
      { method: "PATCH", body: JSON.stringify({ moduleKey: "seamless-stitch", enabled: false }) },
      employeeLogin.cookie,
    );
    expect(managerModuleAttempt.response.status).toBe(403);
    expect(managerModuleAttempt.body.error).toBe("FORBIDDEN");
    const disabledTeamModule = await api(
      "/api/admin/modules",
      { method: "PATCH", body: JSON.stringify({ moduleKey: "team", enabled: false }) },
      admin.cookie,
    );
    expect(disabledTeamModule.response.status).toBe(200);
    const disabledTeamAttempt = await api<{ error: string; moduleKey: string }>("/api/team", {}, chineseLogin.cookie);
    expect(disabledTeamAttempt.response.status).toBe(403);
    expect(disabledTeamAttempt.body).toMatchObject({ error: "MODULE_DISABLED", moduleKey: "team" });
    const reenabledTeamModule = await api(
      "/api/admin/modules",
      { method: "PATCH", body: JSON.stringify({ moduleKey: "team", enabled: true }) },
      admin.cookie,
    );
    expect(reenabledTeamModule.response.status).toBe(200);
    const disabledModule = await api<{ module: { enabled: boolean } }>(
      "/api/admin/modules",
      { method: "PATCH", body: JSON.stringify({ moduleKey: "seamless-stitch", enabled: false }) },
      admin.cookie,
    );
    expect(disabledModule.response.status).toBe(200);
    expect(disabledModule.body.module.enabled).toBe(false);
    const tasksBeforeDisabledSubmission = await api<{ tasks: unknown[] }>("/api/tasks", {}, chineseLogin.cookie);
    const balanceBeforeDisabledSubmission = await api<{ user: { creditBalance: number } }>("/api/auth/session", {}, chineseLogin.cookie);
    const disabledSubmission = await api<{ error: string; moduleKey: string }>(
      "/api/tasks",
      {
        method: "POST",
        body: JSON.stringify({
          requestId: "integration-disabled-module-001",
          projectId: "integration-disabled-module",
          operationType: "seamless_stitch",
          modelConfigId: internalSeamlessModel!.id,
          prompt: '{"rows":2,"cols":2}',
          sourceUrls: [],
        }),
      },
      chineseLogin.cookie,
    );
    expect(disabledSubmission.response.status).toBe(403);
    expect(disabledSubmission.body).toMatchObject({ error: "MODULE_DISABLED", moduleKey: "seamless-stitch" });
    const tasksAfterDisabledSubmission = await api<{ tasks: unknown[] }>("/api/tasks", {}, chineseLogin.cookie);
    const balanceAfterDisabledSubmission = await api<{ user: { creditBalance: number } }>("/api/auth/session", {}, chineseLogin.cookie);
    expect(tasksAfterDisabledSubmission.body.tasks).toHaveLength(tasksBeforeDisabledSubmission.body.tasks.length);
    expect(balanceAfterDisabledSubmission.body.user.creditBalance).toBe(balanceBeforeDisabledSubmission.body.user.creditBalance);
    const enabledModule = await api<{ module: { enabled: boolean } }>(
      "/api/admin/modules",
      { method: "PATCH", body: JSON.stringify({ moduleKey: "seamless-stitch", enabled: true }) },
      admin.cookie,
    );
    expect(enabledModule.response.status).toBe(200);
    expect(enabledModule.body.module.enabled).toBe(true);

    const leaveOnePersonalCredit = await api<{ personalBalance: number }>(
      "/api/group-credits/contributions",
      { method: "POST", body: JSON.stringify({ requestId: `integration-source-split-${crypto.randomUUID()}`, amount: 49 }) },
      memberLogin.cookie,
    );
    expect(leaveOnePersonalCredit.body.personalBalance).toBe(1);
    const mixedSourceRequestId = `integration-mixed-source-${crypto.randomUUID()}`;
    const mixedSourceTask = await api<{ task: { id: string; credits: number } }>(
      "/api/tasks",
      { method: "POST", body: JSON.stringify({ requestId: mixedSourceRequestId, projectId: "integration-mixed-source",
        operationType: "seamless_stitch", modelConfigId: internalSeamlessModel!.id,
        prompt: '{"rows":2,"cols":2}', sourceUrls: [] }) },
      memberLogin.cookie,
    );
    expect(mixedSourceTask.response.status).toBe(201);
    const heldMixedSession = await api<{ user: { creditBalance: number } }>("/api/auth/session", {}, memberLogin.cookie);
    const heldMixedGroup = await api<{ wallet: { availableCredits: number } }>("/api/group-credits", {}, memberLogin.cookie);
    expect(heldMixedSession.body.user.creditBalance).toBe(0);
    expect(heldMixedGroup.body.wallet.availableCredits).toBe(49);
    const releaseMixedTask = await api(`/api/tasks/${mixedSourceTask.body.task.id}/cancel`, { method: "POST" }, memberLogin.cookie);
    expect(releaseMixedTask.response.status).toBe(204);
    const releasedMixedSession = await api<{ user: { creditBalance: number } }>("/api/auth/session", {}, memberLogin.cookie);
    const releasedMixedGroup = await api<{ wallet: { availableCredits: number } }>("/api/group-credits", {}, memberLogin.cookie);
    expect(releasedMixedSession.body.user.creditBalance).toBe(1);
    expect(releasedMixedGroup.body.wallet.availableCredits).toBe(50);

    const duplicateRequestId = "integration-seamless-duplicate-001";
    const submitSeamless = (cookie: string) =>
      api<{ task: { id: string; credits: number } }>(
        "/api/tasks",
        {
          method: "POST",
          body: JSON.stringify({
            requestId: duplicateRequestId,
            projectId: "integration-seamless",
            operationType: "seamless_stitch",
            modelConfigId: internalSeamlessModel!.id,
            prompt: '{"rows":2,"cols":2}',
            sourceUrls: [],
          }),
        },
        cookie,
      );
    const firstSubmission = await submitSeamless(chineseLogin.cookie);
    const duplicateSubmission = await submitSeamless(chineseLogin.cookie);
    expect(firstSubmission.response.status).toBe(201);
    expect(duplicateSubmission.response.status).toBe(201);
    expect(duplicateSubmission.body.task.id).toBe(firstSubmission.body.task.id);
    expect(firstSubmission.body.task.credits).toBe(2);

    const heldSession = await api<{ user: { creditBalance: number } }>(
      "/api/auth/session",
      {},
      chineseLogin.cookie,
    );
    expect(heldSession.body.user.creditBalance).toBe(498);
    const crossAccountDuplicate = await submitSeamless(emailLogin.cookie);
    expect(crossAccountDuplicate.response.status).toBe(400);

    const cancelTask = await api(
      `/api/tasks/${firstSubmission.body.task.id}/cancel`,
      { method: "POST" },
      chineseLogin.cookie,
    );
    expect(cancelTask.response.status).toBe(204);
    const duplicateCancel = await api(
      `/api/tasks/${firstSubmission.body.task.id}/cancel`,
      { method: "POST" },
      chineseLogin.cookie,
    );
    expect(duplicateCancel.response.status).toBe(409);
    const releasedSession = await api<{ user: { creditBalance: number } }>(
      "/api/auth/session",
      {},
      chineseLogin.cookie,
    );
    expect(releasedSession.body.user.creditBalance).toBe(500);

    const audioParameters = {
      voice: "alloy",
      speed: 1.25,
      responseFormat: "mp3",
    };
    const audioSubmission = await api<{
      task: { id: string; credits: number };
    }>(
      "/api/tasks",
      {
        method: "POST",
        body: JSON.stringify({
          requestId: "integration-audio-task-001",
          projectId: "integration-audio",
          operationType: "audio_generation",
          modelConfigId: audioModel.body.model.id,
          prompt: "内部产品介绍旁白",
          parameters: audioParameters,
          sourceUrls: [],
        }),
      },
      chineseLogin.cookie,
    );
    expect(audioSubmission.response.status).toBe(201);
    expect(audioSubmission.body.task.credits).toBe(13);
    const designerTasks = await api<{
      tasks: Array<{ id: string; parameters: Record<string, unknown> }>;
    }>("/api/tasks", {}, chineseLogin.cookie);
    expect(
      designerTasks.body.tasks.find(
        (task) => task.id === audioSubmission.body.task.id,
      )?.parameters,
    ).toEqual(audioParameters);
    const cancelAudio = await api(
      `/api/tasks/${audioSubmission.body.task.id}/cancel`,
      { method: "POST" },
      chineseLogin.cookie,
    );
    expect(cancelAudio.response.status).toBe(204);
    const audioReleasedSession = await api<{
      user: { creditBalance: number };
    }>("/api/auth/session", {}, chineseLogin.cookie);
    expect(audioReleasedSession.body.user.creditBalance).toBe(500);

    const incompatibleModelTask = await api<{ error: string }>(
      "/api/tasks",
      {
        method: "POST",
        body: JSON.stringify({
          requestId: "integration-audio-wrong-model-001",
          projectId: "integration-audio",
          operationType: "audio_generation",
          modelConfigId: internalSeamlessModel!.id,
          prompt: "should be rejected",
          sourceUrls: [],
        }),
      },
      chineseLogin.cookie,
    );
    expect(incompatibleModelTask.response.status).toBe(400);
    expect(incompatibleModelTask.body.error).toBe("MODEL_CAPABILITY_MISMATCH");

    const batchSubmission = await api<{
      batchId: string;
      tasks: Array<{ id: string; itemIndex: number }>;
      failures: unknown[];
    }>(
      "/api/tasks/batch",
      {
        method: "POST",
        body: JSON.stringify({
          requestId: "integration-batch-control-001",
          projectId: "integration-batch-control",
          operationType: "batch_image",
          modelConfigId: internalSeamlessModel!.id,
          prompt: "统一白底产品改图",
          items: [
            { sourceUrls: ["/api/assets/integration-source-a/content"] },
            { sourceUrls: ["/api/assets/integration-source-b/content"] },
          ],
        }),
      },
      chineseLogin.cookie,
    );
    expect(batchSubmission.response.status).toBe(201);
    expect(batchSubmission.body.tasks).toHaveLength(2);
    expect(batchSubmission.body.tasks.map((task) => task.itemIndex)).toEqual([
      0, 1,
    ]);
    expect(batchSubmission.body.failures).toEqual([]);
    const batchHeldSession = await api<{ user: { creditBalance: number } }>(
      "/api/auth/session",
      {},
      chineseLogin.cookie,
    );
    expect(batchHeldSession.body.user.creditBalance).toBe(492);

    const pauseBatch = await api<{ changed: number }>(
      `/api/tasks/batches/${batchSubmission.body.batchId}/pause`,
      { method: "POST" },
      chineseLogin.cookie,
    );
    expect(pauseBatch.response.status).toBe(200);
    expect(pauseBatch.body.changed).toBe(2);
    const pausedBatches = await api<{
      batches: Array<{
        id: string;
        status: string;
        pausedItems: number;
        failedItems: number;
      }>;
    }>("/api/tasks/batches", {}, chineseLogin.cookie);
    expect(
      pausedBatches.body.batches.find(
        (batch) => batch.id === batchSubmission.body.batchId,
      ),
    ).toMatchObject({ status: "paused", pausedItems: 2, failedItems: 0 });

    const resumeBatch = await api<{ changed: number }>(
      `/api/tasks/batches/${batchSubmission.body.batchId}/resume`,
      { method: "POST" },
      chineseLogin.cookie,
    );
    expect(resumeBatch.response.status).toBe(200);
    expect(resumeBatch.body.changed).toBe(2);
    const crossAccountBatchPause = await api<{ error: string }>(
      `/api/tasks/batches/${batchSubmission.body.batchId}/pause`,
      { method: "POST" },
      emailLogin.cookie,
    );
    expect(crossAccountBatchPause.response.status).toBe(404);

    const managerPauseBatch = await api<{ changed: number }>(
      `/api/admin/tasks/batches/${batchSubmission.body.batchId}/pause`,
      { method: "POST" },
      employeeLogin.cookie,
    );
    expect(managerPauseBatch.response.status).toBe(200);
    expect(managerPauseBatch.body.changed).toBe(2);
    const managerResumeBatch = await api<{ changed: number }>(
      `/api/admin/tasks/batches/${batchSubmission.body.batchId}/resume`,
      { method: "POST" },
      employeeLogin.cookie,
    );
    expect(managerResumeBatch.response.status).toBe(200);
    expect(managerResumeBatch.body.changed).toBe(2);
    await api(
      `/api/tasks/batches/${batchSubmission.body.batchId}/pause`,
      { method: "POST" },
      chineseLogin.cookie,
    );
    const cancelBatch = await api<{ changed: number }>(
      `/api/tasks/batches/${batchSubmission.body.batchId}/cancel`,
      { method: "POST" },
      chineseLogin.cookie,
    );
    expect(cancelBatch.response.status).toBe(200);
    expect(cancelBatch.body.changed).toBe(2);
    const cancelledBatches = await api<{
      batches: Array<{
        id: string;
        status: string;
        cancelledItems: number;
        failedItems: number;
        plannedCredits: number;
        consumedCredits: number;
      }>;
    }>("/api/tasks/batches", {}, chineseLogin.cookie);
    expect(
      cancelledBatches.body.batches.find(
        (batch) => batch.id === batchSubmission.body.batchId,
      ),
    ).toMatchObject({
      status: "cancelled",
      cancelledItems: 2,
      failedItems: 0,
      plannedCredits: 8,
      consumedCredits: 0,
    });
    const batchReleasedSession = await api<{
      user: { creditBalance: number };
    }>("/api/auth/session", {}, chineseLogin.cookie);
    expect(batchReleasedSession.body.user.creditBalance).toBe(500);

    const ledger = await api<{
      entries: Array<{ entryType: string; referenceId: string }>;
    }>("/api/billing/ledger", {}, chineseLogin.cookie);
    expect(
      ledger.body.entries
        .filter((entry) => entry.referenceId === duplicateRequestId)
        .map((entry) => entry.entryType)
        .sort(),
    ).toEqual(["hold", "release"]);

    const managerAccounts = await api<{
      users: Array<{ id: string; departmentId: string; role: string }>;
    }>("/api/admin/accounts", {}, employeeLogin.cookie);
    expect(managerAccounts.response.status).toBe(200);
    expect(managerAccounts.body.users).toHaveLength(101);
    expect(
      managerAccounts.body.users.every(
        (user) => user.departmentId === departmentA && user.role === "designer",
      ),
    ).toBe(true);
    expect(
      managerAccounts.body.users.some((user) => user.id === designerB.id),
    ).toBe(false);
    const managerInternalAiAttempt = await api<{ error: string }>(
      "/api/admin/internal-ai",
      {},
      employeeLogin.cookie,
    );
    expect(managerInternalAiAttempt.response.status).toBe(403);
    expect(managerInternalAiAttempt.body.error).toBe("FORBIDDEN");

    const departmentBTask = await api<{ task: { id: string } }>(
      "/api/tasks",
      {
        method: "POST",
        body: JSON.stringify({
          requestId: "integration-department-b-task",
          projectId: "department-b-project",
          operationType: "seamless_stitch",
          modelConfigId: internalSeamlessModel!.id,
          prompt: '{"rows":2,"cols":2}',
          sourceUrls: [],
        }),
      },
      emailLogin.cookie,
    );
    expect(departmentBTask.response.status).toBe(201);
    const managerTasks = await api<{ tasks: Array<{ userId: string }> }>(
      "/api/admin/tasks",
      {},
      employeeLogin.cookie,
    );
    expect(managerTasks.response.status).toBe(200);
    expect(
      managerTasks.body.tasks.some((task) => task.userId === designerA.id),
    ).toBe(true);
    expect(
      managerTasks.body.tasks.some((task) => task.userId === designerB.id),
    ).toBe(false);
    const cancelDepartmentBTask = await api(
      `/api/tasks/${departmentBTask.body.task.id}/cancel`,
      { method: "POST" },
      emailLogin.cookie,
    );
    expect(cancelDepartmentBTask.response.status).toBe(204);

    const crossDepartmentUpdate = await api<{ error: string }>(
      `/api/admin/accounts/${designerB.id}`,
      {
        method: "PATCH",
        body: JSON.stringify({ status: "disabled" }),
      },
      employeeLogin.cookie,
    );
    expect(crossDepartmentUpdate.response.status).toBe(403);
    expect(crossDepartmentUpdate.body.error).toBe("FORBIDDEN");

    const syncProject = async (cookie: string) =>
      api<{ project: { id: string; externalId: string } }>(
        "/api/projects/sync",
        {
          method: "POST",
          body: JSON.stringify({
            externalId: "same-local-project-id",
            name: "同名本地项目",
          }),
        },
        cookie,
      );
    const projectA = await syncProject(chineseLogin.cookie);
    const projectB = await syncProject(emailLogin.cookie);
    expect(projectA.response.status).toBe(200);
    expect(projectB.response.status).toBe(200);
    expect(projectA.body.project.id).not.toBe(projectB.body.project.id);

    const projectsA = await api<{ projects: Array<{ id: string }> }>(
      "/api/projects",
      {},
      chineseLogin.cookie,
    );
    const projectsB = await api<{ projects: Array<{ id: string }> }>(
      "/api/projects",
      {},
      emailLogin.cookie,
    );
    expect(projectsA.body.projects.map((project) => project.id)).toEqual([
      projectA.body.project.id,
    ]);
    expect(projectsB.body.projects.map((project) => project.id)).toEqual([
      projectB.body.project.id,
    ]);
    const managerProjects = await api<{ projects: Array<{ id: string }> }>(
      "/api/admin/projects",
      {},
      employeeLogin.cookie,
    );
    expect(managerProjects.response.status).toBe(200);
    expect(managerProjects.body.projects.map((project) => project.id)).toEqual([
      projectA.body.project.id,
    ]);

    const crossDepartmentReset = await api<{ error: string }>(
      `/api/admin/accounts/${designerB.id}/reset-password`,
      {
        method: "POST",
        body: JSON.stringify({ password: "CrossDepartmentReset2026" }),
      },
      employeeLogin.cookie,
    );
    expect(crossDepartmentReset.response.status).toBe(403);
    expect(crossDepartmentReset.body.error).toBe("FORBIDDEN");

    const resetDesignerA = await api(
      `/api/admin/accounts/${designerA.id}/reset-password`,
      {
        method: "POST",
        body: JSON.stringify({ password: "DesignerReset2026" }),
      },
      employeeLogin.cookie,
    );
    expect(resetDesignerA.response.status).toBe(204);
    const revokedDesignerSession = await api<{ error: string }>(
      "/api/auth/session",
      {},
      chineseLogin.cookie,
    );
    expect(revokedDesignerSession.response.status).toBe(401);
    expect(revokedDesignerSession.body.error).toBe("SESSION_EXPIRED");
    const oldPasswordLogin = await api<{ error: string }>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({
        identifier: "设计师甲",
        password: "DesignerReady2026",
        portal: "designer",
      }),
    });
    expect(oldPasswordLogin.response.status).toBe(401);
    expect(oldPasswordLogin.body.error).toBe("INVALID_CREDENTIALS");
    const resetLogin = await login("设计师甲", "DesignerReset2026", "designer");
    expect(resetLogin.user.mustChangePassword).toBe(true);
    const resetBusinessAttempt = await api<{ error: string }>(
      "/api/projects",
      {},
      resetLogin.cookie,
    );
    expect(resetBusinessAttempt.response.status).toBe(403);
    expect(resetBusinessAttempt.body.error).toBe("PASSWORD_CHANGE_REQUIRED");
    await changePassword(
      resetLogin.cookie,
      "DesignerReset2026",
      "DesignerReadyAgain2026",
    );
    const resetReady = await api<{ projects: unknown[] }>(
      "/api/projects",
      {},
      resetLogin.cookie,
    );
    expect(resetReady.response.status).toBe(200);

    const database = new Pool({ connectionString: process.env.DATABASE_URL });
    try {
      await database.query(
        `UPDATE users SET credit_balance=1000,credit_limit=1000,monthly_credit_limit=1000,
            temporary_credit_adjustment=0,
            credit_period_start=date_trunc('month', timezone('Asia/Shanghai', now()))::date
          WHERE id=$1`, [designerA.id],
      );
      const temporaryRequestId = `monthly-test-${crypto.randomUUID()}`;
      const temporary = await api<{ user: { creditBalance: number; monthlyCreditLimit: number; temporaryCreditAdjustment: number } }>(
        `/api/admin/accounts/${designerA.id}/credits`,
        { method: "POST", body: JSON.stringify({ requestId: temporaryRequestId, amount: 500, reason: "本月临时项目补贴" }) },
        admin.cookie,
      );
      expect(temporary.response.status).toBe(200);
      expect(temporary.body.user).toMatchObject({ creditBalance: 1500, monthlyCreditLimit: 1000, temporaryCreditAdjustment: 500 });

      const duplicateTemporary = await api<{ user: { creditBalance: number } }>(
        `/api/admin/accounts/${designerA.id}/credits`,
        { method: "POST", body: JSON.stringify({ requestId: temporaryRequestId, amount: 500, reason: "重复提交" }) },
        admin.cookie,
      );
      expect(duplicateTemporary.body.user.creditBalance).toBe(1500);

      await database.query(
        `UPDATE users SET credit_period_start=(date_trunc('month', timezone('Asia/Shanghai', now())) - interval '1 month')::date
          WHERE id=$1`, [designerA.id],
      );
      const resetSession = await api<{ user: { creditBalance: number; monthlyCreditLimit: number; temporaryCreditAdjustment: number } }>(
        "/api/auth/session", {}, resetLogin.cookie,
      );
      expect(resetSession.body.user).toMatchObject({ creditBalance: 1000, monthlyCreditLimit: 1000, temporaryCreditAdjustment: 0 });
      await api("/api/auth/session", {}, resetLogin.cookie);
      const resetLedger = await database.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM credit_ledger WHERE user_id=$1 AND entry_type='monthly_reset'", [designerA.id],
      );
      expect(Number(resetLedger.rows[0]!.count)).toBe(1);

      const oldReservationId = `old-period-${crypto.randomUUID()}`;
      await database.query(
        `INSERT INTO credit_reservations(request_id,user_id,operation_type,quantity,credits,personal_credits,rmb_cost,price_snapshot,credit_period_start)
         VALUES($1,$2,'image_generation',1,100,100,0,'{}'::jsonb,
           (date_trunc('month', timezone('Asia/Shanghai', now())) - interval '1 month')::date)`,
        [oldReservationId, designerA.id],
      );
      await settleReservation(database, oldReservationId, "release", admin.user.id);
      const afterExpiredRelease = await database.query<{ credit_balance: number }>(
        "SELECT credit_balance FROM users WHERE id=$1", [designerA.id],
      );
      expect(afterExpiredRelease.rows[0]!.credit_balance).toBe(1000);
      const expiredReleaseLedger = await database.query<{ amount: number }>(
        "SELECT amount FROM credit_ledger WHERE request_id=$1", [`${oldReservationId}:user:release`],
      );
      expect(expiredReleaseLedger.rows[0]!.amount).toBe(0);

      await database.query(
        `UPDATE group_credit_periods SET period_start=(date_trunc('month', timezone('Asia/Shanghai', now())) - interval '1 month')::date
          WHERE group_id=$1 AND status='active'`,
        [groupA.body.group.id],
      );
      await database.query(
        `UPDATE group_credit_wallets SET period_start=(date_trunc('month', timezone('Asia/Shanghai', now())) - interval '1 month')::date
          WHERE group_id=$1`,
        [groupA.body.group.id],
      );
      await database.query(
        `UPDATE group_credit_requests SET period_start=(date_trunc('month', timezone('Asia/Shanghai', now())) - interval '1 month')::date
          WHERE group_id=$1 AND period_start=date_trunc('month', timezone('Asia/Shanghai', now()))::date`,
        [groupA.body.group.id],
      );
      const nextGroupPeriod = await api<{ poolBalance: number; wallet: { availableCredits: number } }>(
        "/api/group-credits", {}, memberLogin.cookie,
      );
      expect(nextGroupPeriod.body).toMatchObject({ poolBalance: 120, wallet: { availableCredits: 0 } });
      const closedGroupPeriod = await database.query<{ pool_balance: number; status: string }>(
        `SELECT pool_balance,status FROM group_credit_periods
          WHERE group_id=$1 AND period_start=(date_trunc('month', timezone('Asia/Shanghai', now())) - interval '1 month')::date`,
        [groupA.body.group.id],
      );
      expect(closedGroupPeriod.rows[0]).toMatchObject({ pool_balance: 0, status: "closed" });
      const expiryLedger = await database.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM group_credit_ledger WHERE group_id=$1 AND entry_type='period_expired'",
        [groupA.body.group.id],
      );
      expect(Number(expiryLedger.rows[0]!.count)).toBeGreaterThanOrEqual(2);

      const assetId = crypto.randomUUID();
      await database.query(
        `INSERT INTO assets(id,owner_user_id,department_id,object_key,filename,mime_type,byte_size,kind,source,prompt,status)
         VALUES($1,$2,$3,$4,'event-test.png','image/png',128,'image','generation','完整测试提示词','ready')`,
        [assetId, designerA.id, departmentA, `users/${designerA.id}/integration/${assetId}.png`],
      );
      const candidateKey = `integration-candidate-${crypto.randomUUID()}`;
      const candidate = await api<{ eventId: string; projection: { usabilityScore: number; resultStatus: string; eventCount: number } }>(
        `/api/assets/${assetId}/events`,
        { method: "POST", body: JSON.stringify({ eventType: "asset.candidate_added", idempotencyKey: candidateKey }) },
        resetLogin.cookie,
      );
      expect(candidate.response.status).toBe(201);
      expect(candidate.body.projection).toMatchObject({ usabilityScore: 5, resultStatus: "candidate", eventCount: 1 });
      const duplicateCandidate = await api<{ projection: { usabilityScore: number; eventCount: number } }>(
        `/api/assets/${assetId}/events`,
        { method: "POST", body: JSON.stringify({ eventType: "asset.candidate_added", idempotencyKey: candidateKey }) },
        resetLogin.cookie,
      );
      expect(duplicateCandidate.body.projection).toMatchObject({ usabilityScore: 5, eventCount: 1 });

      const firstDownload = await api<{ projection: { usabilityScore: number; downloadCount: number } }>(
        `/api/assets/${assetId}/download-receipts`,
        { method: "POST", body: JSON.stringify({ idempotencyKey: `integration-download-${crypto.randomUUID()}`, filename: "event-test.png" }) },
        resetLogin.cookie,
      );
      expect(firstDownload.body.projection).toMatchObject({ usabilityScore: 20, downloadCount: 1 });
      const repeatedDownload = await api<{ projection: { usabilityScore: number; downloadCount: number } }>(
        `/api/assets/${assetId}/download-receipts`,
        { method: "POST", body: JSON.stringify({ idempotencyKey: `integration-download-${crypto.randomUUID()}`, filename: "event-test.png" }) },
        resetLogin.cookie,
      );
      expect(repeatedDownload.body.projection).toMatchObject({ usabilityScore: 20, downloadCount: 2 });

      const leaderPending = await api<{ projection: { usabilityScore: number; resultStatus: string } }>(
        `/api/assets/${assetId}/events`,
        { method: "POST", body: JSON.stringify({ eventType: "asset.pending", idempotencyKey: `integration-pending-${crypto.randomUUID()}` }) },
        resetLogin.cookie,
      );
      expect(leaderPending.response.status).toBe(201);
      expect(leaderPending.body.projection).toMatchObject({ usabilityScore: 20, resultStatus: "pending" });
      const managerAdopt = await api<{ eventId: string; projection: { usabilityScore: number; resultStatus: string } }>(
        `/api/assets/${assetId}/events`,
        { method: "POST", body: JSON.stringify({ eventType: "asset.adopted", idempotencyKey: `integration-adopt-${crypto.randomUUID()}` }) },
        employeeLogin.cookie,
      );
      expect(managerAdopt.body.projection).toMatchObject({ usabilityScore: 50, resultStatus: "adopted" });
      const reversed = await api<{ projection: { usabilityScore: number; resultStatus: string } }>(
        `/api/admin/assets/${assetId}/events/${managerAdopt.body.eventId}/reverse`,
        { method: "POST", body: JSON.stringify({ idempotencyKey: `integration-reverse-${crypto.randomUUID()}`, reason: "集成测试纠正" }) },
        admin.cookie,
      );
      expect(reversed.body.projection).toMatchObject({ usabilityScore: 20, resultStatus: "pending" });

      const groupedEvents = await database.query<{ group_id: string | null }>(
        "SELECT DISTINCT group_id FROM asset_events WHERE asset_id=$1 AND event_type<>'asset.event_reversed'",
        [assetId],
      );
      expect(groupedEvents.rows.map((row) => row.group_id)).toEqual([groupA.body.group.id]);

      const updateDirection = await api(
        `/api/performance/assets/${assetId}/direction`,
        { method: "PATCH", body: JSON.stringify({ primaryDirection: "pattern", secondaryDirections: ["apparel"], adminTags: ["重点花型"] }) },
        employeeLogin.cookie,
      );
      expect(updateDirection.response.status).toBe(200);
      const storedDirection = await database.query<{ primary_direction: string; secondary_directions: string[]; admin_direction_tags: string[] }>(
        "SELECT primary_direction,secondary_directions,admin_direction_tags FROM assets WHERE id=$1", [assetId],
      );
      expect(storedDirection.rows[0]).toMatchObject({ primary_direction: "pattern", secondary_directions: ["apparel"], admin_direction_tags: ["重点花型"] });
      const projectDeadline = await api(
        "/api/performance/deadline",
        { method: "PATCH", body: JSON.stringify({ targetType: "project", targetId: projectA.body.project.id, deadlineAt: "2026-07-31T18:00:00+08:00" }) },
        employeeLogin.cookie,
      );
      expect(projectDeadline.response.status).toBe(200);
      const crossDepartmentDeadline = await api<{ error: string }>(
        "/api/performance/deadline",
        { method: "PATCH", body: JSON.stringify({ targetType: "project", targetId: projectB.body.project.id, deadlineAt: "2026-07-31T18:00:00+08:00" }) },
        employeeLogin.cookie,
      );
      expect(crossDepartmentDeadline.response.status).toBe(404);

      const privateReuse = await api<{ error: string }>(
        `/api/assets/${assetId}/events`,
        { method: "POST", body: JSON.stringify({ eventType: "asset.reused", idempotencyKey: `integration-reuse-${crypto.randomUUID()}` }) },
        emailLogin.cookie,
      );
      expect(privateReuse.response.status).toBe(404);
      const companyShare = await api(
        `/api/assets/${assetId}/visibility`,
        { method: "PATCH", body: JSON.stringify({ visibility: "company" }) },
        admin.cookie,
      );
      expect(companyShare.response.status).toBe(204);
      const sharedReuse = await api<{ projection: { usabilityScore: number; resultStatus: string } }>(
        `/api/assets/${assetId}/events`,
        { method: "POST", body: JSON.stringify({ eventType: "asset.reused", idempotencyKey: `integration-reuse-${crypto.randomUUID()}` }) },
        emailLogin.cookie,
      );
      expect(sharedReuse.body.projection).toMatchObject({ usabilityScore: 35, resultStatus: "editing" });
      await api(`/api/assets/${assetId}/visibility`, { method: "PATCH", body: JSON.stringify({ visibility: "private" }) }, admin.cookie);
      const reuseAfterUnshare = await api<{ error: string }>(
        `/api/assets/${assetId}/events`,
        { method: "POST", body: JSON.stringify({ eventType: "asset.reused", idempotencyKey: `integration-reuse-${crypto.randomUUID()}` }) },
        emailLogin.cookie,
      );
      expect(reuseAfterUnshare.response.status).toBe(404);

      const eventRows = await database.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM asset_events WHERE asset_id=$1 AND event_type='asset.candidate_added'",
        [assetId],
      );
      expect(Number(eventRows.rows[0]!.count)).toBe(1);
    } finally {
      await database.end();
    }

    const disableDesignerB = await api(
      `/api/admin/accounts/${designerB.id}`,
      {
        method: "PATCH",
        body: JSON.stringify({ status: "disabled" }),
      },
      admin.cookie,
    );
    expect(disableDesignerB.response.status).toBe(200);
    const disabledSession = await api<{ error: string }>(
      "/api/auth/session",
      {},
      emailLogin.cookie,
    );
    expect(disabledSession.response.status).toBe(401);
    expect(disabledSession.body.error).toBe("SESSION_EXPIRED");

    const disableGroupMember = await api(
      `/api/admin/accounts/${batchMember.id}`,
      { method: "PATCH", body: JSON.stringify({ status: "disabled" }) },
      employeeLogin.cookie,
    );
    expect(disableGroupMember.response.status).toBe(200);
    const groupsAfterDisable = await api<{ groups: Array<{ id: string; members: Array<{ userId: string }> }> }>("/api/admin/groups", {}, employeeLogin.cookie);
    const activeGroup = groupsAfterDisable.body.groups.find((group) => group.id === groupA.body.group.id)!;
    expect(activeGroup.members.map((member) => member.userId)).toEqual([designerA.id]);

    const disableGroup = await api(
      `/api/admin/groups/${groupA.body.group.id}`,
      { method: "PATCH", body: JSON.stringify({ status: "disabled" }) },
      employeeLogin.cookie,
    );
    expect(disableGroup.response.status).toBe(200);
    const verificationDatabase = new Pool({ connectionString: process.env.DATABASE_URL });
    try {
      const closedPeriodsAfterDisable = await verificationDatabase.query<{ active_count: number; remaining_balance: number }>(
        `SELECT count(*) FILTER (WHERE status='active')::int AS active_count,
                coalesce(sum(pool_balance),0)::int AS remaining_balance
           FROM group_credit_periods WHERE group_id=$1`,
        [groupA.body.group.id],
      );
      expect(closedPeriodsAfterDisable.rows[0]).toEqual({ active_count: 0, remaining_balance: 0 });
    } finally {
      await verificationDatabase.end();
    }
    const memberPoolAfterDisable = await api<{ error: string }>("/api/group-credits", {}, resetLogin.cookie);
    expect(memberPoolAfterDisable.response.status).toBe(409);
    expect(memberPoolAfterDisable.body.error).toBe("GROUP_REQUIRED");

    const audit = await api<{ auditLogs: Array<{ action: string }> }>(
      "/api/admin/audit-logs?limit=500",
      {},
      admin.cookie,
    );
    expect(audit.response.status).toBe(200);
    expect(
      audit.body.auditLogs.some(
        (entry) => entry.action === "account.bulk_created",
      ),
    ).toBe(true);
    expect(
      audit.body.auditLogs.some(
        (entry) => entry.action === "auth.password_changed",
      ),
    ).toBe(true);
    expect(
      audit.body.auditLogs.some((entry) => entry.action === "account.updated"),
    ).toBe(true);
    expect(
      audit.body.auditLogs.some(
        (entry) => entry.action === "account.password_reset",
      ),
    ).toBe(true);
    expect(
      audit.body.auditLogs.some(
        (entry) => entry.action === "batch.admin_paused",
      ),
    ).toBe(true);
    expect(
      audit.body.auditLogs.some(
        (entry) => entry.action === "module.availability_changed",
      ),
    ).toBe(true);

    expect(designerA.departmentId).toBe(departmentA);
  }, 180_000);
});
