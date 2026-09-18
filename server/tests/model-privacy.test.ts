import { expect, test } from "bun:test";
import express from "express";
import { designerModelPrivacy, redactDesignerModelData } from "../src/model-privacy";
import type { Database } from "../src/db";

const model = { id: "image-config-id", name: "Private Image", modelId: "gpt-image-2.5-flare", providerName: "Private Provider", capabilities: ["generate", "edit"], publicNumber: 2 };
test("designer history, canvas undo metadata and task diagnostics hide identity without modifying stored data", () => {
    const original = { modelName: model.name, createdAt: new Date(), metadata: { model: model.modelId },
        document: { history: { past: [{ nodes: [{ metadata: { config: { imageModel: `default::${model.modelId}` } } }] }] } },
        failureReason: `${model.providerName}: ${model.modelId} failed`, prompt: `user request mentioning ${model.modelId}`,
        tool: { arguments: JSON.stringify({ model: model.modelId, prompt: model.name }) } };
    const safe = redactDesignerModelData(original, [model], "designer");
    expect(safe.modelName).toBe("出图模型2");
    expect(safe.metadata.model).toBe(model.id);
    expect(safe.document.history.past[0]!.nodes[0]!.metadata.config.imageModel).toBe(model.id);
    expect(safe.failureReason).toBe("图片服务: 出图模型2 failed");
    expect(safe.prompt).toBe(original.prompt);
    expect(safe.createdAt).toBe(original.createdAt);
    expect(JSON.parse(safe.tool.arguments)).toEqual({ model: model.id, prompt: model.name });
    expect(original.metadata.model).toBe(model.modelId);
    for (const role of ["super_admin", "department_admin"]) expect(redactDesignerModelData(original, [model], role)).toBe(original);
});

test("formal response middleware applies only after identity and preserves admin response", async () => {
    const db = { query: async () => ({ rows: [model] }) } as unknown as Database;
    const app = express();
    app.use((request, _response, next) => { Object.assign(request, { auth: { role: request.headers["x-test-role"] || "designer" } }); next(); });
    app.use(designerModelPrivacy(db));
    app.get("/history", (_request, response) => response.json({ modelName: model.name, metadata: { model: model.modelId } }));
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>(done => server.once("listening", done));
    try {
        const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
        expect(await (await fetch(origin + "/history")).json()).toEqual({ modelName: "出图模型2", metadata: { model: model.id } });
        expect(await (await fetch(origin + "/history", { headers: { "x-test-role": "super_admin" } })).json()).toEqual({ modelName: model.name, metadata: { model: model.modelId } });
    } finally { await new Promise<void>(done => { server.close(() => done()); server.closeAllConnections(); }); }
});
