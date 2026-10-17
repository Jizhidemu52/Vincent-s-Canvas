import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
    QueuedTaskFailedError,
    QueuedTaskPausedError,
    QueuedTaskSubmissionUncertainError,
    requestQueuedMedia,
    submitQueuedMediaTask,
    type QueuedMediaInput,
    type QueuedTask,
} from "@/services/api/generation-tasks";
import { useUserStore } from "@/stores/use-user-store";

const originalFetch = globalThis.fetch;
const globals = globalThis as unknown as Record<string, unknown>;
const originalWindow = globals.window;
const originalUserState = useUserStore.getState();
const model = { id: "media-model", name: "Media model", modelId: "media-model", capabilities: ["video", "audio"], creditCost: 1, rmbCost: 1 };
const operations = ["video_generation", "audio_generation"] as const;
type Operation = typeof operations[number];
type CapturedRequest = { path: string; method: string; body?: Record<string, unknown>; signal?: AbortSignal | null };
type ResponseHandler = (request: CapturedRequest) => Response | Promise<Response>;
let requests: CapturedRequest[];
let startedIds: string[];

const taskPosts = () => requests.filter(request => request.path === "/api/tasks" && request.method === "POST");
const polls = () => requests.filter(request => request.path === "/api/tasks/media-task" && request.method === "GET");
const cancellations = () => requests.filter(request => request.path === "/api/tasks/media-task/cancel" && request.method === "POST");

beforeEach(() => {
    requests = [];
    startedIds = [];
    globals.window = { location: { pathname: "/canvas/project" }, setTimeout, clearTimeout };
    useUserStore.setState({
        user: { id: "employee-a", role: "designer", status: "active" } as never,
        status: "authenticated",
        // Balance refresh is deliberately inert: every possible HTTP request remains in this fixture.
        hydrateSession: async () => undefined,
    });
    globalThis.fetch = (async url => { throw new Error(`Unexpected real-network attempt: ${String(url)}`); }) as typeof fetch;
});

afterEach(() => {
    try {
        // This invariant applies to every success, rejection, cancellation and uncertainty case below.
        expect(taskPosts().length).toBeLessThanOrEqual(1);
        if (taskPosts().length) {
            const requestId = taskPosts()[0]!.body?.requestId;
            expect(typeof requestId).toBe("string");
            expect(String(requestId).length).toBeGreaterThan(0);
            expect(startedIds).toEqual([requestId]);
            const preflight = requests.find(request => request.path === "/api/tasks/preflight");
            if (preflight) expect(preflight.body?.requestId).toBe(requestId);
        }
    } finally {
        globalThis.fetch = originalFetch;
        globals.window = originalWindow;
        useUserStore.setState(originalUserState);
    }
});

function input(operationType: Operation, overrides: Partial<QueuedMediaInput> = {}): QueuedMediaInput {
    const { onSubmissionStarted, ...rest } = overrides;
    return {
        modelId: model.id,
        resolvedModel: model,
        prompt: "offline media test",
        operationType,
        ...rest,
        onSubmissionStarted: async requestId => {
            startedIds.push(requestId);
            await onSubmissionStarted?.(requestId);
        },
    };
}

function task(patch: Partial<QueuedTask> = {}): QueuedTask {
    return {
        id: "media-task",
        requestId: String(taskPosts()[0]?.body?.requestId || "missing-submission-id"),
        status: "success",
        resultUrls: ["/api/assets/media-result/content"],
        failureReason: null,
        ...patch,
    };
}

