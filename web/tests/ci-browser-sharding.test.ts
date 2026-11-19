import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const workflow = (name: string) => Bun.YAML.parse(readFileSync(new URL(`../../.github/workflows/${name}.yml`, import.meta.url), "utf8")) as Record<string, any>;

test("every isolated browser shard remains required by the immutable release", () => {
    const production = workflow("production-ci");
    const release = workflow("docker-image");
    const shard = production.jobs["frontend-e2e"];
    expect(shard.strategy).toEqual({ "fail-fast": false, matrix: { shard: [1, 2, 3, 4] } });
    expect(shard.if).toBeUndefined();
    expect(shard["continue-on-error"]).toBeUndefined();
    const run = shard.steps.find((step: { run?: string }) => step.run?.includes("test:e2e"));
    expect(run.run).toBe("bun run test:e2e --shard=${{ matrix.shard }}/4");
    expect(run.if).toBeUndefined();
    expect(run["continue-on-error"]).toBeUndefined();
    const evidence = shard.steps.find((step: { uses?: string }) => step.uses?.startsWith("actions/upload-artifact@"));
    expect(evidence.if).toBe("always()");
    expect(evidence.with.name).toContain("${{ matrix.shard }}");
    expect(release.jobs.verify.uses).toBe("./.github/workflows/production-ci.yml");
    expect(release.jobs.release.needs).toBe("verify");
    expect(release.jobs.release.if).toBeUndefined();
});

test("build, unit and dedicated browser checks run once outside the shards", () => {
    const jobs = workflow("production-ci").jobs;
    const commands = jobs.frontend.steps.map((step: { run?: string }) => step.run).filter(Boolean);
    expect(commands).toContain("bun run build");
    expect(commands).toContain("bun test");
    expect(commands).not.toContain("bun run test:e2e");
    for (const config of ["canvas-production-preload.config.ts", "layer-editor.config.ts"]) {
        expect(commands.some((command: string) => command.includes(config))).toBe(true);
    }
    expect(commands).toContain("npm run test:e2e:image-agent-streaming");
    const config = readFileSync(new URL("../playwright.config.ts", import.meta.url), "utf8");
    expect(config).toContain("fullyParallel: false");
    expect(config).toContain("workers: 1");
    expect(config).toContain("retries: 0");
});
