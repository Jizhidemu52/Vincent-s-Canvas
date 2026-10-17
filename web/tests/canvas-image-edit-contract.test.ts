import { expect, test } from "bun:test";
import { compileCanvasEditContract as compile, type CanvasEditContract } from "@/lib/canvas/canvas-image-edit-contract";
import { canvasImageEditContext, resolveCanvasImageEdit } from "@/lib/canvas/canvas-assistant-image-edit";
import { CanvasNodeType, type CanvasAssistantReference } from "@/types/canvas";

const original: CanvasAssistantReference = { id: "shirt", type: CanvasNodeType.Image, title: "shirt", dataUrl: "data:image/png;base64,ORIGINAL" };
const clause = (id: string, text: string, source: string) => ({ id, text, source });
const contract = (patch: Record<string, unknown> = {}) => ({ mode: "complete", changes: [clause("fabric", "Make the shirt pink.", "衬衫改粉色")], preserve: [clause("buttons", "Seven cream buttons.", "保留七颗米白纽扣")], forbid: [clause("no-pocket", "Add pockets.", "不要添加口袋")], supersedes: [], referenceRoles: [{ id: "shirt", role: "base" }], ...patch });
const input = (patch: Record<string, unknown> = {}) => ({ contract: contract(), continuing: false, userPrompt: "衬衫改粉色，保留七颗米白纽扣，不要添加口袋", draftPrompt: "Edit the shirt.", references: [original], ...patch });

test("compiler uses every structured target, not an incomplete planner draft", () => {
    const result = compile(input());
    expect(result.prompt).toContain("Make the shirt pink.");
    expect(result.prompt).toContain("Keep unchanged:\n- Seven cream buttons.");
    expect(result.prompt).toContain("Prohibitions:\n- Do not Add pockets.");
    expect(result.prompt).not.toContain("Edit the shirt.");
    expect(JSON.stringify(result.contract)).not.toMatch(/approved|accepted/);
});

test("correction after reload compiles the original current goal plus the new delta", () => {
    const first = resolveCanvasImageEdit({ editIntent: "new", prompt: "Edit the shirt.", editContract: contract() }, canvasImageEditContext([]), () => [original], input().userPrompt);
    const history = JSON.parse(JSON.stringify([{ id: "v1", role: "assistant", text: "generated, not approved", detail: { status: "completed", imageEdit: first.lineage }, attachments: [{ id: "pink", name: "pink", mediaType: "image", url: "data:image/png;base64,PINK" }] }]));
    const context = canvasImageEditContext(history);
    const delta = contract({ mode: "update", changes: [clause("buttons", "Make the seven buttons burgundy.", "七颗纽扣改酒红")], preserve: [], forbid: [], supersedes: ["buttons"], referenceRoles: [{ id: "edit-original-0", role: "base" }] });
    const next = resolveCanvasImageEdit({ editIntent: "correct_original", prompt: "Change the buttons.", editContract: delta }, context, () => context.results, "粉色不变，七颗纽扣改酒红");
    expect(next.references[0]?.dataUrl).toBe(original.dataUrl);
    expect(next.prompt).toContain("Make the shirt pink.");
    expect(next.prompt).toContain("Make the seven buttons burgundy.");
    expect(next.prompt).not.toContain("Seven cream buttons.");
    expect(next.prompt).toContain("Add pockets.");
    expect(history[0].detail.imageEdit.contract.preserve[0].text).toBe("Seven cream buttons.");
});