function network(handlers: { submit?: ResponseHandler; poll?: ResponseHandler; cancel?: ResponseHandler } = {}) {
    globalThis.fetch = (async (url, init) => {
        const request: CapturedRequest = {
            path: String(url), method: init?.method || "GET", signal: init?.signal,
            ...(typeof init?.body === "string" ? { body: JSON.parse(init.body) } : {}),
        };
        requests.push(request);
        if (request.path === "/api/tasks/preflight") return Response.json({ ok: true, normalized: { seconds: 5 } });
        if (request.path === "/api/tasks" && request.method === "POST") {
            if (taskPosts().length > 1) throw new Error("A second paid task POST is forbidden");
            return handlers.submit ? handlers.submit(request) : Response.json({ task: task({ status: "queued", resultUrls: [] }) });
        }
        if (request.path === "/api/tasks/media-task" && request.method === "GET") return handlers.poll ? handlers.poll(request) : Response.json({ task: task() });
        if (request.path === "/api/tasks/media-task/cancel" && request.method === "POST") return handlers.cancel ? handlers.cancel(request) : Response.json({ changed: 1 });
        throw new Error(`Unexpected mocked HTTP ${request.method} ${request.path}`);
    }) as typeof fetch;
}

async function rejected(pending: Promise<unknown>): Promise<unknown> {
    try { await pending; }
    catch (error) { return error; }
    throw new Error("Expected the media request to reject");
}

function expectUncertain(error: unknown, knownTask = false) {
    expect(error).toBeInstanceOf(QueuedTaskSubmissionUncertainError);
    expect(error).toMatchObject({ name: "QueuedTaskSubmissionUncertainError", requestId: taskPosts()[0]!.body!.requestId });
    expect((error as QueuedTaskSubmissionUncertainError).taskId).toBe(knownTask ? "media-task" : undefined);
    expect(taskPosts()).toHaveLength(1);
}

describe("media submission boundaries before the task POST", () => {
    test.each(operations)("already-aborted %s remains an ordinary AbortError without any request", async operation => {
        network();
        const controller = new AbortController();
        controller.abort();
        const error = await rejected(submitQueuedMediaTask(input(operation, { signal: controller.signal })));
        expect(error).toMatchObject({ name: "AbortError" });
        expect(error).not.toBeInstanceOf(QueuedTaskSubmissionUncertainError);
        expect(requests).toEqual([]);
        expect(startedIds).toEqual([]);
    });

    test.each(operations)("%s awaits submission preparation and passes the exact payload requestId", async operation => {
        network();
        const entered = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        const pending = submitQueuedMediaTask(input(operation, { onSubmissionStarted: async () => { entered.resolve(); await release.promise; } }));
        await entered.promise;
        expect(taskPosts()).toEqual([]);
        expect(startedIds).toHaveLength(1);
        release.resolve();
        expect((await pending).id).toBe("media-task");
        expect(taskPosts()).toHaveLength(1);
        expect(taskPosts()[0]!.body!.requestId).toBe(startedIds[0]);
        if (operation === "video_generation") expect(taskPosts()[0]!.body!.parameters).toMatchObject({ seconds: 5 });
    });

    test.each(operations)("%s preparation hook rejection stays the original error and never POSTs", async operation => {
        network();
        const failure = new Error("local pending-state persistence failed");
        const error = await rejected(submitQueuedMediaTask(input(operation, { onSubmissionStarted: async () => { throw failure; } })));
        expect(error).toBe(failure);
        expect(error).not.toBeInstanceOf(QueuedTaskSubmissionUncertainError);
        expect(taskPosts()).toEqual([]);
        expect(startedIds).toHaveLength(1);
    });

    test.each(operations)("%s cancelled inside preparation stays AbortError and never POSTs", async operation => {
        network();
        const controller = new AbortController();
        const error = await rejected(submitQueuedMediaTask(input(operation, {
            signal: controller.signal,
            onSubmissionStarted: async () => { await Promise.resolve(); controller.abort(); },
        })));
        expect(error).toMatchObject({ name: "AbortError" });
        expect(error).not.toBeInstanceOf(QueuedTaskSubmissionUncertainError);
        expect(taskPosts()).toEqual([]);
        expect(startedIds).toHaveLength(1);
    });
});

