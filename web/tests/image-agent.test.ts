import { describe, expect, test } from "bun:test";
import { getImageAgentVersions, imageAgentCandidateIds, imageAgentVersion, resolveImageAgentBase, resolveImageAgentFocus, selectImageAgentWorkingSet, type ImageAgentImage } from "../src/lib/image-agent/focus";
import { buildImageAgentContext, imageAgentHistoryMessages } from "../src/lib/image-agent/context";
import { imageAgentWorkNoteText, mergeImageAgentWorkNote } from "../src/lib/image-agent/work-note";

const images: ImageAgentImage[] = [
    { id: "original", label: "图1", name: "T恤", kind: "upload" },
    { id: "v2", label: "图2", kind: "generated", parentId: "original" },
    { id: "v3", label: "图3", kind: "generated", parentId: "v2" },
    { id: "palette", label: "图4", name: "配色", kind: "upload" },
];
const pixel = "data:image/png;base64,aW1hZ2U=";

describe("shared image agent focus and work set", () => {
    test("continuous follow-up uses the latest result, never the latest palette upload", () => {
        expect(resolveImageAgentFocus(images)?.id).toBe("v3");
        expect(resolveImageAgentBase(images, {}, undefined)?.id).toBe("v3");
    });
    test("an explicit old image stays authoritative even when the planner asks for none", () => {
        expect(resolveImageAgentBase(images, { focusId: "v3", lockedImageId: "v2" }, "none")?.id).toBe("v2");
    });
    test("a new creation clears the base even with an old focus", () => {
        expect(resolveImageAgentBase(images, { focusId: "v3", lockedImageId: "v2", newCreation: true })).toBeUndefined();
    });
    test("the planner can explicitly start a new work when no UI lock exists", () => {
        expect(resolveImageAgentBase(images, { focusId: "v3" }, "none")).toBeUndefined();
    });
    test("original follows this branch's parent links", () => {
        expect(resolveImageAgentBase(images, { focusId: "v3" }, "original")?.id).toBe("original");
    });
    test("previous resolves one step, not the chronologically previous upload", () => {
        expect(resolveImageAgentBase(images, { focusId: "v3" }, "previous")?.id).toBe("v2");
    });
    test("stable labels and persistent IDs both resolve", () => {
        expect(resolveImageAgentBase(images, {}, "图2")?.id).toBe("v2");
        expect(resolveImageAgentBase(images, {}, "v2")?.id).toBe("v2");
    });
    test("foreign IDs fail without substituting a different base", () => {
        expect(() => resolveImageAgentBase(images, {}, "someone-else-image")).toThrow("重新选择");
    });
    test("an unavailable latest result fails rather than silently editing older work", () => {
        expect(() => resolveImageAgentFocus([...images, { id: "missing", label: "图5", kind: "generated", unavailableReason: "missing" }])).toThrow("不会自动换成其他图");
    });
    test("first upload is the focus when no work exists", () => {
        expect(resolveImageAgentFocus([images[0]!])?.id).toBe("original");
    });
    test("new reference does not replace focus and the actual original/previous are included", () => {
        expect(selectImageAgentWorkingSet(images, { focusId: "v3", uploadIds: ["palette"] }).map(item => item.id)).toEqual(["palette", "v3", "original", "v2"]);
    });
    test("unrelated works and visible nodes never enter a context implicitly", () => {
        const catalog = [...images, { id: "other", label: "图5", kind: "upload" as const }];
        expect(selectImageAgentWorkingSet(catalog, { focusId: "v3" }).map(item => item.id)).toEqual(["v3", "original", "v2"]);
    });
    test("mandatory images exceeding five fail rather than dropping references", () => {
        const catalog = [...images, ...Array.from({ length: 5 }, (_, i) => ({ id: `ref-${i}`, label: `图${i + 5}`, kind: "upload" as const }))];
        expect(() => selectImageAgentWorkingSet(catalog, { focusId: "v3", uploadIds: catalog.slice(-5).map(item => item.id) })).toThrow("最多 5 张");
    });
    test("a branch stays with its own work's versions", () => {
        const catalog = [...images, { id: "branch", label: "图5", kind: "generated" as const, parentId: "v2" }];
        expect(getImageAgentVersions(catalog, "branch").map(item => item.id)).toEqual(["original", "v2", "v3", "branch"]);
        expect(imageAgentVersion(catalog, "branch")).toBe(4);
    });
    test("missing ancestors allow current edit but not an invented original", () => {
        const catalog = [images[2]!];
        expect(selectImageAgentWorkingSet(catalog, { focusId: "v3" }).map(item => item.id)).toEqual(["v3"]);
        expect(() => resolveImageAgentBase(catalog, { focusId: "v3" }, "original")).toThrow("原图已不可用");
    });
    test("cyclic histories cannot loop forever", () => {
        const cycle = [{ ...images[1]!, parentId: "v3" }, images[2]!];
        expect(() => resolveImageAgentBase(cycle, { focusId: "v3" }, "original")).toThrow("版本关系异常");
    });
});