test("explicit supersedes supports changed targets and cancellation without silently retaining stale constraints", () => {
    const previous = compile(input()).contract;
    const result = compile(input({ previous, continuing: true, userPrompt: "不要粉色了，改成蓝色，允许口袋", contract: contract({ mode: "update", changes: [clause("fabric", "Make the shirt blue.", "改成蓝色")], preserve: [], forbid: [], supersedes: ["fabric", "no-pocket"] }) }));
    expect(result.prompt).toContain("blue");
    expect(result.prompt).not.toContain("pink");
    expect(result.prompt).not.toContain("Add pockets");
    expect(result.prompt).toContain("Seven cream buttons");
    for (const patch of [{ mode: "complete" }, { mode: "update", supersedes: [], changes: [clause("fabric", "Make the shirt blue.", "衬衫改粉色")] }, { mode: "update", supersedes: ["unknown"] }]) expect(() => compile(input({ previous, continuing: true, contract: contract(patch) }))).toThrow();
});

test("superseded counts do not block an explicit seven-to-eight revision", () => {
    const previous = compile(input()).contract;
    const result = compile(input({ previous, continuing: true, userPrompt: "不要七颗纽扣了，改为八颗", contract: contract({ mode: "update", changes: [clause("buttons", "Use eight cream buttons.", "改为八颗")], preserve: [], forbid: [], supersedes: ["buttons"] }) }));
    expect(result.prompt).toContain("eight");
    expect(result.prompt).not.toContain("Seven");
});

test("real single-output Chinese request retains seven buttons without requiring an image-content one", () => {
    const result = compile(input({ userPrompt: `${input().userPrompt}。只生成1张。` }));
    expect(result.prompt).toContain("Seven cream buttons");
});

test("negative-form prohibitions are not prefixed a second time", () => {
    const result = compile(input({ contract: contract({ forbid: [clause("no-pocket", "Do not add pockets.", "不要添加口袋")] }) }));
    expect(result.prompt).toContain("Prohibitions:\n- Do not add pockets.");
    expect(result.prompt).not.toContain("Do not Do not");
});

test("legacy history never fabricates a saved goal; complete reconstruction is required", () => {
    expect(() => compile(input({ continuing: true, contract: contract({ mode: "update" }) }))).toThrow("complete");
    expect(() => compile(input({ contract: undefined }))).toThrow("editContract");
    const result = compile(input({ continuing: true, userPrompt: "保留七颗米白纽扣", legacySources: [input().userPrompt] }));
    expect(result.prompt).toContain("pink");
    expect(result.contract).not.toHaveProperty("approved");
});

test("a new task never inherits the previous task's targets", () => {
    const previous = compile(input()).contract;
    const result = compile(input({ previous, userPrompt: "生成蓝色杯子", references: [], contract: contract({ changes: [clause("mug", "Generate a blue mug.", "生成蓝色杯子")], preserve: [], forbid: [], referenceRoles: [] }) }));
    expect(result.prompt).not.toContain("shirt");
    expect(result.prompt).not.toContain("buttons");
});

test("reference ids bind to the final reordered subset, not old presentation numbers", () => {
    const color = { ...original, id: "color", dataUrl: "data:image/png;base64,COLOR" };
    const result = compile(input({ userPrompt: "第一张用颜色图，第二张用款式图", references: [color, original], draftPrompt: "Use [[ref:shirt]] for shape and [[ref:color]] for color.", contract: contract({ changes: [clause("references", "Use [[ref:shirt]] for shape and [[ref:color]] for color.", "第一张用颜色图，第二张用款式图")], preserve: [], forbid: [], referenceRoles: [{ id: "shirt", role: "shape" }, { id: "color", role: "color" }] }) }));
    expect(result.prompt).toContain("Image 1: color reference.");
    expect(result.prompt).toContain("Image 2: shape reference.");
    expect(result.prompt).toContain("Use Image 2 for shape and Image 1 for color.");
    for (const draftPrompt of ["Use Image 3 for color.", "Use Image 1 for color.", "Use [[ref:missing]] for color."]) expect(() => compile(input({ references: [color, original], draftPrompt }))).toThrow();
    expect(() => compile(input({ draftPrompt: "Use Image 3." }))).toThrow("编号");
});