describe("unacknowledged media submissions retain request identity", () => {
    const failures: Array<{ label: string; submit: ResponseHandler }> = [
        { label: "network rejection", submit: () => { throw new TypeError("connection lost after POST"); } },
        { label: "HTTP 408", submit: () => Response.json({ message: "request timed out" }, { status: 408 }) },
        { label: "HTTP 500", submit: () => Response.json({ message: "server failed after acceptance" }, { status: 500 }) },
        { label: "HTTP 503 with invalid JSON", submit: () => new Response("upstream unavailable", { status: 503 }) },
        { label: "successful response with broken JSON", submit: () => new Response("{", { status: 200, headers: { "content-type": "application/json" } }) },
        { label: "successful response without task", submit: () => Response.json({}) },
        { label: "successful response without task.id", submit: () => Response.json({ task: { status: "queued" } }) },
        { label: "successful response with empty task.id", submit: () => Response.json({ task: { id: "" } }) },
    ];
    for (const operation of operations) {
        for (const failure of failures) {
            test(`${operation}: ${failure.label} never retries the POST`, async () => {
                network({ submit: failure.submit });
                const error = await rejected(requestQueuedMedia(input(operation)));
                expectUncertain(error);
                expect(polls()).toEqual([]);
                expect(cancellations()).toEqual([]);
            });
        }
    }

    test.each(operations)("%s aborted during the POST remains uncertain without a fabricated taskId", async operation => {
        const controller = new AbortController();
        network({ submit: request => {
            expect(request.signal).toBe(controller.signal);
            controller.abort();
            throw new DOMException("POST interrupted", "AbortError");
        } });
        const error = await rejected(requestQueuedMedia(input(operation, { signal: controller.signal })));
        expectUncertain(error);
        expect(polls()).toEqual([]);
        expect(cancellations()).toEqual([]);
    });

    for (const operation of operations) {
        test.each([400, 401, 403, 404, 409, 413, 422, 429])(`${operation}: explicit HTTP %s rejection is not uncertain`, async status => {
            network({ submit: () => Response.json({ message: `rejected-${status}` }, { status }) });
            const error = await rejected(requestQueuedMedia(input(operation)));
            expect(error).toBeInstanceOf(Error);
            expect(error).not.toBeInstanceOf(QueuedTaskSubmissionUncertainError);
            expect((error as Error).message).toContain(`rejected-${status}`);
            expect(taskPosts()).toHaveLength(1);
            expect(polls()).toEqual([]);
            expect(cancellations()).toEqual([]);
        });
    }
});

describe("acknowledged media tasks retain their original taskId", () => {
    const pollFailures: Array<{ label: string; poll: ResponseHandler }> = [
        { label: "network loss", poll: () => { throw new TypeError("poll disconnected"); } },
        { label: "HTTP 500", poll: () => Response.json({ message: "query temporarily unavailable" }, { status: 500 }) },
        { label: "HTTP 404", poll: () => Response.json({ message: "not currently visible" }, { status: 404 }) },
        { label: "malformed response", poll: () => new Response("{", { status: 200 }) },
    ];
    for (const operation of operations) {
        for (const failure of pollFailures) {
            test(`${operation}: ${failure.label} while polling is uncertain, not a new generation`, async () => {
                network({ poll: failure.poll });
                const acknowledged: string[] = [];
                const error = await rejected(requestQueuedMedia(input(operation, { onSubmitted: accepted => { acknowledged.push(accepted.id); } })));
                expectUncertain(error, true);
                expect(acknowledged).toEqual(["media-task"]);
                expect(polls()).toHaveLength(1);
                expect(cancellations()).toEqual([]);
            });
        }
    }

    test.each(operations)("%s awaits the acknowledgement hook before polling", async operation => {
        network();
        const entered = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        const pending = requestQueuedMedia(input(operation, { onSubmitted: async accepted => {
            expect(accepted.id).toBe("media-task");
            entered.resolve();
            await release.promise;
        } }));
        await entered.promise;
        expect(taskPosts()).toHaveLength(1);
        expect(polls()).toEqual([]);
        release.resolve();
        expect(await pending).toEqual(["/api/assets/media-result/content"]);
        expect(polls()).toHaveLength(1);
    });

    for (const operation of operations) {
        test.each([false, true])(`${operation}: acknowledgement hook rejection (async=%s) preserves accepted task identity`, async asynchronous => {
            network();
            const failure = new Error("accepted task could not be persisted locally");
            const error = await rejected(requestQueuedMedia(input(operation, {
                onSubmitted: asynchronous ? async () => { await Promise.resolve(); throw failure; } : () => { throw failure; },
            })));
            expectUncertain(error, true);
            expect(polls()).toEqual([]);
            expect(cancellations()).toEqual([]);
        });
    }

    for (const operation of operations) {
        test.each(["failed", "cancelled"])(`${operation}: confirmed %s remains QueuedTaskFailedError`, async status => {
            network({ poll: () => Response.json({ task: task({ status, resultUrls: [], failureReason: `confirmed-${status}` }) }) });
            const error = await rejected(requestQueuedMedia(input(operation)));
            expect(error).toBeInstanceOf(QueuedTaskFailedError);
            expect(error).not.toBeInstanceOf(QueuedTaskSubmissionUncertainError);
            expect((error as QueuedTaskFailedError).task).toMatchObject({ id: "media-task", status, failureReason: `confirmed-${status}` });
            expect(taskPosts()).toHaveLength(1);
            expect(polls()).toHaveLength(1);
            expect(cancellations()).toEqual([]);
        });

        test.each([false, true])(`${operation}: paused task (upstream known=%s) remains QueuedTaskPausedError`, async upstreamKnown => {
            network({ poll: () => Response.json({ task: task({ status: "paused", resultUrls: [], upstreamTaskId: upstreamKnown ? "upstream-task" : null }) }) });
            const error = await rejected(requestQueuedMedia(input(operation)));
            expect(error).toBeInstanceOf(QueuedTaskPausedError);
            expect(error).not.toBeInstanceOf(QueuedTaskSubmissionUncertainError);
            expect(error).toMatchObject({ taskId: "media-task", canRecover: upstreamKnown });
            expect(taskPosts()).toHaveLength(1);
            expect(polls()).toHaveLength(1);
            expect(cancellations()).toEqual([]);
        });
    }
});