describe("image-agent clarification candidates", () => {
    const catalog: ImageAgentImage[] = [
        { id: "hat-original", label: "图1", name: "蓝色帽子", kind: "upload" },
        { id: "hat-cream", label: "图2", name: "米色帽子", kind: "generated", parentId: "hat-original" },
        { id: "hat-small", label: "图3", name: "小皮标帽子", kind: "generated", parentId: "hat-cream" },
        { id: "shirt-original", label: "图10", name: "衬衫", kind: "upload" },
        { id: "shirt-edited", label: "图11", name: "V领衬衫", kind: "generated", parentId: "shirt-original" },
    ];
    test("stable labels and complete IDs are choices, not substring matches", () => {
        expect(imageAgentCandidateIds("你想改图1还是图2？", catalog)).toEqual(["hat-original", "hat-cream"]);
        expect(imageAgentCandidateIds("图10还是 hat-cream？", catalog)).toEqual(["hat-cream", "shirt-original"]);
        expect(imageAgentCandidateIds("选择图1: 蓝色，还是图2: 米色？", catalog)).toEqual(["hat-original", "hat-cream"]);
        expect(imageAgentCandidateIds("图100还是 other-hat-original-copy？", catalog)).toEqual([]);
    });
    test("unique literal names produce the same candidates without requiring image numbers", () => {
        expect(imageAgentCandidateIds("你是想改蓝色帽子还是米色帽子？", catalog)).toEqual(["hat-original", "hat-cream"]);
        expect(imageAgentCandidateIds("请确认是否修改米色帽子", catalog)).toEqual(["hat-cream"]);
    });
    test("duplicate names cannot identify one image even if only one is readable", () => {
        const duplicate = [...catalog, { id: "missing", label: "图12", name: "米色帽子", kind: "upload" as const, unavailableReason: "missing" }];
        expect(imageAgentCandidateIds("米色帽子还是蓝色帽子？", duplicate)).toEqual(["hat-original"]);
        expect(imageAgentCandidateIds("图2还是图12？", duplicate)).toEqual(["hat-cream"]);
    });
    test("a shorter name is not selected from inside another image's name", () => {
        expect(imageAgentCandidateIds("V领衬衫还是蓝色帽子？", catalog)).toEqual(["hat-original", "shirt-edited"]);
        expect(imageAgentCandidateIds("衬衫还是V领衬衫？", catalog)).toEqual(["shirt-original", "shirt-edited"]);
    });
    test("literal punctuation and English word boundaries do not invent matches", () => {
        const punctuation = [{ id: "a", label: "图1", name: "hat (blue)+", kind: "upload" as const }];
        expect(imageAgentCandidateIds("选择 hat (blue)+？", punctuation)).toEqual(["a"]);
        expect(imageAgentCandidateIds("that (blue)+ looks fine？", punctuation)).toEqual([]);
    });
    test("version aliases require an explicit valid focus, never the latest image heuristic", () => {
        for (const context of [{}, { focusId: "missing" }, { focusId: "hat-small", newCreation: true }]) {
            expect(imageAgentCandidateIds("上一版还是当前版，或V2与第1版？", catalog, context)).toEqual([]);
        }
        expect(imageAgentCandidateIds("原图还是当前版？", [{ ...catalog[0]!, name: "原图" }])).toEqual([]);
    });
    test("current, previous and original are scoped to the explicit focus branch", () => {
        const branch = [...catalog, { id: "hat-branch", label: "图12", kind: "generated" as const, parentId: "hat-cream" }];
        expect(imageAgentCandidateIds("原图、上一版还是当前版？", branch, { focusId: "hat-branch" })).toEqual(["hat-original", "hat-cream", "hat-branch"]);
        expect(imageAgentCandidateIds("上一版还是当前版本？", catalog, { focusId: "shirt-edited" })).toEqual(["shirt-original", "shirt-edited"]);
    });
    test("numbered versions use the same work order as the visible version strip", () => {
        expect(imageAgentCandidateIds("V2还是第3版？", catalog, { focusId: "hat-small" })).toEqual(["hat-cream", "hat-small"]);
        expect(imageAgentCandidateIds("v2还是第1版？", catalog, { focusId: "shirt-edited" })).toEqual(["shirt-original", "shirt-edited"]);
        expect(imageAgentCandidateIds("V20、V0、AV2还是第50版？", catalog, { focusId: "hat-small" })).toEqual([]);
    });
    test("missing, unavailable and cyclic ancestors never become invented originals", () => {
        const missing = [{ ...catalog[2]!, parentId: "missing" }];
        expect(imageAgentCandidateIds("原图还是上一版？", missing, { focusId: "hat-small" })).toEqual([]);
        const cyclic = [{ ...catalog[0]!, parentId: "hat-cream" }, catalog[1]!];
        expect(imageAgentCandidateIds("原图？", cyclic, { focusId: "hat-cream" })).toEqual([]);
        expect(imageAgentCandidateIds("当前图？", [{ ...catalog[0]!, unavailableReason: "missing" }], { focusId: "hat-original" })).toEqual([]);
    });
    test("ordinary responses do not create choices and suggestions cannot mutate focus", () => {
        const context = { focusId: "hat-small" }, before = JSON.stringify({ catalog, context });
        expect(imageAgentCandidateIds("已将蓝色帽子改为米色，见图2。", catalog, context)).toEqual([]);
        expect(imageAgentCandidateIds("原图还是图2？", catalog, context)).toEqual(["hat-original", "hat-cream"]);
        expect(JSON.stringify({ catalog, context })).toBe(before);
        expect(resolveImageAgentFocus(catalog, context)?.id).toBe("hat-small");
    });
    test("choices stay bounded even when a clarification mentions every image", () => {
        const many = Array.from({ length: 8 }, (_, i) => ({ id: `asset-${i}`, label: `图${i + 1}`, kind: "upload" as const }));
        expect(imageAgentCandidateIds(`选择${many.map(item => item.label).join("、")}？`, many)).toEqual(many.slice(0, 5).map(item => item.id));
    });
});