test("all actual references must have one valid role and unknown or duplicate roles fail", () => {
    for (const referenceRoles of [[], [{ id: "wrong", role: "base" }], [{ id: "shirt", role: "base" }, { id: "shirt", role: "color" }], [{ id: "shirt", role: "look-only" }]]) expect(() => compile(input({ contract: contract({ referenceRoles }) }))).toThrow("referenceRoles");
});

test("source provenance, duplicate ids and non-English instructions fail closed", () => {
    for (const changes of [[clause("fabric", "Make the shirt pink.", "用户从未说过")], [clause("fabric", "改粉色", "衬衫改粉色")], [clause("buttons", "Make the shirt pink.", "衬衫改粉色")]]) expect(() => compile(input({ contract: contract({ changes }) }))).toThrow();
});

test("omitted numeric clause is detected against the whole user turn", () => {
    expect(() => compile(input({ contract: contract({ preserve: [] }) }))).toThrow("数量");
    expect(() => compile(input({ contract: contract({ preserve: [clause("buttons", "Cream buttons.", "保留七颗米白纽扣")] }) }))).toThrow("数量");
});

test("negation and literal artwork cannot be lost in a clause", () => {
    expect(() => compile(input({ userPrompt: "不要添加口袋", contract: contract({ changes: [clause("pockets", "Add pockets.", "不要添加口袋")], preserve: [], forbid: [] }) }))).toThrow("禁止或保留");
    expect(() => compile(input({ userPrompt: "保留文字“ABC-123”", contract: contract({ changes: [], preserve: [clause("logo", "Keep the label unchanged.", "保留文字“ABC-123”")], forbid: [] }) }))).toThrow("标识");
});

test("original reference aliases survive reload without mutating persisted targets", () => {
    const stored: CanvasEditContract = { changes: [clause("shape", "Use [[ref:shirt]] for shape.", "用原图款式")], preserve: [], forbid: [] };
    const history: any[] = [{ id: "v1", role: "assistant", text: "done", detail: { status: "completed", imageEdit: { originalReferences: [original], originalPrompt: "用原图款式", contract: stored } }, attachments: [{ id: "v1", name: "v1", mediaType: "image", url: "blob:v1" }] }];
    const context = canvasImageEditContext(history);
    expect(context.contract!.changes[0]!.text).toContain("[[ref:edit-original-0]]");
    expect(stored.changes[0]!.text).toContain("[[ref:shirt]]");
    const result = compile({ previous: context.contract, continuing: true, references: context.originals, userPrompt: "继续", draftPrompt: "Continue.", contract: contract({ mode: "update", changes: [], preserve: [], forbid: [], referenceRoles: [{ id: "edit-original-0", role: "shape" }] }) });
    expect(result.prompt).toContain("Use Image 1 for shape.");
});

test("alias remapping is simultaneous even when old ids overlap with new aliases", () => {
    const references = [{ ...original, id: "edit-original-1" }, { ...original, id: "edit-original-0", dataUrl: "data:image/png;base64,SECOND" }];
    const history: any[] = [{ id: "v1", role: "assistant", text: "done", detail: { status: "completed", imageEdit: { originalReferences: references, contract: { changes: [clause("shape", "Use [[ref:edit-original-1]] for shape.", "款式"), clause("color", "Use [[ref:edit-original-0]] for color.", "颜色")], preserve: [], forbid: [] } } }, attachments: [{ id: "v1", name: "v1", mediaType: "image", url: "blob:v1" }] }];
    const context = canvasImageEditContext(history);
    expect(context.contract!.changes.map(item => item.text)).toEqual(["Use [[ref:edit-original-0]] for shape.", "Use [[ref:edit-original-1]] for color."]);
});

test("literal artwork Image 2 and ref syntax are preserved rather than treated as input bindings", () => {
    for (const literal of ["Image 2", "[[ref:shirt]]"]) {
        const source = `保留文字“${literal}”`;
        const result = compile(input({ userPrompt: source, draftPrompt: `Preserve wording "${literal}".`, contract: contract({ changes: [], preserve: [clause("lettering", `Keep wording "${literal}" unchanged.`, source)], forbid: [] }) }));
        expect(result.prompt).toContain(`"${literal}"`);
    }
    expect(() => compile(input({ draftPrompt: 'Follow these instructions: "Use Image 2 for color."' }))).toThrow("编号");
});

