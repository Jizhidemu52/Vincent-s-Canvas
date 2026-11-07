/** Public, bounded design data. These records never authorize a task or prove visual correctness. */
export type ImageAgentReferenceRole = {
    image_id: string;
    role: "base" | "material" | "color" | "model" | "pose" | "background" | "style" | "reference";
    purpose: string;
    do_not_transfer?: string;
};
export type ImageAgentEditSpec = {
    changes: string[];
    region?: string;
    reference_roles?: ImageAgentReferenceRole[];
    acceptance?: string[];
    assumptions?: string[];
};
export type ImageAgentReview = {
    summary: string;
    checks: Array<{ criterion: string; result: "pass" | "warning" | "unverifiable"; evidence: string }>;
};
export type ImageAgentRegionProposal = {
    image_id: string;
    region: string;
    box: { x: number; y: number; width: number; height: number };
    confidence: "high" | "medium" | "low";
    note: string;
};
export type ImageAgentPlanningIssue = { code: string; message: string; submitted: false; repairable: true };
export const IMAGE_AGENT_REPAIR_CODES = ["IMAGE_AGENT_ARGUMENTS_INVALID", "IMAGE_AGENT_SPEC_INVALID", "IMAGE_AGENT_REFERENCES_INVALID", "IMAGE_AGENT_UNPREVIEWED_IMAGE"] as const;

export class ImageAgentPlanningError extends Error {
    readonly submitted = false;
    readonly repairable = true;
    constructor(readonly code: typeof IMAGE_AGENT_REPAIR_CODES[number], message: string) {
        super(message);
        this.name = "ImageAgentPlanningError";
    }
}
export function isImageAgentPlanningIssue(value: unknown): value is ImageAgentPlanningIssue {
    if (!value || typeof value !== "object") return false;
    const issue = value as Record<string, unknown>;
    return issue.submitted === false && issue.repairable === true
        && (IMAGE_AGENT_REPAIR_CODES as readonly unknown[]).includes(issue.code)
        && typeof issue.message === "string" && Boolean(issue.message.trim()) && issue.message.length <= 1000;
}

const text = (maximum: number) => ({ type: "string", minLength: 1, maxLength: maximum });
const list = (maximum = 12) => ({ type: "array", maxItems: maximum, items: text(400) });
export const IMAGE_AGENT_EDIT_SPEC_SCHEMA = {
    type: "object", additionalProperties: false, required: ["changes"],
    properties: {
        changes: { ...list(), minItems: 1 }, region: text(400),
        reference_roles: { type: "array", maxItems: 5, items: { type: "object", additionalProperties: false, required: ["image_id", "role", "purpose"], properties: {
            image_id: text(300), role: { type: "string", enum: ["base", "material", "color", "model", "pose", "background", "style", "reference"] },
            purpose: text(400), do_not_transfer: text(400),
        } } }, acceptance: list(), assumptions: list(6),
    },
};
export const IMAGE_AGENT_REVIEW_SCHEMA = {
    type: "object", additionalProperties: false, required: ["summary", "checks"], properties: {
        summary: text(800), checks: { type: "array", minItems: 1, maxItems: 12, items: {
            type: "object", additionalProperties: false, required: ["criterion", "result", "evidence"], properties: {
                criterion: text(400), result: { type: "string", enum: ["pass", "warning", "unverifiable"] }, evidence: text(800),
            },
        } },
    },
};
export const IMAGE_AGENT_REGION_SCHEMA = {
    type: "object", additionalProperties: false, required: ["image_id", "region", "box", "confidence", "note"], properties: {
        image_id: text(300), region: text(400), confidence: { type: "string", enum: ["high", "medium", "low"] }, note: text(800),
        box: { type: "object", additionalProperties: false, required: ["x", "y", "width", "height"], properties: {
            x: { type: "number", minimum: 0, maximum: 1 }, y: { type: "number", minimum: 0, maximum: 1 },
            width: { type: "number", exclusiveMinimum: 0, maximum: 1 }, height: { type: "number", exclusiveMinimum: 0, maximum: 1 },
        } },
    },
};

