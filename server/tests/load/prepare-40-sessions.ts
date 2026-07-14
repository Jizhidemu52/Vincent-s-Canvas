export {};

const baseUrl = process.env.LOAD_PREP_BASE_URL ?? "http://127.0.0.1:3100";
const outputPath = process.env.LOAD_CONFIG_PATH ?? "/tmp/load-config.json";
const adminInitialPassword =
  process.env.BOOTSTRAP_ADMIN_PASSWORD ?? "ComposeAdmin2026";
const adminReadyPassword = "ComposeAdminReady2026";
const designerInitialPassword = "DesignerLoadStart2026";
const designerReadyPassword = "DesignerLoadReady2026";

type ApiResult<T> = { response: Response; body: T | null };

async function api<T>(
  path: string,
  options: RequestInit = {},
  cookie?: string,
): Promise<ApiResult<T>> {
  const headers = new Headers(options.headers);
  if (options.body && !headers.has("content-type"))
    headers.set("content-type", "application/json");
  if (cookie) headers.set("cookie", cookie);
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers,
    redirect: "manual",
  });
  const text = await response.text();
  const body = text ? (JSON.parse(text) as T) : null;
  return { response, body };
}

function assertStatus<T>(
  result: ApiResult<T>,
  expected: number,
  action: string,
): asserts result is ApiResult<T> & { body: T } {
  if (result.response.status !== expected) {
    throw new Error(
      `${action} failed (${result.response.status}): ${JSON.stringify(result.body)}`,
    );
  }
}

function sessionCookie(response: Response) {
  const value = response.headers.get("set-cookie")?.split(";", 1)[0];
  if (!value)
    throw new Error("Login response did not include a session cookie");
  return value;
}

async function login(
  identifier: string,
  password: string,
  portal: "designer" | "admin",
) {
  const result = await api<{ user: { id: string } }>("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ identifier, password, portal }),
  });
  assertStatus(result, 200, `Login for ${identifier}`);
  return {
    cookie: sessionCookie(result.response),
    userId: result.body.user.id,
  };
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
  assertStatus(result, 204, "Password change");
}

const adminLogin = await login("admin", adminInitialPassword, "admin");
let adminCookie = adminLogin.cookie;
await changePassword(adminCookie, adminInitialPassword, adminReadyPassword);

const departmentResult = await api<{ department: { id: string } }>(
  "/api/admin/departments",
  {
    method: "POST",
    body: JSON.stringify({ name: "40人并发验证部门", code: "load-40" }),
  },
  adminCookie,
);
assertStatus(departmentResult, 201, "Load-test department creation");

const providerResult = await api<{ provider: { id: string } }>(
  "/api/admin/model-configuration/providers",
  {
    method: "POST",
    body: JSON.stringify({
      name: "CI Mock Provider",
      protocol: "custom",
      baseUrl: "http://mock.invalid",
      enabled: true,
    }),
  },
  adminCookie,
);
assertStatus(providerResult, 201, "Mock provider creation");

const modelResult = await api<{ model: { id: string } }>(
  "/api/admin/model-configuration/models",
  {
    method: "POST",
    body: JSON.stringify({
      providerId: providerResult.body.provider.id,
      name: "40人并发模拟出图模型",
      modelId: "ci-load-image-v1",
      capabilities: ["generate", "batch"],
      creditCost: 2,
      rmbCost: 0.2,
      concurrencyLimit: 40,
      enabled: true,
    }),
  },
  adminCookie,
);
assertStatus(modelResult, 201, "Mock model creation");

const accounts = Array.from({ length: 40 }, (_, index) => {
  const number = String(index + 1).padStart(2, "0");
  return {
    username: `压测设计师${number}`,
    displayName: `并发设计师 ${number}`,
    email: `load-designer-${number}@company.test`,
    employeeNo: `LOAD-${number}`,
    password: designerInitialPassword,
    role: "designer",
    departmentId: departmentResult.body.department.id,
    creditBalance: 10_000,
    creditLimit: 10_000,
  };
});
const bulkResult = await api<{ created: number; failures: unknown[] }>(
  "/api/admin/accounts/bulk",
  {
    method: "POST",
    body: JSON.stringify({ accounts }),
  },
  adminCookie,
);
assertStatus(bulkResult, 201, "40-account import");
if (bulkResult.body.created !== 40 || bulkResult.body.failures.length !== 0) {
  throw new Error(
    `Expected 40 imported accounts: ${JSON.stringify(bulkResult.body)}`,
  );
}

const designerSessions = await Promise.all(
  accounts.map(async (account) => {
    const loginResult = await login(
      account.username,
      designerInitialPassword,
      "designer",
    );
    await changePassword(
      loginResult.cookie,
      designerInitialPassword,
      designerReadyPassword,
    );
    return loginResult;
  }),
);
const sessionCookies = designerSessions.map((session) => session.cookie);

await Bun.write(
  outputPath,
  JSON.stringify({
    modelConfigId: modelResult.body.model.id,
    adminCookie,
    sessionCookies,
    userIds: designerSessions.map((session) => session.userId),
  }),
);

console.log(
  `Prepared ${sessionCookies.length} designer sessions and one enabled mock model`,
);
