import { describe, expect, test } from "bun:test";
import { compileCreativeChatExecutionPrompt } from "../src/lib/creative-chat-execution";
import { buildCreativeChatRequestMessages, buildCreativeChatTools, buildCreativeImageCatalog, parseCreativeChatPlan, type CreativeChatMessage } from "../src/lib/creative-chat";
import { buildImageReferencePromptText } from "../src/lib/image-reference-prompt";

const reference = (id: string) => ({ id, name: `${id}.png`, type: "image/png", dataUrl: "data:image/png;base64,QQ==" });
const catalog = ["old", "palette", "third", "fourth", "garment"].map((id, index) => ({ ...reference(id), label: `图 ${index + 1}`, messageId: `message-${id}`, kind: "upload" as const }));
const references = [reference("garment"), reference("palette")];
const result = (args: Record<string, unknown>) => ({ content: "", toolCalls: [{ id: "call-1", type: "function" as const, function: { name: "create_image", arguments: JSON.stringify(args) } }] });
const editArgs = { action: "edit", prompt: "只将七颗纽扣改为深酒红。", target_image_id: "garment", reference_image_ids: [] as string[], preserve: ["衣身保持浅玫瑰粉", "不得新增口袋", "白色背景保持不变"] };

describe("creative chat deterministic execution contract", () => {
    test("captured duplicate preserve keys fail closed instead of salvaging JSON.parse's last value", () => {
        // Verbatim concatenated input_json_delta from the first controlled live replay.
        // Keep raw JSON: JSON.stringify would erase the duplicate-key evidence.
        const raw = '{"action": "edit", "prompt": "以{{image:cdc08c4c-bc07-47e2-8a6b-3470ab032a6e}}的米白衬衫为要修改的主图，只借用{{image:eeb33f10-8047-4d2f-bc37-cf4f6f6c0537}}浅蓝衬衫的面料颜色（浅天蓝色）。将主图衬衫的衣身、领子、两只袖子和袖口整体改成这种浅天蓝色，保留原有面料纹理、褶皱明暗和阴影。七颗纽扣保持米白色不变。翻领、长袖版型、门襟、缝线、衣摆、比例与位置、白色背景和投影都保持原样。不得添加口袋、文字、图案、Logo或任何装饰。只输出1张图。", "preserve": "七颗米白纽扣保持米白色", "preserve": "翻领造型", "preserve": "长袖版型和袖口", "preserve": "门襟、缝线、衣摆", "preserve": "面料纹理和褶皱", "preserve": "衬衫比例与位置", "preserve": "白色背景和阴影", "preserve": "不添加口袋、文字、图案、Logo或装饰", "target_image_id": "cdc08c4c-bc07-47e2-8a6b-3470ab032a6e", "reference_image_ids": ["eeb33f10-8047-4d2f-bc37-cf4f6f6c0537"], "reference_roles": [{"image_id":"cdc08c4c-bc07-47e2-8a6b-3470ab032a6e","role":"target","purpose":"要修改的米白衬衫，保留全部结构、纽扣、背景和阴影"},{"image_id":"eeb33f10-8047-4d2f-bc37-cf4f6f6c0537","role":"reference","purpose":"仅借用浅天蓝色面料颜色","do_not_transfer":"不迁移其版型、纽扣、领型、褶皱或背景"}]}';
        expect(raw.match(/"preserve"\s*:/g)).toHaveLength(8);
        expect(JSON.parse(raw).preserve).toBe("不添加口袋、文字、图案、Logo或装饰");
        const captured = { content: "", toolCalls: [{ id: "captured-call", type: "function" as const, function: { name: "create_image", arguments: raw } }] };
        expect(() => parseCreativeChatPlan(captured, [reference("cdc08c4c-bc07-47e2-8a6b-3470ab032a6e"), reference("eeb33f10-8047-4d2f-bc37-cf4f6f6c0537")])).toThrow("重复 JSON 键");
    });

    test("the actual downstream prompt includes preserve even when the model omitted it from prompt", () => {
        const plan = parseCreativeChatPlan(result(editArgs), references, { catalog });
        if (plan.kind !== "image") throw new Error("expected image plan");
        const actualPrompt = buildImageReferencePromptText(plan.prompt, plan.references);
        expect(actualPrompt).toContain(editArgs.prompt);
        editArgs.preserve.forEach((constraint) => expect(actualPrompt).toContain(`- ${constraint}`));
        expect(plan.lineage.preservedConstraints).toEqual(editArgs.preserve);
        expect(plan.references.map((item) => item.id)).toEqual(["garment"]);
    });

    test("only current branch preserve is compiled, never old or unrelated lineage", () => {
        const history: CreativeChatMessage[] = [
            { role: "assistant", content: "生成成功", generatedImages: [{ ...reference("garment"), lineage: { sourceImageIds: ["original"], preservedConstraints: ["衣身保持粉色", "原领口不变"] } }] },
            { role: "assistant", content: "其他分支", generatedImages: [{ ...reference("swan"), lineage: { sourceImageIds: [], preservedConstraints: ["天鹅羽毛保持白色"] } }] },
        ];
        const plan = parseCreativeChatPlan(result({ ...editArgs, prompt: "衣身改为浅蓝色。", preserve: ["原领口不变"] }), [reference("garment")], { catalog: buildCreativeImageCatalog(history) });
        if (plan.kind !== "image") throw new Error("expected image plan");
        expect(plan.prompt).toContain("衣身改为浅蓝色");
        expect(plan.prompt).not.toContain("粉色");
        expect(plan.prompt).not.toContain("天鹅");
        expect(plan.lineage).toMatchObject({ parentImageId: "garment", preservedConstraints: ["原领口不变"] });
    });

    test("declared superseded old constraints are excluded from execution and saved lineage", () => {
        const plan = parseCreativeChatPlan(result({ ...editArgs, prompt: "衣身改为浅蓝色。", preserve: ["衣身保持粉色", "原领口不变"], superseded_constraints: [" 衣身保持粉色 "] }), references, { catalog });
        if (plan.kind !== "image") throw new Error("expected image plan");
        expect(plan.prompt).not.toContain("粉色");
        expect(plan.lineage.preservedConstraints).toEqual(["原领口不变"]);
        expect(plan.prompt).toContain("本轮明确修改或撤销的要求优先");
    });

    test("legacy global image numbers normalize when their selected identities are unambiguous", () => {
        const plan = parseCreativeChatPlan(result({ ...editArgs, prompt: "以图5的衬衫为主体，只借用图2的颜色。", reference_image_ids: ["palette"] }), references, { catalog });
        if (plan.kind !== "image") throw new Error("expected image plan");
        expect(plan.prompt).toContain("以图片1的衬衫为主体，只借用图片2的颜色。");
        expect(plan.prompt).not.toContain("图5");
        expect(plan.references.map((item) => item.id)).toEqual(["garment", "palette"]);
    });

    test("roles in any order compile to actual selected order using stable IDs", () => {
        const compiled = compileCreativeChatExecutionPrompt({ prompt: "以{{image:garment}}为主体，仅借用{{image:palette}}的配色。", preserve: ["{{image:garment}}的领口和版型不变"], references, catalog, referenceRoles: [
            { image_id: "palette", role: "reference", purpose: "仅配色", do_not_transfer: "版型、人物和背景" },
            { image_id: "garment", role: "target", purpose: "服装主体" },
        ] });
        expect(compiled.prompt).toContain("以图片1为主体，仅借用图片2的配色");
        expect(compiled.prompt).toContain("图片1（修改主体）：服装主体\n- 图片2（辅助参考）：仅配色 不迁移：版型、人物和背景");
        expect(compiled.preservedConstraints).toEqual(["图片1的领口和版型不变"]);
        expect(compiled.prompt).not.toContain("{{image:");
    });

    test("explicit stable role bindings disambiguate old labels before numbering", () => {
        const selected = [reference("palette"), reference("old")];
        const compiled = compileCreativeChatExecutionPrompt({ prompt: "图2为主体，只借用图1的颜色。", preserve: [], references: selected, catalog, referenceRoles: [
            { image_id: "palette", role: "target", purpose: "服装主体", prompt_label: "图2" },
            { image_id: "old", role: "reference", purpose: "仅颜色", prompt_label: "图1" },
        ] });
        expect(compiled.prompt).toContain("图片1为主体，只借用图片2的颜色。");
    });

    test("ambiguous old and local numbering fails before producing an executable plan", () => {
        expect(() => parseCreativeChatPlan(result({ ...editArgs, target_image_id: "palette", reference_image_ids: ["old"], prompt: "图2为主体，图1提供颜色" }), [reference("palette"), reference("old")], { catalog })).toThrow("指向不同图片");
    });

    test("an excluded catalog image must not be rebound to the same numbered actual slot", () => {
        const orderedCatalog = ["white-garment", "excluded-green", "blue"].map((id, index) => ({ ...reference(id), label: `图 ${index + 1}`, messageId: `message-${id}`, kind: "upload" as const }));
        const actual = [reference("white-garment"), reference("blue")];
        expect(() => parseCreativeChatPlan(result({ ...editArgs, target_image_id: "white-garment", reference_image_ids: ["blue"], prompt: "把图1改成图3的蓝色，不要参考图2。" }), actual, { catalog: orderedCatalog })).toThrow("目录中未选入");
        const compiled = compileCreativeChatExecutionPrompt({ prompt: "把{{image:white-garment}}改成{{image:blue}}的蓝色，不采用绿色。", preserve: [], references: actual, catalog: orderedCatalog });
        expect(compiled.prompt).toContain("把图片1改成图片2的蓝色，不采用绿色。");
    });

    test.each(["只参照图9", "只参照{{image:unselected}}", "只参照{{image:garment}"])("rejects unresolved reference %s without guessing", (prompt) => {
        expect(() => compileCreativeChatExecutionPrompt({ prompt, preserve: [], references, catalog })).toThrow("未提交图片任务");
    });

    test("old plans without optional fields still support local and ordinal image labels", () => {
        const plan = parseCreativeChatPlan(result({ ...editArgs, reference_image_ids: ["palette"], prompt: "第一张图为修改主体，第二张仅提供颜色，图片1的领口不变。" }), references);
        if (plan.kind !== "image") throw new Error("expected image plan");
        expect(plan.prompt).toContain("图片1为修改主体，图片2仅提供颜色，图片1的领口不变。");
    });

    test("quoted artwork text resembling image labels is not rewritten", () => {
        const compiled = compileCreativeChatExecutionPrompt({ prompt: '在{{image:garment}}上印上“图5”与"Image 9"，保持「图片8」原样。', preserve: [], references, catalog });
        expect(compiled.prompt).toContain('在图片1上印上“图5”与"Image 9"，保持「图片8」原样。');
    });

    test.each([
        [{ image_id: "garment", role: "target", purpose: "主体" }],
        [{ image_id: "garment", role: "reference", purpose: "主体" }, { image_id: "palette", role: "reference", purpose: "颜色" }],
        [{ image_id: "garment", role: "target", purpose: "主体" }, { image_id: "garment", role: "reference", purpose: "颜色" }],
        [{ image_id: "garment", role: "target", purpose: "主体" }, { image_id: "outside", role: "reference", purpose: "颜色" }],
        [{ image_id: "garment", role: "target", purpose: "主体", prompt_label: "图1" }, { image_id: "palette", role: "reference", purpose: "颜色", prompt_label: "图1" }],
    ].map((roles) => ({ roles })))("rejects incomplete or inconsistent role mappings %#", ({ roles }) => {
        expect(() => compileCreativeChatExecutionPrompt({ prompt: "改色", preserve: [], references, catalog, referenceRoles: roles })).toThrow("未提交图片任务");
    });

    test("constraint normalization is bounded and no requirements are silently truncated", () => {
        expect(() => compileCreativeChatExecutionPrompt({ prompt: "改色", preserve: [], references, supersededConstraints: [4] })).toThrow("撤销约束格式无效");
        expect(() => compileCreativeChatExecutionPrompt({ prompt: "改".repeat(19_900), preserve: ["保留".repeat(100)], references })).toThrow("超过 20000");
        expect(compileCreativeChatExecutionPrompt({ prompt: "改色", preserve: [" 白底 ", "白底"], references }).preservedConstraints).toEqual(["白底"]);
    });

    test("reference-free generation compiles preservation and rejects image pointers", () => {
        const plan = parseCreativeChatPlan(result({ action: "generate", prompt: "画一朵花", preserve: ["背景纯白"] }), references);
        if (plan.kind !== "image") throw new Error("expected image plan");
        expect(plan.references).toEqual([]);
        expect(plan.prompt).toContain("- 背景纯白");
        expect(() => parseCreativeChatPlan(result({ action: "generate", prompt: "参照{{image:garment}}画花", preserve: [] }), references)).toThrow("未提交图片任务");
        const numberedOutput = parseCreativeChatPlan(result({ action: "generate", prompt: "生成第一张夏季海报", preserve: [] }), []);
        expect(numberedOutput.kind === "image" && numberedOutput.prompt).toContain("生成第一张夏季海报");
    });

    test("new schema is additive and historical execution does not imply user approval", () => {
        const schema = buildCreativeChatTools()[0]!.function.parameters as { required: string[]; properties: Record<string, unknown> };
        expect(schema.required).toEqual(["action", "prompt", "preserve"]);
        expect(schema.properties.reference_roles).toBeDefined();
        expect(schema.properties.superseded_constraints).toBeDefined();
        expect(schema.properties.preserve).toMatchObject({ type: "array", items: { type: "string" } });
        const messages = buildCreativeChatRequestMessages([], { role: "user", content: "画一朵花" });
        expect(String(messages[0]!.content)).toContain("生成成功不等于用户认可");
        expect(String(messages[0]!.content)).toContain("旧 prompt 内的编号只属于旧执行");
        expect(String(messages[0]!.content)).toContain('"preserve":["约束一","约束二"]');
        expect(String(messages[0]!.content)).toContain("每个键只能出现一次");
    });
});
