/** No generic name/prefix can opt an arbitrary instance into destructive test seeding. */
export function assertSmokeProject(env: Record<string, string | undefined>) {
    const project = env.CANVAS_SMOKE_PROJECT || "";
    if (/^ci-release-\d+-\d+-(amd64|arm64)$/.test(project) && (!env.CANVAS_SMOKE_MODE || env.CANVAS_SMOKE_MODE === "ci")) return project;
    const stage = /^canvas-staging-([a-f0-9]{12})-[a-f0-9]{12}$/.exec(project);
    if (stage && env.CANVAS_SMOKE_MODE === "staging" && /^[a-f0-9]{40}$/.test(env.CANVAS_SMOKE_COMMIT || "")
        && env.CANVAS_SMOKE_COMMIT!.startsWith(stage[1]!)) return project;
    throw new Error("Smoke requires an explicit isolated CI or commit-bound staging identity");
}
