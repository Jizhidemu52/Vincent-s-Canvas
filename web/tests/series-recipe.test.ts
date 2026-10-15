import { describe, expect, test } from "bun:test";
import { createRecipeForm, createRecipeRun, buildRecipePrompt, parseRecipeProject, SeriesRecipeRunner, type RecipeDependencies } from "../src/pages/design-workbench/recipe-model";
import { defaultConfig } from "../src/stores/use-config-store";

const reference = { id: "source", name: "garment.png", type: "image/png", dataUrl: "data:image/png;base64,AAAA" };
const makeRun = (count = 3) => createRecipeRun("owner", { ...createRecipeForm(), count }, [reference], defaultConfig);
const dependencies = (generate: RecipeDependencies["generate"]): RecipeDependencies => ({
    generate,
    query: async () => null,
    isCurrent: () => true,
    onChange: async () => {},
    createId: (() => {
        let n = 0;
        return () => `request-${++n}`;
    })(),
});

describe("formal series recipe", () => {
    test("builds distinct reference-aware prompts without inventing a motif", () => {
        const form = { ...createRecipeForm(), kind: "pattern" as const, constraints: "纽扣不变", prompt: "只在指定部位调整" };
        expect(buildRecipePrompt(form, 0, false)).toContain("底图中已有的图案");
        expect(buildRecipePrompt(form, 0, true)).toContain("参考图 2");
        expect(buildRecipePrompt(form, 0, true)).toContain("纽扣不变");
        expect(buildRecipePrompt(form, 0, true)).not.toEqual(buildRecipePrompt(form, 1, true));
    });

    test("submits each real branch once and preserves successful outputs on failed-only retry", async () => {
        const calls: Array<{ prompt: string; requestId: string | undefined; tool: string | undefined; count: string }> = [];
        let shouldFail = true;
        const runner = new SeriesRecipeRunner(
            makeRun(),
            defaultConfig,
            dependencies(async (config, prompt, refs, mask, options) => {
                calls.push({ prompt, requestId: options?.requestId, tool: options?.tool, count: config.count });
                expect(refs[0]?.id).toBe("source");
                expect(mask).toBeUndefined();
                await options?.onSubmissionStarted?.();
                await options?.onSubmitted?.([`task-${calls.length}`]);
                if (calls.length === 2 && shouldFail) {
                    shouldFail = false;
                    throw Object.assign(new Error("provider failed"), { name: "QueuedTaskFailedError", task: { status: "failed" } });
                }
                return [{ id: `image-${calls.length}`, dataUrl: `/api/assets/result-${calls.length}/content`, sourceTaskId: `task-${calls.length}` }];
            }),
        );
        await runner.start();
        expect(runner.snapshot().branches.map((branch) => branch.status)).toEqual(["success", "failed", "success"]);
        const original = runner.snapshot().branches[0]!.images[0]!.dataUrl;
        await runner.start("failed");
        expect(calls.length).toBe(4);
        expect(calls.every((call) => call.tool === "series-recipe" && call.count === "1")).toBe(true);
        expect(new Set(calls.map((call) => call.requestId)).size).toBe(4);
        expect(runner.snapshot().branches[0]!.images[0]!.dataUrl).toBe(original);
        expect(runner.snapshot().branches.map((branch) => branch.attempts)).toEqual([1, 2, 1]);
    });

    test("pause completes the accepted branch but prevents the next submission until resume", async () => {
        let release!: () => void;
        let began!: () => void;
        const started = new Promise<void>((resolve) => {
            began = resolve;
        });
        const blocked = new Promise<void>((resolve) => {
            release = resolve;
        });
        let calls = 0;
        const runner = new SeriesRecipeRunner(
            makeRun(2),
            defaultConfig,
            dependencies(async () => {
                calls++;
                if (calls === 1) {
                    began();
                    await blocked;
                }
                return [{ id: `image-${calls}`, dataUrl: "data:image/png;base64,AAAA", sourceTaskId: "task" }];
            }),
        );
        const running = runner.start();
        await started;
        runner.pause();
        release();
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(calls).toBe(1);
        expect(runner.snapshot().branches[0]!.status).toBe("success");
        runner.resume();
        await running;
        expect(calls).toBe(2);
    });

    test("ambiguous accepted submission can only be queried, never automatically retried", async () => {
        let calls = 0;
        const queried: string[] = [];
        const deps = dependencies(async (_config, _prompt, _refs, _mask, options) => {
            calls++;
            await options?.onSubmissionStarted?.();
            throw new Error("connection lost");
        });
        deps.query = async (_ids, requestId) => {
            queried.push(requestId);
            return { id: "task-original", requestId: `${requestId}:0`, status: "success", resultUrls: ["/api/assets/recovered/content"], failureReason: null };
        };
        const runner = new SeriesRecipeRunner(makeRun(1), defaultConfig, deps);
        await runner.start();
        expect(runner.snapshot().branches[0]!.status).toBe("uncertain");
        await runner.start("failed");
        expect(calls).toBe(1);
        await runner.recover();
        expect(queried).toEqual(["request-1"]);
        expect(calls).toBe(1);
        expect(runner.snapshot().branches[0]!.images[0]!.dataUrl).toBe("/api/assets/recovered/content");
    });

    test("cancel does not submit queued branches or turn accepted work into a retryable failure", async () => {
        let began!: () => void;
        const started = new Promise<void>((resolve) => {
            began = resolve;
        });
        let calls = 0;
        const runner = new SeriesRecipeRunner(
            makeRun(2),
            defaultConfig,
            dependencies(async (_c, _p, _r, _m, options) => {
                calls++;
                await options?.onSubmissionStarted?.();
                began();
                return new Promise((_resolve, reject) => options?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true }));
            }),
        );
        const running = runner.start();
        await started;
        runner.cancel();
        await running;
        expect(calls).toBe(1);
        expect(runner.snapshot().branches.map((branch) => branch.status)).toEqual(["uncertain", "cancelled"]);
        await runner.start("failed");
        expect(calls).toBe(1);
    });

    test("owner changes discard late results and all persistence callbacks", async () => {
        let current = true;
        let release!: () => void;
        let began!: () => void;
        let writes = 0;
        const started = new Promise<void>((resolve) => {
            began = resolve;
        });
        const deps = dependencies(async () => {
            began();
            await new Promise<void>((resolve) => {
                release = resolve;
            });
            return [{ id: "late", dataUrl: "data:image/png;base64,AAAA", sourceTaskId: "task" }];
        });
        deps.isCurrent = () => current;
        deps.onChange = async () => {
            writes++;
        };
        const runner = new SeriesRecipeRunner(makeRun(2), defaultConfig, deps);
        const running = runner.start();
        await started;
        const before = writes;
        current = false;
        release();
        await running;
        expect(writes).toBe(before);
        expect(runner.snapshot().branches[0]!.images).toEqual([]);
    });

    test("import strips credentials and cannot recover another employee's submitted tasks", () => {
        const run = makeRun(1);
        run.branches[0]!.status = "running";
        run.branches[0]!.requestId = "old-request";
        run.branches[0]!.submissionStarted = true;
        const project = parseRecipeProject({ version: 1, kind: "series-recipe", ownerId: "old-owner", form: createRecipeForm(), references: [reference], settings: { ...defaultConfig, apiKey: "secret" }, run }, "new-owner", true);
        expect(JSON.stringify(project)).not.toContain("secret");
        expect(project.run?.branches[0]?.status).toBe("cancelled");
        expect(project.run?.branches[0]?.requestId).toBeUndefined();
        expect(() => parseRecipeProject({ ...project, references: [{ ...reference, dataUrl: "https://attacker.test/image" }] }, "new-owner", true)).toThrow();
    });
});
