import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import type { DesignLibraryEntry, DesignLibraryPublishInput } from "@/types/design-library";
import type { DesignLibraryRequestOptions } from "@/services/api/design-library";

const code = ts.transpileModule(readFileSync(new URL("../src/pages/design-library/publish-dialog.tsx", import.meta.url), "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
type Fields = { title: string; thought: string; prompt: string; tags: string[] };
type Element = { type: unknown; props: Record<string, any> };
const settle = () => new Promise<void>(resolve => setImmediate(resolve));

/** Execute the real dialog handlers without module mocks leaking into other Bun tests. */
function harness(options: {
    validate?: (values: Fields) => Promise<Fields>;
    publish?: (input: DesignLibraryPublishInput, request: DesignLibraryRequestOptions) => Promise<DesignLibraryEntry>;
    upload?: () => Promise<string>;
} = {}) {
    let stateIndex = 0, refIndex = 0, nextId = 0, mounted = false, validationCalls = 0;
    let values: Fields = { title: "  A 的设计草稿  ", thought: "  A 的私人设计思路  ", prompt: "", tags: ["面料"] };
    const state: unknown[] = [], refs: { current: unknown }[] = [], nodes: Element[] = [];
    const effects: (() => void | (() => void))[] = [], cleanups: (() => void)[] = [];
    const store = { user: { id: "employee-A" } };
    const calls: { actor: string; input: DesignLibraryPublishInput; options: DesignLibraryRequestOptions }[] = [];
    const uploads: { file: File; metadata: unknown; options: { expectedOwnerId?: string; clientReferenceId?: string; signal?: AbortSignal } }[] = [];
    const published: DesignLibraryEntry[] = [], notices: { level: string; text: string }[] = [], confirmations: unknown[] = [], revoked: string[] = [];
    const result = { id: "published-entry" } as DesignLibraryEntry;
    const form = { validateFields: () => { validationCalls++; return options.validate ? options.validate(values) : Promise.resolve(values); } };
    const react = {
        useEffect: (effect: () => void | (() => void)) => { if (!mounted) effects.push(effect); },
        useRef: (initial: unknown) => refs[refIndex++] ??= { current: initial },
        useState: (initial: unknown) => {
            const index = stateIndex++;
            if (!(index in state)) state[index] = initial;
            return [state[index], (next: unknown) => { state[index] = typeof next === "function" ? next(state[index]) : next; }];
        },
    };
    const jsx = (type: unknown, props: Record<string, any>) => { const node = { type, props }; nodes.push(node); return node; };
    const Form = { Item: "Form.Item", useForm: () => [form], useWatch: (key: keyof Fields) => values[key] };
    const dependencies: Record<string, unknown> = {
        react, "react/jsx-runtime": { jsx, jsxs: jsx },
        antd: {
            Form, Alert: "Alert", Button: "Button", Checkbox: "Checkbox", Input: { TextArea: "TextArea" }, Modal: "Modal", Select: "Select", Tag: "Tag",
            App: { useApp: () => ({ message: Object.fromEntries(["success", "error", "warning"].map(level => [level, (text: string) => notices.push({ level, text })])), modal: { confirm: (input: unknown) => confirmations.push(input) } }) },
        },
        "lucide-react": { ImagePlus: "ImagePlus", X: "X" },
        "@/lib/client-id": { createClientId: () => `request-${++nextId}` },
        "@/lib/image-utils": { formatBytes: String },
        "@/stores/use-user-store": { useUserStore: Object.assign((selector: (value: typeof store) => unknown) => selector(store), { getState: () => store }) },
        "@/services/api/design-library": { publishDesignLibrary: async (input: DesignLibraryPublishInput, request: DesignLibraryRequestOptions) => {
            calls.push({ actor: store.user.id, input, options: request });
            return options.publish ? options.publish(input, request) : result;
        } },
        "@/services/api/server-assets": {
            listServerAssets: async () => ({ assets: [] }),
            uploadServerAsset: async (file: File, metadata: unknown, request: typeof uploads[number]["options"]) => {
                uploads.push({ file, metadata, options: request });
                return options.upload ? options.upload() : "owned-upload";
            },
        },
    };
    const module = { exports: {} as { PublishDialog: (props: { onClose: () => void; onPublished: (entry: DesignLibraryEntry) => void }) => unknown } };
    new Function("require", "module", "exports", "window", "URL", code)(
        (name: string) => { if (!(name in dependencies)) throw new Error(`Unexpected import: ${name}`); return dependencies[name]; }, module, module.exports,
        { addEventListener: () => undefined, removeEventListener: () => undefined },
        { createObjectURL: () => `blob:preview-${++nextId}`, revokeObjectURL: (url: string) => revoked.push(url) },
    );
    const find = (type: unknown, predicate = (_node: Element) => true) => {
        const node = nodes.find(item => item.type === type && predicate(item));
        if (!node) throw new Error(`Missing UI control: ${String(type)}`);
        return node;
    };
    const render = () => {
        stateIndex = 0; refIndex = 0; nodes.length = 0;
        module.exports.PublishDialog({ onClose: () => undefined, onPublished: entry => published.push(entry) });
        if (!mounted) {
            mounted = true;
            for (const effect of effects) { const cleanup = effect(); if (cleanup) cleanups.push(cleanup); }
        }
    };
    render();
    return {
        calls, uploads, published, notices, confirmations, revoked, result,
        validationCalls: () => validationCalls,
        setOwner: (owner: string) => { store.user.id = owner; },
        unmount: () => cleanups.forEach(cleanup => cleanup()),
        acknowledge: () => { find("Checkbox").props.onChange({ target: { checked: true } }); render(); },
        clickPublish: () => find("Button", node => node.props.children === "确认公开并发布").props.onClick(),
        busy: () => { render(); return find("Button", node => node.props.children === "确认公开并发布").props.loading; },
        changeFields: (patch: Partial<Fields>) => { values = { ...values, ...patch }; find(Form).props.onValuesChange(); render(); },
        addFile: (file: File) => { find("input").props.onChange({ target: { files: [file], value: "file" } }); render(); },
        close: () => find("Modal").props.onCancel(),
        fieldValues: () => values,
    };
}

test("text-only drafts never publish as a replacement employee after validation awaits", async () => {
    const validation = Promise.withResolvers<Fields>();
    const h = harness({ validate: () => validation.promise });
    h.acknowledge(); h.clickPublish();
    h.setOwner("employee-B"); validation.resolve(h.fieldValues()); await settle();
    expect(h.validationCalls()).toBe(1); expect(h.calls).toHaveLength(0); expect(h.uploads).toHaveLength(0); expect(h.published).toHaveLength(0);
    expect(h.notices.filter(notice => notice.level === "success")).toHaveLength(0);
});

test("closing the dialog during validation cannot submit the retained draft", async () => {
    const validation = Promise.withResolvers<Fields>();
    const h = harness({ validate: () => validation.promise });
    h.acknowledge(); h.clickPublish(); h.unmount(); validation.resolve(h.fieldValues()); await settle();
    expect(h.calls).toHaveLength(0); expect(h.published).toHaveLength(0);
});

test("publication requires disclosure acknowledgement and explicitly binds the captured employee", async () => {
    const h = harness();
    h.clickPublish(); await settle();
    expect(h.validationCalls()).toBe(0); expect(h.calls).toHaveLength(0);
    h.acknowledge(); h.clickPublish(); await settle();
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]).toEqual({ actor: "employee-A", options: { expectedOwnerId: "employee-A" }, input: { title: "A 的设计草稿", thought: "A 的私人设计思路", prompt: "", tags: ["面料"], assetIds: [], requestId: "request-1" } });
    expect(h.published).toEqual([h.result]); expect(h.busy()).toBe(false);
});