describe("media cancellation requires a confirmed original-task cancellation", () => {
    test.each(operations)("%s abort after acknowledgement remains AbortError only after cancellation succeeds", async operation => {
        const controller = new AbortController();
        network({ cancel: request => {
            // The cancellation must remain sendable after the generation signal has been aborted.
            expect(request.signal?.aborted).not.toBe(true);
            return Response.json({ changed: 1 });
        } });
        const error = await rejected(requestQueuedMedia(input(operation, {
            signal: controller.signal,
            onSubmitted: async () => { await Promise.resolve(); controller.abort(); },
        })));
        expect(error).toMatchObject({ name: "AbortError" });
        expect(error).not.toBeInstanceOf(QueuedTaskSubmissionUncertainError);
        expect(taskPosts()).toHaveLength(1);
        expect(cancellations()).toHaveLength(1);
        expect(polls()).toEqual([]);
    });

    for (const operation of operations) {
        test.each(["network", "HTTP 500"])(`${operation}: failed cancellation (%s) is uncertain and preserves taskId`, async failure => {
            const controller = new AbortController();
            network({ cancel: () => {
                if (failure === "network") throw new TypeError("cancel response lost");
                return Response.json({ message: "cancel unavailable" }, { status: 500 });
            } });
            const error = await rejected(requestQueuedMedia(input(operation, {
                signal: controller.signal,
                onSubmitted: () => { controller.abort(); },
            })));
            expectUncertain(error, true);
            expect(cancellations()).toHaveLength(1);
            expect(polls()).toEqual([]);
        });
    }

    test.each(operations)("%s abort during a poll cancels the same accepted task without resubmission", async operation => {
        const controller = new AbortController();
        network({ poll: request => {
            expect(request.signal).toBe(controller.signal);
            controller.abort();
            throw new DOMException("poll interrupted", "AbortError");
        } });
        const error = await rejected(requestQueuedMedia(input(operation, { signal: controller.signal })));
        expect(error).toMatchObject({ name: "AbortError" });
        expect(error).not.toBeInstanceOf(QueuedTaskSubmissionUncertainError);
        expect(taskPosts()).toHaveLength(1);
        expect(polls()).toHaveLength(1);
        expect(cancellations()).toHaveLength(1);
    });
});
