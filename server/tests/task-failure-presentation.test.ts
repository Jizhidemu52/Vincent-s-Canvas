import { expect, test } from "bun:test";
import express from "express";
import { publicGenerationFailure, publicTaskFailurePayload } from "../../shared/generation-error";
import { createTasksRouter, createAdminTasksRouter } from "../src/routes/tasks";
import type { Database, Cache } from "../src/db";

test("provider failures have safe Chinese actions without exposing diagnostics or guessing uncertain outcomes", () => {
    for (const [raw, expected] of [["Midjourney Blend requires 2 to 4 reference images", "参数或参考素材"], ["output_compression 必须为 0-100", "参数或参考素材"], ["HTTP 502: upstream host=private-api key=secret", "连接异常"], ["content_policy_violation", "内容未通过审核"], ["insufficient balance", "额度不足"], ["429 overload", "服务繁忙"], ["request timed out", "响应超时"], ["invalid_api_key sk-private", "服务配置"], ["unknown raw exception", "生成未完成"]]) {
        const message = publicGenerationFailure(raw);
        expect(message).toContain(expected); expect(message).not.toContain(raw);
    }
    expect(publicGenerationFailure("HTTP 502", "paused")).toContain("不要重复生成");
    const original = { task: { status: "failed", failureReason: "HTTP 502", lastFailure: { secret: "raw" }, parameters: { prompt: "preserve" } }, failures: [{ index: 2, reason: "output_compression invalid", code: "INVALID" }] };
    const output = publicTaskFailurePayload(original) as typeof original;
    expect(output.task).not.toHaveProperty("lastFailure"); expect(output.task.parameters).toBe(original.task.parameters);
    expect(output.failures[0]!.index).toBe(2); expect(original.task.failureReason).toBe("HTTP 502");
    const stable = publicTaskFailurePayload({ task: { status: "paused", failureReason: "provider raw", lastFailure: { phase: "polling", code: "PROVIDER_POLL_HTTP_ERROR", httpStatus: 503, message: "secret", url: "private" } } }) as any;
    expect(stable.task.lastFailure).toEqual({ phase: "polling", code: "PROVIDER_POLL_HTTP_ERROR", httpStatus: 503 });
});

test("real task HTTP detail redacts employees while the admin route and stored row keep exact diagnostics", async () => {
    const row = { id: "11111111-1111-4111-8111-111111111111", status: "failed", failureReason: "Midjourney Blend requires 2 to 4 reference images; api_key=private", parameters: { prompt: "keep original" } };
    const db = { query: async () => ({ rows: [row] }) } as unknown as Database;
    const app = express();
    app.use((request, _response, next) => { (request as any).auth = { id: "owner", role: "super_admin" }; next(); });
    app.use("/api/tasks", createTasksRouter(db, {} as Cache));
    app.use("/api/admin/tasks", createAdminTasksRouter(db, {} as Cache));
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>(resolve => server.once("listening", resolve));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    try {
        const employee = await (await fetch(`${base}/api/tasks/${row.id}`)).json();
        const admin = await (await fetch(`${base}/api/admin/tasks/${row.id}`)).json();
        expect(employee.task.failureReason).toContain("参数或参考素材"); expect(JSON.stringify(employee)).not.toContain("private");
        expect(admin.task.failureReason).toBe(row.failureReason); expect(row.failureReason).toContain("api_key=private");
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
