import { expect, test } from "bun:test";
import { imageAgentCandidateIds, imageAgentVersion, type ImageAgentImage } from "../../shared/image-agent/focus";
import { compileImageAgentPrompt } from "../../shared/image-agent/compile";

test("persisted version numbers never become array positions after paging or branching", () => {
  const images: ImageAgentImage[] = [
    { id: "root", label: "图1", kind: "upload", workId: "root", versionNo: 1 },
    { id: "branch", label: "图8", kind: "generated", parentId: "root", workId: "root", versionNo: 8 },
    { id: "sibling", label: "图5", kind: "generated", parentId: "root", workId: "root", versionNo: 5 },
  ];
  expect(imageAgentVersion(images, "branch")).toBe(8);
  expect(imageAgentVersion([...images].reverse(), "sibling")).toBe(5);
  expect(imageAgentCandidateIds("请选择 V8 或第5版？", images, { focusId: "branch" })).toEqual(["branch", "sibling"]);
  expect(imageAgentCandidateIds("请选择 V2？", images, { focusId: "branch" })).toEqual([]);
});

test("backend and browser share base-first compilation and preservation semantics", () => {
  const result = compileImageAgentPrompt({ prompt: "改为V领", keep: ["红色衣身", "针织纹理"], baseImageId: "source",
    images: [{ id: "source", label: "图1 · V1" }] });
  expect(result.prompt).toContain("输入图1对应图1 · V1（修改底图）");
  expect(result.prompt).toContain("红色衣身；针织纹理");
  expect(result.prompt).toContain("除本次明确修改外，其余保持底图不变。");
  expect(() => compileImageAgentPrompt({ prompt: "改色", keep: [], baseImageId: "source", images: [{ id: "wrong", label: "图2" }] })).toThrow("第一张");
});