describe("shared natural context and work note", () => {
    test("generated-image labels stay in the original assistant turn; pixels precede current words", async () => {
        const result = await buildImageAgentContext({ images, focusId: "v3", currentText: "颜色再浅点", history: [
            { role: "user", text: "改成V领", inputImageIds: ["original"] },
            { role: "assistant", text: "已修改", generatedImageIds: ["v2"] },
        ], readImage: async () => pixel });
        expect(result.messages[1]).toEqual({ role: "assistant", content: "已修改\n【已生成 图2】" });
        expect(result.messages.at(-1)).toEqual({ role: "user", content: "颜色再浅点" });
        expect(result.previews.map(item => item.id)).toEqual(["v3", "original", "v2"]);
        expect(result.messages.slice(0, -1).some(message => Array.isArray(message.content) && message.content.some(part => part.type === "image_url"))).toBe(true);
    });
    test("long histories are bounded and preserve explicit old requirements through work notes", async () => {
        let note = mergeImageAgentWorkNote(undefined, "白底T恤", ["Logo位置", "白背景"]);
        for (let i = 0; i < 15; i++) note = mergeImageAgentWorkNote(note, `当前浅蓝T恤，第${i + 1}版`);
        const history = Array.from({ length: 40 }, (_, i) => ({ role: (i % 2 ? "assistant" : "user") as "assistant" | "user", text: `第${i + 1}条`, generatedImageIds: i === 1 ? ["v2"] : [] }));
        expect(imageAgentHistoryMessages(history, images)).toHaveLength(21);
        const result = await buildImageAgentContext({ images, focusId: "v3", currentText: "袖子再短一点", history, note, readImage: async () => pixel });
        expect(JSON.stringify(result.messages)).toContain("Logo位置");
        expect(JSON.stringify(result.messages)).toContain("白背景");
        expect(result.messages.length).toBeLessThanOrEqual(23);
        expect(result.messages.at(-1)?.content).toBe("袖子再短一点");
    });
    test("the current-state note replaces superseded prose and remains bounded", () => {
        const note = mergeImageAgentWorkNote(mergeImageAgentWorkNote(undefined, "深蓝T恤", ["版型"]), "浅天蓝T恤", ["白底"]);
        expect(imageAgentWorkNoteText(note)).toBe("浅天蓝T恤\n需保持：白底");
        expect(mergeImageAgentWorkNote(note, "新状态").keep).toEqual(["白底"]);
        expect(mergeImageAgentWorkNote(note, "新状态", []).keep).toEqual([]);
        expect(imageAgentWorkNoteText(mergeImageAgentWorkNote(note, "新状态".repeat(500))).length).toBeLessThanOrEqual(800);
    });
    test("untrusted image sources cannot reach the planner as URLs or missing pixels", async () => {
        await expect(buildImageAgentContext({ images, focusId: "v3", history: [], currentText: "改图", readImage: async () => "http://private/asset" })).rejects.toThrow("预览不可用");
    });
});