test("legacy complete reconstruction can cite genuine historical user requests, not assistant descriptions", () => {
    const history: any[] = [{ id: "u1", role: "user", text: "衬衫改粉色" }, { id: "u2", role: "user", text: "七颗纽扣改酒红" }, { id: "v2", role: "assistant", text: "我猜你想要绿色", detail: { status: "completed", imageEdit: { originalReferences: [original], originalPrompt: "衬衫改粉色", editPrompt: "Make the buttons burgundy." } }, attachments: [{ id: "v2", name: "v2", mediaType: "image", url: "blob:v2" }] }];
    const context = canvasImageEditContext(history);
    const editContract = contract({ changes: [clause("fabric", "Make the shirt pink.", "衬衫改粉色"), clause("buttons", "Make seven buttons burgundy.", "七颗纽扣改酒红")], preserve: [], forbid: [], referenceRoles: [{ id: "edit-original-0", role: "base" }] });
    const next = resolveCanvasImageEdit({ editIntent: "correct_original", prompt: "Redo the complete goal.", editContract }, context, () => [], "这版错了，重新做");
    expect(next.prompt).toContain("pink");
    expect(next.prompt).toContain("burgundy");
    expect(context.legacyUserSources).not.toContain("我猜你想要绿色");
});

test("full prompt size is checked with intent and shared reference prefixes, never truncated", () => {
    const long = "Keep the exact original fabric texture. ".repeat(49);
    const large = contract({ changes: Array.from({ length: 24 }, (_, i) => clause(`change-${i}`, long, "保持原图纹理")), preserve: Array.from({ length: 24 }, (_, i) => clause(`keep-${i}`, long, "保持原图纹理")), forbid: [] });
    expect(() => compile(input({ userPrompt: "保持原图纹理", contract: large }))).toThrow("20000");
    const small = compile(input());
    expect(() => compile(input({ prefix: "A".repeat(20_000 - small.prompt.length) }))).toThrow("20000");
});

// Self-contained reconstruction of canvas-round1/2-llm.sse (2026-10-17): no network or output-folder dependency.
function recordedCanvasRound2() {
    const previous: CanvasEditContract = {
        changes: [clause("recolor_fabric", "Change the fabric color of the shirt body, collar, both sleeves and cuffs to light rose pink", "把衣身、领子、两只袖子和袖口的面料改成浅玫瑰粉色"), clause("single_output", "Generate only one image", "只生成1张")],
        preserve: [clause("buttons", "Keep the seven off-white buttons unchanged in color, count, shape and position", "七颗米白纽扣的颜色、数量、形状和位置保持不变"), clause("structure", "Keep long-sleeve fit, pointed collar, placket, stitching, hem unchanged", "长袖版型、翻领、门襟、缝线、衣摆"), clause("texture_bg", "Keep fabric texture, white background, proportions, position and shadows unchanged", "面料纹理、白色背景、比例位置和阴影也保持不变")],
        forbid: [clause("no_additions", "Do not add pockets, text, patterns, logos or decorations", "不要增加口袋、文字、图案、Logo或装饰")],
    };
    const contract = {
        mode: "update",
        changes: [clause("recolor_buttons", "Change all seven placket buttons to a deep burgundy wine-red color", "把门襟七颗纽扣改成深酒红色，取代上一轮保留米白纽扣的要求")],
        preserve: [clause("button_shape_position", "Keep the seven buttons' count, shape and positions unchanged from the original", "门襟七颗纽扣"), clause("structure", "Keep long-sleeve fit, pointed collar, placket, stitching, hem unchanged", "其他版型、翻领、门襟、缝线、衣摆"), clause("texture_bg", "Keep fabric texture, white background, proportions, position and shadows unchanged", "纹理、位置比例、白底和阴影保持原图")],
        forbid: [clause("no_additions", "Do not add pockets, text, patterns, logos or decorations", "不加口袋、文字、图案、Logo或装饰")],
        supersedes: ["buttons"], referenceRoles: [{ id: "edit-original-0", role: "base" }],
    };
    return {
        previous, contract, continuing: true,
        userPrompt: "这次请回到本任务最初上传的米白色原图重新改，不要以上一张生成结果作底图。继续保留上一轮要求的浅玫瑰粉色衣身、领子、两只袖子和袖口，同时把门襟七颗纽扣改成深酒红色，取代上一轮保留米白纽扣的要求。其他版型、翻领、门襟、缝线、衣摆、纹理、位置比例、白底和阴影保持原图，不加口袋、文字、图案、Logo或装饰。只生成1张。",
        draftPrompt: "Edit the base shirt photo [[ref:edit-original-0]]. Change the fabric color of the shirt body, collar, both sleeves and cuffs to light rose pink. Change all seven placket buttons to a deep burgundy wine-red color. Keep the button count (seven), shape, size and positions exactly as in the original. Keep the long-sleeve fit, pointed collar, placket, stitching, hem, fabric texture, proportions, position, white background and shadows identical to the original. Do not add pockets, text, patterns, logos or decorations. Generate only one image.",
        references: [{ ...original, id: "edit-original-0" }],
    };
}