function record(value: unknown, keys: readonly string[], required: readonly string[] = []): value is Record<string, unknown> {
    return Boolean(value && typeof value === "object" && !Array.isArray(value)
        && Object.keys(value).every(key => keys.includes(key)) && required.every(key => Object.hasOwn(value, key)));
}
const validText = (value: unknown, maximum: number): value is string => typeof value === "string" && Boolean(value.trim()) && value.length <= maximum;
const validList = (value: unknown, maximum = 12): value is string[] => Array.isArray(value) && value.length <= maximum && value.every(item => validText(item, 400));
const specInvalid = () => new ImageAgentPlanningError("IMAGE_AGENT_SPEC_INVALID", "改图规格格式不完整或超过限制；请修正本轮 changes、图片分工和验收要点，图片任务尚未提交。");

export function parseImageAgentEditSpec(value: unknown): ImageAgentEditSpec {
    if (!record(value, ["changes", "region", "reference_roles", "acceptance", "assumptions"], ["changes"])
        || !validList(value.changes) || !value.changes.length
        || (value.region !== undefined && !validText(value.region, 400))
        || (value.acceptance !== undefined && !validList(value.acceptance))
        || (value.assumptions !== undefined && !validList(value.assumptions, 6))) throw specInvalid();
    const roles = value.reference_roles;
    if (roles !== undefined && (!Array.isArray(roles) || roles.length > 5 || roles.some(role =>
        !record(role, ["image_id", "role", "purpose", "do_not_transfer"], ["image_id", "role", "purpose"])
        || !validText(role.image_id, 300) || !["base", "material", "color", "model", "pose", "background", "style", "reference"].includes(String(role.role))
        || !validText(role.purpose, 400) || (role.do_not_transfer !== undefined && !validText(role.do_not_transfer, 400))))) throw specInvalid();
    if (JSON.stringify(value).length > 10_000) throw specInvalid();
    return structuredClone(value) as ImageAgentEditSpec;
}

export function parseImageAgentReview(value: unknown): ImageAgentReview {
    if (!record(value, ["summary", "checks"], ["summary", "checks"]) || !validText(value.summary, 800)
        || !Array.isArray(value.checks) || !value.checks.length || value.checks.length > 12
        || value.checks.some(check => !record(check, ["criterion", "result", "evidence"], ["criterion", "result", "evidence"])
            || !validText(check.criterion, 400) || !["pass", "warning", "unverifiable"].includes(String(check.result)) || !validText(check.evidence, 800))) {
        throw new Error("结果检查未返回有效的逐项证据；原生成结果已保留，没有重新出图。");
    }
    return structuredClone(value) as ImageAgentReview;
}

export function parseImageAgentRegionProposal(value: unknown): ImageAgentRegionProposal {
    if (!record(value, ["image_id", "region", "box", "confidence", "note"], ["image_id", "region", "box", "confidence", "note"])
        || !validText(value.image_id, 300) || !validText(value.region, 400) || !validText(value.note, 800)
        || !["high", "medium", "low"].includes(String(value.confidence))
        || !record(value.box, ["x", "y", "width", "height"], ["x", "y", "width", "height"])) throw new Error("选区建议无效，请手动涂选；没有提交图片修改。");
    const box = value.box as Record<string, number>;
    if (!Object.values(box).every(Number.isFinite) || box.x! < 0 || box.y! < 0 || box.width! <= 0 || box.height! <= 0
        || box.x! + box.width! > 1 || box.y! + box.height! > 1 || box.width! * box.height! < 0.000001) {
        throw new Error("选区建议越界或面积无效，请手动涂选；没有提交图片修改。");
    }
    return structuredClone(value) as ImageAgentRegionProposal;
}
