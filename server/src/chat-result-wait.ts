import type { ChatCompletionResult } from "./routes/chat";

export const CHAT_RESULT_TIMEOUT_MS = 180_000;
export const CARBON_RESULT_TIMEOUT_MS = 600_000;
export type ChatResultTimeout = typeof CHAT_RESULT_TIMEOUT_MS | typeof CARBON_RESULT_TIMEOUT_MS;
type ChatResultWaitFailure = { code: string; message: string; repairable?: true; submitted?: false };

export function chatResultTimeoutMs(model: { model_id: string }, input: { privateProfile?: boolean; waitForResult?: boolean }): ChatResultTimeout {
    return input.privateProfile === true && input.waitForResult === true && model.model_id === "gemini-4-carbon"
        ? CARBON_RESULT_TIMEOUT_MS : CHAT_RESULT_TIMEOUT_MS;
}

export function acceptsChatResultWait(accept: string | undefined | null, privateProfile: boolean | undefined) {
    return privateProfile === true && Boolean(accept?.split(",").some(value => value.trim().split(";")[0]?.toLowerCase() === "text/event-stream"));
}

export const chatResultWaitHeaders = {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-store, no-transform",
    "x-accel-buffering": "no",
};

export type ChatResultWaitClock = {
    now: () => number;
    every: (callback: () => void, milliseconds: number) => () => void;
};

const systemClock: ChatResultWaitClock = {
    now: () => performance.now(),
    every: (callback, milliseconds) => {
        const timer = setInterval(callback, milliseconds);
        return () => clearInterval(timer);
    },
};

export function startChatResultWait(write: (value: string) => void, clock: ChatResultWaitClock = systemClock) {
    const startedAt = clock.now();
    let closed = false;
    let stop = () => {};
    const send = (event: string, data: unknown) => { if (!closed) write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
    const close = () => { closed = true; stop(); };
    const waiting = () => send("chat_waiting", { type: "chat_waiting", message: clock.now() - startedAt >= CHAT_RESULT_TIMEOUT_MS
        ? "模型仍在处理原请求，已超过 180 秒；正在继续等待同一请求，不会重新提交。"
        : "正在等待模型完成当前请求，不会重复提交。" });
    waiting();
    stop = clock.every(waiting, 15_000);
    return {
        close,
        complete(result: ChatCompletionResult) {
            const { usage: _internalUsage, ...publicResult } = result;
            send("chat_result", { type: "chat_result", result: publicResult });
            close();
        },
        fail(error: ChatResultWaitFailure) {
            send("error", { type: "error", error });
            close();
        },
    };
}

export function chatResultWaitResponse(run: () => Promise<ChatCompletionResult>, failure: (error: unknown) => ChatResultWaitFailure, clock?: ChatResultWaitClock) {
    const encoder = new TextEncoder();
    let cancelled = false;
    let waiting: ReturnType<typeof startChatResultWait>;
    const body = new ReadableStream<Uint8Array>({
        start(controller) {
            waiting = startChatResultWait(value => controller.enqueue(encoder.encode(value)), clock);
            void Promise.resolve().then(run).then(result => waiting.complete(result), error => waiting.fail(failure(error)))
                .finally(() => { waiting.close(); if (!cancelled) controller.close(); });
        },
        cancel() { cancelled = true; waiting.close(); },
    });
    return new Response(body, { headers: chatResultWaitHeaders });
}