test("captured round-two update treats exact repeated targets as no-ops and retains their original provenance", () => {
    const replay = recordedCanvasRound2(), before = JSON.stringify(replay);
    const result = compile(replay);
    expect(result.prompt).toContain("light rose pink");
    expect(result.prompt).toContain("deep burgundy wine-red");
    expect(result.prompt).not.toContain("seven off-white buttons");
    for (const [group, id] of [["preserve", "structure"], ["preserve", "texture_bg"], ["forbid", "no_additions"]] as const) {
        expect(result.contract[group].filter(item => item.id === id)).toEqual([replay.previous[group].find(item => item.id === id)!]);
    }
    expect(result.contract.changes).toHaveLength(3);
    expect(result.contract.preserve).toHaveLength(3);
    expect(result.contract.forbid).toHaveLength(1);
    expect(JSON.stringify(replay)).toBe(before);
});

test("identical same-group repetitions normalize whitespace only and never replace saved source", () => {
    const replay = recordedCanvasRound2();
    replay.contract.preserve.find(item => item.id === "structure")!.text = "  Keep  long-sleeve fit,\npointed collar, placket, stitching, hem unchanged  ";
    replay.contract.preserve.find(item => item.id === "structure")!.source = "ignored repeat provenance must not be persisted";
    const result = compile(replay);
    expect(result.contract.preserve.find(item => item.id === "structure")).toEqual(replay.previous.preserve.find(item => item.id === "structure"));
});

test("changed text or cross-group reuse still requires explicit supersedes", () => {
    const changed = recordedCanvasRound2();
    changed.contract.preserve.find(item => item.id === "structure")!.text += ". Also add a second collar.";
    expect(() => compile(changed)).toThrow("显式 supersedes");
    const moved = recordedCanvasRound2();
    const item = moved.contract.preserve.find(item => item.id === "structure")!;
    moved.contract.preserve = moved.contract.preserve.filter(item => item.id !== "structure");
    moved.contract.changes.push(item);
    expect(() => compile(moved)).toThrow("显式 supersedes");
    // Case changes are not whitespace normalization or semantic equivalence.
    const caseChanged = recordedCanvasRound2();
    caseChanged.contract.preserve.find(item => item.id === "structure")!.text = caseChanged.contract.preserve.find(item => item.id === "structure")!.text.toUpperCase();
    expect(() => compile(caseChanged)).toThrow("显式 supersedes");
});

