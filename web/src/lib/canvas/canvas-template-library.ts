import { nanoid } from "nanoid";
import { canvasDesignTemplates, type CanvasDesignTemplateId, type CanvasDesignTemplateSteps } from "./canvas-design-templates";

export type PersonalCanvasTemplate = {
    version: 1;
    id: string;
    baseTemplateId: CanvasDesignTemplateId;
    title: string;
    steps: CanvasDesignTemplateSteps;
    createdAt: number;
    updatedAt: number;
};
type TemplateStore = {
    getItem<T>(key: string): Promise<T | null>;
    setItem<T>(key: string, value: T): Promise<T>;
    iterate<T, U>(iterator: (value: T, key: string, iteration: number) => U): Promise<U>;
};
type TemplateInput = Pick<PersonalCanvasTemplate, "baseTemplateId" | "title" | "steps"> & { id?: string };

export function validateTemplateContent(value: unknown): asserts value is TemplateInput {
    const item = value as TemplateInput | null;
    if (!item || !canvasDesignTemplates.some(template => template.id === item.baseTemplateId)) throw new Error("模板类型无效");
    if (typeof item.title !== "string" || !item.title.trim() || item.title.length > 80) throw new Error("请填写模板名称，最多 80 字");
    if (!Array.isArray(item.steps) || item.steps.length !== 3 || item.steps.some(step => !Array.isArray(step) || step.length !== 2 || typeof step[0] !== "string" || !step[0].trim() || step[0].length > 80 || typeof step[1] !== "string" || !step[1].trim() || step[1].length > 12000)) throw new Error("请填写全部 3 个步骤的名称和提示词（名称最多 80 字，提示词最多 12000 字）");
}

function readTemplate(value: unknown): PersonalCanvasTemplate {
    validateTemplateContent(value);
    const item = value as PersonalCanvasTemplate;
    if (item.version !== 1 || typeof item.id !== "string" || !/^[\w-]{1,80}$/.test(item.id) || !Number.isFinite(item.createdAt) || !Number.isFinite(item.updatedAt)) throw new Error("已保存的模板格式无效，原记录未修改");
    return structuredClone(item);
}

/** Each template owns one key; saving it never replaces other templates. */
export function createCanvasTemplateLibrary(store: TemplateStore, ownerId: string | undefined, getOwner: () => string | undefined) {
    const prefix = `owner:${encodeURIComponent(ownerId || "")}:template:`;
    const assertOwner = () => { if (!ownerId || getOwner() !== ownerId) throw new Error("员工身份已变化，请重新打开模板窗口"); };
    return {
        async list() {
            assertOwner();
            const templates: PersonalCanvasTemplate[] = [];
            await store.iterate<unknown, void>((value, key) => {
                assertOwner();
                if (!key.startsWith(prefix)) return;
                const item = readTemplate(value);
                if (key !== prefix + item.id) throw new Error("已保存的模板标识不一致，原记录未修改");
                templates.push(item);
            });
            assertOwner();
            return templates.sort((a, b) => b.updatedAt - a.updatedAt);
        },
        async save(input: TemplateInput) {
            assertOwner();
            validateTemplateContent(input);
            const snapshot = structuredClone(input);
            if (snapshot.id && !/^[\w-]{1,80}$/.test(snapshot.id)) throw new Error("模板标识无效");
            const previous = snapshot.id ? await store.getItem<unknown>(prefix + snapshot.id) : null;
            assertOwner();
            if (snapshot.id && !previous) throw new Error("原模板不存在，请另存为新模板");
            const original = previous ? readTemplate(previous) : null;
            if (original && original.id !== snapshot.id) throw new Error("原模板标识不一致，记录未修改");
            const now = Date.now();
            const saved: PersonalCanvasTemplate = { version: 1, id: original?.id || nanoid(), baseTemplateId: snapshot.baseTemplateId, title: snapshot.title.trim(), steps: snapshot.steps.map(([title, prompt]) => [title.trim(), prompt] as const), createdAt: original?.createdAt ?? now, updatedAt: now };
            await store.setItem(prefix + saved.id, saved);
            assertOwner();
            return structuredClone(saved);
        },
    };
}
