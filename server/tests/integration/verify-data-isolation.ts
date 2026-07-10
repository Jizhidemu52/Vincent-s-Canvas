export {};

const baseUrl = process.env.ISOLATION_BASE_URL ?? "http://127.0.0.1:3100";
const configPath = process.env.LOAD_CONFIG_PATH ?? "/tmp/load-config.json";
const config = JSON.parse(await Bun.file(configPath).text()) as {
  adminCookie: string;
  sessionCookies: string[];
  userIds: string[];
};

if (config.sessionCookies.length < 2 || config.userIds.length < 2)
  throw new Error(
    "Isolation verification needs at least two designer sessions",
  );

async function api<T>(path: string, cookie: string) {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: { cookie },
    redirect: "manual",
  });
  const contentType = response.headers.get("content-type") || "";
  const body = (
    contentType.includes("application/json")
      ? await response.json()
      : await response.arrayBuffer()
  ) as T;
  return { response, body };
}

const [cookieA, cookieB] = config.sessionCookies;
const [userA, userB] = config.userIds;
const [tasksA, tasksB, historyA, historyB, assetsA, assetsB] =
  await Promise.all([
    api<{ tasks: Array<{ id: string; userId: string }> }>(
      "/api/tasks",
      cookieA!,
    ),
    api<{ tasks: Array<{ id: string; userId: string }> }>(
      "/api/tasks",
      cookieB!,
    ),
    api<{ history: Array<{ id: string; userId: string }> }>(
      "/api/history",
      cookieA!,
    ),
    api<{ history: Array<{ id: string; userId: string }> }>(
      "/api/history",
      cookieB!,
    ),
    api<{ assets: Array<{ id: string; ownerUserId: string }> }>(
      "/api/assets",
      cookieA!,
    ),
    api<{ assets: Array<{ id: string; ownerUserId: string }> }>(
      "/api/assets",
      cookieB!,
    ),
  ]);

for (const [label, result] of Object.entries({
  tasksA,
  tasksB,
  historyA,
  historyB,
  assetsA,
  assetsB,
})) {
  if (result.response.status !== 200)
    throw new Error(`${label} returned ${result.response.status}`);
}
if (
  !tasksA.body.tasks.length ||
  !tasksB.body.tasks.length ||
  !historyA.body.history.length ||
  !historyB.body.history.length ||
  !assetsA.body.assets.length ||
  !assetsB.body.assets.length
) {
  throw new Error(
    "Load test did not produce enough per-user data for isolation verification",
  );
}
if (
  !tasksA.body.tasks.every((item) => item.userId === userA) ||
  !tasksB.body.tasks.every((item) => item.userId === userB)
)
  throw new Error("Task list crossed designer boundaries");
if (
  !historyA.body.history.every((item) => item.userId === userA) ||
  !historyB.body.history.every((item) => item.userId === userB)
)
  throw new Error("History list crossed designer boundaries");
if (
  !assetsA.body.assets.every((item) => item.ownerUserId === userA) ||
  !assetsB.body.assets.every((item) => item.ownerUserId === userB)
)
  throw new Error("Asset list crossed designer boundaries");

const foreignAssetId = assetsB.body.assets[0]!.id;
const blockedContent = await api<ArrayBuffer>(
  `/api/assets/${foreignAssetId}/content`,
  cookieA!,
);
if (blockedContent.response.status !== 404)
  throw new Error(
    `Designer A accessed designer B asset content (${blockedContent.response.status})`,
  );
const ownerContent = await api<ArrayBuffer>(
  `/api/assets/${foreignAssetId}/content`,
  cookieB!,
);
if (ownerContent.response.status !== 200 || ownerContent.body.byteLength === 0)
  throw new Error("Designer B could not read their own generated asset");

const [adminTasks, adminHistory, adminAssets] = await Promise.all([
  api<{ tasks: Array<{ userId: string }> }>(
    "/api/admin/tasks",
    config.adminCookie,
  ),
  api<{
    history: Array<{ userId: string }>;
    total: number;
    totalCredits: number;
    totalRmbCost: number;
    page: number;
    pageSize: number;
  }>("/api/admin/history", config.adminCookie),
  api<{ assets: Array<{ ownerUserId: string }> }>(
    "/api/admin/assets",
    config.adminCookie,
  ),
]);
if (
  ![adminTasks, adminHistory, adminAssets].every(
    (result) => result.response.status === 200,
  )
)
  throw new Error("Super administrator could not read global operational data");
