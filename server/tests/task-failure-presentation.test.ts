import { expect, test } from "bun:test";
import express from "express";
import { IMAGE_RESULT_POSTPROCESS_FAILURE_CODE, IMAGE_RESULT_POSTPROCESS_FAILURE_PREFIX, publicGenerationFailure, publicTaskFailurePayload } from "../../shared/generation-error";
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

test("local postprocessing keeps a stable category without suggesting an upstream query or leaking diagnostics", () => {
    const reason = `${IMAGE_RESULT_POSTPROCESS_FAILURE_PREFIX}：private-codec-error https://private.example key=secret；任务已暂停，不会自动重新生成。`;
    const data = { status: "paused", failureReason: reason, errorCode: IMAGE_RESULT_POSTPROCESS_FAILURE_CODE,
        lastFailure: { phase: "postprocess", code: IMAGE_RESULT_POSTPROCESS_FAILURE_CODE, message: "private", url: "private" } };
    const output = publicTaskFailurePayload({ task: data, tasks: [data], message: reason }) as any;
    for (const task of [output.task, ...output.tasks]) {
        expect(task.errorCode).toBe("IMAGE_RESULT_PROCESSING_FAILED");
        expect(task.lastFailure).toEqual({ phase: "postprocess", code: "IMAGE_RESULT_PROCESSING_FAILED" });
        expect(task.failureReason).toContain(IMAGE_RESULT_POSTPROCESS_FAILURE_PREFIX);
        expect(task.failureReason).toContain("不要重复生成");
        expect(task.failureReason).not.toMatch(/查询原任务|private|secret|https:/);
    }
    expect(output.message).toBe(output.task.failureReason);
    expect(publicGenerationFailure(output.message, "paused")).toBe(output.message);
    expect(publicGenerationFailure(reason, "cancelled")).toBe("任务已取消。");
    expect(publicGenerationFailure(output.message, "cancelled")).toBe("任务已取消。");
    expect(publicGenerationFailure("提交状态待核查，请勿重复生成", "cancelled")).toBe("任务已取消。");
    expect(publicTaskFailurePayload({ task: { ...data, status: "cancelled", failureReason: output.message } })).toMatchObject({ task: { status: "cancelled", failureReason: "任务已取消。" } });
    expect(publicGenerationFailure(`provider says ${reason}`, "paused")).toContain("查询原任务");
    expect(data.failureReason).toBe(reason);
});

test("formal task detail selects the same postprocessing category for employee and admin without changing stored reasons", async () => {
    const row = { id: "11111111-1111-4111-8111-111111111111", status: "paused", failureReason: `${IMAGE_RESULT_POSTPROCESS_FAILURE_PREFIX}：private codec detail`,
        errorCode: IMAGE_RESULT_POSTPROCESS_FAILURE_CODE, lastFailure: { phase: "postprocess", code: IMAGE_RESULT_POSTPROCESS_FAILURE_CODE } };
    const statements: string[] = [];
    const db = { query: async (sql: string) => { statements.push(sql); return { rows: [row] }; } } as unknown as Database;
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
        for (const task of [employee.task, admin.task]) {
            expect(task.errorCode).toBe("IMAGE_RESULT_PROCESSING_FAILED");
            expect(task.lastFailure).toEqual(row.lastFailure);
        }
        for (const sql of statements) {
            expect(sql).toContain(`t.status='paused' AND t.failure_reason LIKE '${IMAGE_RESULT_POSTPROCESS_FAILURE_PREFIX}：%'`);
            expect(sql).toContain('END AS "errorCode"');
            expect(sql).toContain('END AS "lastFailure"');
        }
        expect(statements).toHaveLength(2);
        expect(employee.task.failureReason).not.toContain("private");
        expect(admin.task.failureReason).toBe(row.failureReason);
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
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

test("exact reference-upload limits retain the pre-generation boundary without echoing provider bodies", () => {
    for (const purpose of ["图片", "视频"]) {
        const raw = `APIMart 参考图上传失败（429），尚未提交${purpose}生成`;
        const expected = `参考图上传已被服务商限制，尚未提交${purpose}生成；请联系管理员检查上传配额，恢复后再试。`;
        expect(publicGenerationFailure(raw)).toBe(expected);
        expect(publicGenerationFailure(expected)).toBe(expected);
        const original = { task: { status: "failed", failureReason: raw }, message: raw };
        expect(publicTaskFailurePayload(original)).toEqual({ task: { status: "failed", failureReason: expected }, message: expected });
        expect(original.task.failureReason).toBe(raw);
        expect(publicGenerationFailure(raw, "paused")).toContain("不要重复生成");
        expect(publicGenerationFailure(raw, "cancelled")).toBe("任务已取消。");
        const untrusted = `${raw}; key=private; url=https://private.example`;
        const safe = publicGenerationFailure(untrusted);
        expect(safe).not.toMatch(/尚未提交|private|key=|https:/);
    }
    expect(publicGenerationFailure("429 overload")).toBe("生成服务繁忙，请稍后重试；已有任务请先查询原状态。");
});
