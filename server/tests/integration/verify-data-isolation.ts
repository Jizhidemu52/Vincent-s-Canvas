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
  api<{ history: Array<{ userId: string }> }>(
    "/api/admin/history",
    config.adminCookie,
  ),
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
  ![userA, userB].every((userId) =>
    adminAssets.body.assets.some((item) => item.ownerUserId === userId),
  )
)
  throw new Error("Admin asset view is missing designer data");

console.log(
  "Verified designer task/history/asset isolation and super-admin visibility",
);
