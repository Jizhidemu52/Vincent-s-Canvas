import type { RequestHandler } from "express";
import type { Database } from "./db";
import type { AuthenticatedRequest } from "./types";
import { canSeeModelIdentity, isImageModel, publicModelName } from "./model-presentation";

const modelFields = new Set(["model", "modelId", "imageModel", "imageModelId", "models", "imageModels"]);
const diagnosticFields = new Set(["meta", "failureReason", "error", "errorMessage", "message"]);

/** Response-only projection: stored records and provider dispatch remain unchanged. */
export function redactDesignerModelData<T>(body: T, catalog: readonly Record<string, unknown>[], role: unknown): T {
    if (canSeeModelIdentity(role)) return body;
    const models = catalog.filter(isImageModel);
    const index = new Map<string, Record<string, unknown>>();
    for (const model of models) for (const key of [model.id, model.modelId, model.name, publicModelName(model)]) {
        if (typeof key === "string" && key) index.set(key, model);
    }
    const find = (value: string) => index.get(value.includes("::") ? value.slice(value.indexOf("::") + 2) : value);
    const replacements = new Map(models.flatMap(model => [model.modelId, model.name, model.providerName]
        .filter((name): name is string => typeof name === "string" && name.length > 2)
        .map(name => [name, name === model.providerName ? "图片服务" : publicModelName(model)] as const)));
    const names = [...replacements.keys()].sort((a, b) => b.length - a.length).map(name => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    const pattern = names.length ? new RegExp(names.join("|"), "g") : undefined;
    // Do not run a replacement label through later private-name replacements.
    const redactText = (value: string) => pattern ? value.replace(pattern, name => replacements.get(name)!) : value;
    const visit = (value: unknown, field = ""): unknown => {
        if (typeof value === "string") {
            const model = find(value);
            if (modelFields.has(field)) return model ? model.id : value;
            if (field === "modelName") return model ? publicModelName(model) : value;
            if (diagnosticFields.has(field)) return redactText(value);
            if (field === "arguments") {
                try { return JSON.stringify(visit(JSON.parse(value))); } catch { return value; }
            }
            return value;
        }
        if (value instanceof Date) return value;
        if (Array.isArray(value)) return value.map(item => visit(item, field));
        if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, visit(item, key)]));
        return value;
    };
    return visit(body) as T;
}

export function designerModelPrivacy(db: Database): RequestHandler {
    return async (request, response, next) => {
        const role = (request as unknown as AuthenticatedRequest).auth.role;
        if (canSeeModelIdentity(role)) { next(); return; }
        try {
            const { rows } = await db.query(`SELECT m.id,m.name,m.model_id AS "modelId",m.capabilities,m.public_number AS "publicNumber",p.name AS "providerName"
                FROM model_configs m JOIN providers p ON p.id=m.provider_id
                WHERE m.capabilities && ARRAY['generate','edit','upscale','remove_background','batch']::text[]`);
            const send = response.json.bind(response);
            response.json = (body) => send(redactDesignerModelData(body, rows, role));
            next();
        } catch (error) { next(error); }
    };
}