test("duplicate clicks during both validation and publishing share one in-flight operation", async () => {
    const validation = Promise.withResolvers<Fields>(), publishing = Promise.withResolvers<DesignLibraryEntry>();
    const h = harness({ validate: () => validation.promise, publish: () => publishing.promise });
    h.acknowledge(); h.clickPublish(); h.clickPublish();
    expect(h.validationCalls()).toBe(1); expect(h.busy()).toBe(true);
    validation.resolve(h.fieldValues()); await settle();
    h.clickPublish(); h.clickPublish();
    expect(h.calls).toHaveLength(1); expect(h.validationCalls()).toBe(1); expect(h.published).toHaveLength(0);
    publishing.resolve(h.result); await settle();
    expect(h.published).toHaveLength(1); expect(h.busy()).toBe(false);
});

test("validation failure releases the operation lock so the user can correct and resubmit", async () => {
    let invalid = true;
    const h = harness({ validate: values => invalid ? Promise.reject(new Error("title required")) : Promise.resolve(values) });
    h.acknowledge(); h.clickPublish(); await settle();
    expect(h.calls).toHaveLength(0); expect(h.busy()).toBe(false);
    invalid = false; h.changeFields({ title: "修正标题" }); h.acknowledge(); h.clickPublish(); await settle();
    expect(h.validationCalls()).toBe(2); expect(h.calls).toHaveLength(1); expect(h.published).toHaveLength(1);
});