test("superseded historical preservation does not hide a separate current prohibition", () => {
    const replay = recordedCanvasRound2();
    const source = "把门襟七颗纽扣改成深酒红色，取代上一轮保留米白纽扣的要求，不要增加口袋";
    replay.userPrompt = source;
    replay.contract.changes[0]!.source = source;
    expect(() => compile(replay)).toThrow("禁止或保留");
    const missingNumber = recordedCanvasRound2();
    missingNumber.contract.changes[0]!.text = "Change the placket buttons to burgundy.";
    expect(() => compile(missingNumber)).toThrow("数量");
    const noSupersedes = recordedCanvasRound2();
    noSupersedes.contract.supersedes = [];
    expect(() => compile(noSupersedes)).toThrow("禁止或保留");
    const unrelatedHistory = recordedCanvasRound2();
    unrelatedHistory.userPrompt = unrelatedHistory.userPrompt.replace("取代上一轮保留米白纽扣的要求", "取代上一轮保留白底的要求");
    unrelatedHistory.contract.changes[0]!.source = unrelatedHistory.contract.changes[0]!.source.replace("取代上一轮保留米白纽扣的要求", "取代上一轮保留白底的要求");
    expect(() => compile(unrelatedHistory)).toThrow("禁止或保留");
});

test("captured round-two payload also passes the full base-selection replay with saved targets intact", () => {
    const replay = recordedCanvasRound2();
    const history: any[] = [{ id: "pink", role: "assistant", text: "generated", detail: { status: "completed", imageEdit: { intent: "new", originalReferences: [original], originalPrompt: "把衣身、领子、两只袖子和袖口的面料改成浅玫瑰粉色", editPrompt: "Recolor fabric pink.", baseReferences: [original], contract: replay.previous } }, attachments: [{ id: "pink", name: "pink", mediaType: "image", url: "data:image/png;base64,PINK" }] }];
    const context = canvasImageEditContext(history);
    const result = resolveCanvasImageEdit({ editIntent: "explicit", prompt: replay.draftPrompt, editContract: replay.contract }, context, () => context.originals, replay.userPrompt);
    expect(result.references.map(ref => ref.dataUrl)).toEqual([original.dataUrl]);
    expect(result.prompt).toContain("light rose pink");
    expect(result.prompt).toContain("deep burgundy wine-red");
    expect(result.prompt).not.toContain("seven off-white buttons");
    expect(result.lineage.contract!.preserve.find(item => item.id === "structure")!.source).toBe(replay.previous.preserve.find(item => item.id === "structure")!.source);
});

test("eighth paid planner's merged structure rewrite remains rejected, while a true delta inherits unchanged targets", () => {
    // Exact offending structure entry from canvas-round2-retest-llm.sse; retain this negative finding.
    const replay = recordedCanvasRound2();
    replay.contract.changes = [clause("buttons_wine_red", "Change all seven placket buttons to deep burgundy wine red", "把门襟七颗纽扣改成深酒红色")];
    replay.contract.preserve = [clause("buttons_shape_pos", "Keep the seven buttons' count, shape and positions unchanged from the original", "门襟七颗纽扣"), clause("structure", "Keep long-sleeve fit, pointed collar, placket, stitching, hem, fabric texture, proportions, position, white background and shadows identical to the original", "其他版型、翻领、门襟、缝线、衣摆、纹理、位置比例、白底和阴影保持原图")];
    expect(() => compile(replay)).toThrow("显式 supersedes");
    // Model-facing update guidance requests precisely this delta, not a relaxed guard.
    replay.contract.preserve = replay.contract.preserve.filter(item => item.id !== "structure");
    replay.contract.forbid = [];
    const result = compile(replay);
    for (const id of ["structure", "texture_bg"]) expect(result.contract.preserve.find(item => item.id === id)).toEqual(replay.previous.preserve.find(item => item.id === id));
    expect(result.contract.forbid).toEqual(replay.previous.forbid);
    expect(result.prompt).toContain("light rose pink");
    expect(result.prompt).toContain("deep burgundy wine red");
});
