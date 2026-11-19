import { expect, test } from "bun:test";
import { acceptsChatResultWait, chatResultTimeoutMs, chatResultWaitResponse, startChatResultWait, type ChatResultWaitClock } from "../src/chat-result-wait";

function clock() {
    let elapsed = 0;
    const intervals = new Map<() => void, number>();
    const value: ChatResultWaitClock = { now: () => elapsed, every: (callback, milliseconds) => {
        intervals.set(callback, milliseconds);
        return () => { intervals.delete(callback); };
    } };
    return { value, intervals, tick: (milliseconds: number) => { elapsed += milliseconds; for (const callback of intervals.keys()) callback(); } };
}

test("waiting is explicitly negotiated for private profiles and only Carbon gets a longer fixed budget", () => {
    const carbon = { model_id: "gemini-4-carbon" };
    expect(acceptsChatResultWait("application/json, text/event-stream; charset=utf-8", true)).toBe(true);
    for (const accept of [undefined, null, "", "*/*", "application/json", "not-text/event-stream"]) expect(acceptsChatResultWait(accept, true)).toBe(false);
    expect(acceptsChatResultWait("text/event-stream", false)).toBe(false);
    expect(chatResultTimeoutMs(carbon, {})).toBe(180_000);
    expect(chatResultTimeoutMs(carbon, { privateProfile: true })).toBe(180_000);
    expect(chatResultTimeoutMs(carbon, { waitForResult: true })).toBe(180_000);
    expect(chatResultTimeoutMs(carbon, { privateProfile: true, waitForResult: true })).toBe(600_000);
    expect(chatResultTimeoutMs({ model_id: "gpt-6-astra" }, { privateProfile: true, waitForResult: true })).toBe(180_000);
    expect(chatResultTimeoutMs({ model_id: "claude-sonnet-5-5" }, { privateProfile: true, waitForResult: true })).toBe(180_000);
});

test("waiting sends immediate progress and 15-second heartbeats, then exactly one result without usage", () => {
    const time = clock(), wire: string[] = [];
    const waiting = startChatResultWait(value => { wire.push(value); }, time.value);
    expect(wire).toHaveLength(1);
    expect(wire[0]).toContain("event: chat_waiting");
    expect([...time.intervals.values()]).toEqual([15_000]);
    time.tick(15_000);
    expect(wire).toHaveLength(2);
    expect(wire[1]).not.toContain("180 秒");
    time.tick(165_000);
    expect(wire[2]).toContain("仍在处理原请求");
    expect(wire[2]).toContain("不会重新提交");
    waiting.complete({ content: "完成同一请求", toolCalls: [], usage: { actualCost: 88 } });
    waiting.complete({ content: "重复结果", toolCalls: [] });
    waiting.fail({ code: "LATE_ERROR", message: "不应发出" });
    time.tick(600_000);
    expect(time.intervals.size).toBe(0);
    expect(wire).toHaveLength(4);
    expect(wire[3]).toContain('event: chat_result\ndata: {"type":"chat_result","result":{"content":"完成同一请求","toolCalls":[]}}');
    expect(wire.join("")).not.toContain("actualCost");
});

test("demo-style waiting response returns headers before completion and terminates with a safe error", async () => {
    const time = clock(), pending = Promise.withResolvers<never>();
    let calls = 0;
    const response = chatResultWaitResponse(() => { calls++; return pending.promise; }, () => ({ code: "CHAT_REQUEST_TIMEOUT", message: "等待达到上限，不会重发。" }), time.value);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(response.headers.get("x-accel-buffering")).toBe("no");
    const reader = response.body!.getReader();
    const initial = new TextDecoder().decode((await reader.read()).value);
    expect(initial).toContain("chat_waiting");
    expect(initial).not.toContain("chat_result");
    expect(calls).toBe(1);
    pending.reject(new Error("private rules and provider credentials"));
    let terminal = "";
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) terminal += new TextDecoder().decode(chunk.value);
    expect(terminal).toContain('event: error\ndata: {"type":"error","error":{"code":"CHAT_REQUEST_TIMEOUT"');
    expect(terminal).not.toContain("private rules");
    expect(terminal).not.toContain("chat_result");
    expect(calls).toBe(1);
    expect(time.intervals.size).toBe(0);
});

test("cancelling a waiting response stops heartbeats without invoking the original work again", async () => {
    const time = clock(), pending = Promise.withResolvers<{ content: string; toolCalls: [] }>();
    let calls = 0;
    const response = chatResultWaitResponse(() => { calls++; return pending.promise; }, () => ({ code: "ERROR", message: "失败" }), time.value);
    const reader = response.body!.getReader();
    await reader.read();
    await reader.cancel();
    expect(time.intervals.size).toBe(0);
    time.tick(190_000);
    pending.resolve({ content: "晚到结果", toolCalls: [] });
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toBe(1);
});