if (
  ![userA, userB].every((userId) =>
    adminTasks.body.tasks.some((item) => item.userId === userId),
  )
)
  throw new Error("Admin task view is missing designer data");
if (
  ![userA, userB].every((userId) =>
    adminHistory.body.history.some((item) => item.userId === userId),
  )
)
  throw new Error("Admin history view is missing designer data");
if (
  adminHistory.body.total < adminHistory.body.history.length ||
  adminHistory.body.totalCredits <= 0 ||
  adminHistory.body.totalRmbCost < 0 ||
  adminHistory.body.page !== 1 ||
  adminHistory.body.pageSize !== 50
)
  throw new Error("Admin history pagination metadata is invalid");
if (
  ![userA, userB].every((userId) =>
    adminAssets.body.assets.some((item) => item.ownerUserId === userId),
  )
)
  throw new Error("Admin asset view is missing designer data");

const firstHistoryPage = await api<{
  history: Array<{
    id: string;
    userId: string;
    projectId: string;
    operationType: string;
  }>;
  total: number;
  page: number;
  pageSize: number;
}>(
  `/api/admin/history?userId=${userA}&projectId=load-test&operationType=image_generation&from=2020-01-01T00%3A00%3A00.000Z&to=2030-01-01T00%3A00%3A00.000Z&page=1&pageSize=1`,
  config.adminCookie,
);
if (
  firstHistoryPage.response.status !== 200 ||
  firstHistoryPage.body.page !== 1 ||
  firstHistoryPage.body.pageSize !== 1 ||
  firstHistoryPage.body.total < 2 ||
  firstHistoryPage.body.history.length !== 1 ||
  firstHistoryPage.body.history[0]?.userId !== userA ||
  firstHistoryPage.body.history[0]?.projectId !== "load-test" ||
  firstHistoryPage.body.history[0]?.operationType !== "image_generation"
) {
  throw new Error("Admin history combined filters or first page are invalid");
}
const secondHistoryPage = await api<{
  history: Array<{ id: string; userId: string }>;
  total: number;
  page: number;
  pageSize: number;
}>(`/api/admin/history?userId=${userA}&page=2&pageSize=1`, config.adminCookie);
if (
  secondHistoryPage.response.status !== 200 ||
  secondHistoryPage.body.page !== 2 ||
  secondHistoryPage.body.history.length !== 1 ||
  secondHistoryPage.body.history[0]?.userId !== userA ||
  secondHistoryPage.body.history[0]?.id === firstHistoryPage.body.history[0]?.id
) {
  throw new Error("Admin history second page is invalid");
}
const invalidHistoryTime = await api<{ error: string }>(
  "/api/admin/history?from=not-a-date",
  config.adminCookie,
);
if (
  invalidHistoryTime.response.status !== 400 ||
  invalidHistoryTime.body.error !== "VALIDATION_ERROR"
)
  throw new Error("Admin history accepted an invalid date filter");

const historyOptions = await api<{
  users: Array<{ value: string }>;
  models: Array<{ value: string }>;
  operations: Array<{ value: string }>;
}>("/api/admin/history/options", config.adminCookie);
if (
  historyOptions.response.status !== 200 ||
  ![userA, userB].every((userId) =>
    historyOptions.body.users.some((item) => item.value === userId),
  ) ||
  !historyOptions.body.operations.some(
    (item) => item.value === "image_generation",
  )
) {
  throw new Error("Admin history filter options are incomplete");
}

const exportedHistory = await api<ArrayBuffer>(
  `/api/admin/history/export?userId=${userA}&projectId=load-test`,
  config.adminCookie,
);
if (
  exportedHistory.response.status !== 200 ||
  !exportedHistory.response.headers.get("content-type")?.includes("text/csv") ||
  exportedHistory.body.byteLength === 0
) {
  throw new Error("Admin history CSV export failed");
}
const auditAfterExport = await api<{
  auditLogs: Array<{ action: string; detail: { rowCount?: number } }>;
}>("/api/admin/audit-logs?limit=20", config.adminCookie);
if (
  auditAfterExport.response.status !== 200 ||
  !auditAfterExport.body.auditLogs.some(
    (entry) =>
      entry.action === "history.exported" && Number(entry.detail.rowCount) > 0,
  )
) {
  throw new Error("Admin history export was not audited");
}

console.log(
  "Verified data isolation, paginated history filters and audited CSV export",
);