test("failed publication keeps the draft and request id for retries, while edited content gets a new id", async () => {
    const h = harness({ publish: async () => { throw new Error("connection interrupted"); } });
    h.changeFields({ thought: "保留这份设计思路" }); h.acknowledge(); h.clickPublish(); await settle();
    expect(h.published).toHaveLength(0); expect(h.busy()).toBe(false);
    h.close(); expect(h.confirmations).toHaveLength(1);
    h.clickPublish(); await settle();
    expect(h.calls).toHaveLength(2); expect(h.calls[1].input).toEqual(h.calls[0].input); expect(h.fieldValues().thought).toBe("保留这份设计思路");
    h.changeFields({ thought: "用户明确修改后的设计思路" }); h.clickPublish(); await settle();
    expect(h.calls).toHaveLength(2);
    h.acknowledge(); h.clickPublish(); await settle();
    expect(h.calls).toHaveLength(3); expect(h.calls[2].input.requestId).not.toBe(h.calls[1].input.requestId);
});

test("uploaded images are owner-bound with a deadline and are not uploaded twice after publication fails", async () => {
    let failPublication = true;
    const h = harness({ publish: async () => { if (failPublication) throw new Error("publish temporarily failed"); return h.result; } });
    const file = new File([new Uint8Array([137, 80, 78, 71, 0, 255])], "pattern.png", { type: "image/png" });
    h.addFile(file); h.acknowledge(); h.clickPublish(); await settle();
    expect(h.uploads).toHaveLength(1); expect(h.uploads[0].file).toBe(file);
    expect(h.uploads[0].options.expectedOwnerId).toBe("employee-A"); expect(h.uploads[0].options.signal).toBeInstanceOf(AbortSignal);
    expect(h.calls[0].input.assetIds).toEqual(["owned-upload"]);
    failPublication = false; h.clickPublish(); await settle();
    expect(h.uploads).toHaveLength(1); expect(h.calls).toHaveLength(2); expect(h.calls[1].input.requestId).toBe(h.calls[0].input.requestId); expect(h.published).toHaveLength(1);
    h.unmount(); expect(h.revoked).toHaveLength(1);
});

test("owner changes during a pending image upload stop before publication", async () => {
    const upload = Promise.withResolvers<string>();
    const h = harness({ upload: () => upload.promise });
    h.addFile(new File(["original"], "pattern.png", { type: "image/png" })); h.acknowledge(); h.clickPublish(); await settle();
    expect(h.uploads).toHaveLength(1);
    h.setOwner("employee-B"); upload.resolve("owned-upload"); await settle();
    expect(h.calls).toHaveLength(0); expect(h.published).toHaveLength(0);
});
