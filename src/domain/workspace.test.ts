import { describe, expect, it } from "vitest";
import {
  addAssetToProject,
  addAssetToProjectAt,
  addGenerationTargetFrame,
  applyGenerationResultToCanvas,
  applyImageOperation,
  connectWorkflowNode,
  commitShapeEdit,
  configureNodeGeneration,
  createInitialWorkspace,
  createProject,
  createWorkflowModuleFromSelection,
  importBatchFolder,
  mergeReferenceSelection,
  runBatchQueue,
  runGeneration,
  runWorkflowChain
} from "./workspace";

describe("designer canvas workspace behavior", () => {
  it("creates isolated projects and tracks designer credits", () => {
    const workspace = createInitialWorkspace({ designerName: "Mia Chen", credits: 42 });
    const first = createProject(workspace, "Lookbook collar variants");
    const second = createProject(first.workspace, "Campaign background tests");

    expect(second.workspace.profile.designerName).toBe("Mia Chen");
    expect(second.workspace.profile.credits).toBe(42);
    expect(second.workspace.projects).toHaveLength(2);
    expect(second.workspace.projects[0].id).not.toBe(second.workspace.projects[1].id);
    expect(second.workspace.activeProjectId).toBe(second.project.id);
  });

  it("adds dragged images as canvas nodes and supports node-level model settings", () => {
    const { workspace, project } = createProject(createInitialWorkspace(), "Trim edits");
    const withAsset = addAssetToProject(workspace, project.id, {
      name: "zipper.png",
      source: "data:image/png;base64,zipper",
      width: 512,
      height: 512
    });

    const node = withAsset.projects[0].nodes[0];
    const configured = configureNodeGeneration(withAsset, project.id, node.id, {
      prompt: "replace metal puller with pearl detail",
      modelId: "flux-pro",
      outputCount: 3,
      entryPoint: "inline"
    });

    expect(configured.projects[0].nodes[0].generation.prompt).toContain("pearl");
    expect(configured.projects[0].nodes[0].generation.modelId).toBe("flux-pro");
    expect(configured.projects[0].nodes[0].generation.outputCount).toBe(3);
    expect(configured.projects[0].nodes[0].generation.entryPoint).toBe("inline");
  });

  it("places dropped images at the canvas pointer location", () => {
    const { workspace, project } = createProject(createInitialWorkspace(), "Dropped references");
    const withAsset = addAssetToProjectAt(
      workspace,
      project.id,
      {
        name: "dropped.png",
        source: "data:image/png;base64,dropped",
        width: 360,
        height: 520
      },
      280,
      420
    );

    expect(withAsset.projects[0].nodes[0]).toMatchObject({
      name: "dropped.png",
      x: 280,
      y: 420,
      width: 360,
      height: 520
    });
  });

  it("adds a generation target frame connected to the selected upstream node", () => {
    const { workspace, project } = createProject(createInitialWorkspace(), "Target frame");
    const withAsset = addAssetToProject(workspace, project.id, {
      name: "reference.png",
      source: "reference",
      width: 360,
      height: 520
    });
    const source = withAsset.projects[0].nodes[0];
    const withTarget = addGenerationTargetFrame(withAsset, project.id);
    const target = withTarget.projects[0].nodes.find((node) => node.metadata.targetFrame)!;

    expect(target).toMatchObject({
      type: "config",
      kind: "workflow",
      name: "Generation target frame"
    });
    expect(withTarget.projects[0].connections).toEqual(
      expect.arrayContaining([expect.objectContaining({ fromNodeId: source.id, toNodeId: target.id })])
    );
  });

  it("generates outputs beside the source image, spends credits, and writes history", () => {
    const { workspace, project } = createProject(createInitialWorkspace({ credits: 10 }), "Sleeve options");
    const withAsset = addAssetToProject(workspace, project.id, {
      name: "sleeve.png",
      source: "sleeve-source",
      width: 800,
      height: 600
    });
    const node = withAsset.projects[0].nodes[0];
    const configured = configureNodeGeneration(withAsset, project.id, node.id, {
      prompt: "make the sleeve satin with soft highlights",
      modelId: "nano-banana",
      outputCount: 2,
      entryPoint: "inspector"
    });

    const generated = runGeneration(configured, project.id, node.id);

    expect(generated.profile.credits).toBe(8);
    expect(generated.projects[0].nodes).toHaveLength(3);
    expect(generated.projects[0].nodes.slice(1).every((item) => item.kind === "generated")).toBe(true);
    expect(generated.projects[0].nodes[1].x).toBeGreaterThan(node.x);
    expect(generated.history[0]).toMatchObject({
      projectId: project.id,
      prompt: "make the sleeve satin with soft highlights",
      modelId: "nano-banana",
      outputCount: 2
    });
  });

  it("collects backend generation outputs into the asset library", () => {
    const { workspace, project } = createProject(createInitialWorkspace({ credits: 10 }), "Generated assets");
    const withAsset = addAssetToProject(workspace, project.id, {
      name: "vest.png",
      source: "vest-source",
      width: 640,
      height: 800
    });
    const source = withAsset.projects[0].nodes[0];
    const request = {
      projectId: project.id,
      nodeId: source.id,
      modelId: "gpt-image-2-medium",
      prompt: "make a new embroidered vest",
      referenceNodeIds: [source.id],
      outputCount: 1,
      operation: "generate" as const
    };
    const updated = applyGenerationResultToCanvas(withAsset, project.id, source.id, request, {
      status: "succeeded",
      historyId: "history-asset",
      creditCost: 7,
      outputs: [{ name: "backend vest.jpg", source: "mock://generate/vest/1", width: 1024, height: 1024 }]
    });

    expect(updated.projects[0].nodes.some((node) => node.name === "backend vest.jpg")).toBe(true);
    expect(updated.assets[0]).toMatchObject({
      title: "backend vest.jpg",
      type: "image",
      tags: ["generated", "generate"],
      metadata: { projectId: project.id, historyId: "history-asset", operation: "generate" }
    });
  });

  it("creates editable derivatives from toolbar operations and confirmed shape edits", () => {
    const { workspace, project } = createProject(createInitialWorkspace(), "Mask edits");
    const withAsset = addAssetToProject(workspace, project.id, {
      name: "bag.png",
      source: "bag-source",
      width: 640,
      height: 640
    });
    const source = withAsset.projects[0].nodes[0];
    const upscaled = applyImageOperation(withAsset, project.id, source.id, "upscale");
    const edited = commitShapeEdit(upscaled, project.id, source.id, {
      shape: "ellipse",
      prompt: "paint a circular floral patch on the pocket"
    });

    expect(edited.projects[0].nodes).toHaveLength(3);
    expect(edited.projects[0].nodes[1]).toMatchObject({ kind: "operation", operation: "upscale", references: [source.id] });
    expect(edited.projects[0].nodes[2]).toMatchObject({ kind: "edit", editShape: "ellipse", references: [source.id] });
    expect(edited.projects[0].nodes[2].source).toContain("#shape-edit");
    expect(edited.projects[0].nodes[2].x).toBeGreaterThan(source.x);
  });

  it("imports a batch folder and processes every image with one prompt", () => {
    const { workspace, project } = createProject(createInitialWorkspace({ credits: 8 }), "Batch material cleanup");
    const queued = importBatchFolder(workspace, project.id, {
      folderName: "raw trims",
      prompt: "remove background and normalize lighting",
      modelId: "background-cleaner",
      outputCount: 1,
      files: [
        { name: "a.png", source: "a", width: 300, height: 300 },
        { name: "b.png", source: "b", width: 300, height: 300 },
        { name: "c.png", source: "c", width: 300, height: 300 }
      ]
    });
    const processed = runBatchQueue(queued, project.id);

    expect(processed.projects[0].batchQueue).toHaveLength(3);
    expect(processed.projects[0].batchQueue.every((item) => item.status === "done")).toBe(true);
    expect(processed.projects[0].nodes.filter((node) => node.kind === "generated")).toHaveLength(3);
    expect(processed.profile.credits).toBe(5);
  });

  it("pulls a workflow module from an image and runs chained edit then upscale steps", () => {
    const { workspace, project } = createProject(createInitialWorkspace({ credits: 6 }), "Workflow chain");
    const withAsset = addAssetToProject(workspace, project.id, {
      name: "coat.png",
      source: "coat-source",
      width: 640,
      height: 640
    });
    const source = withAsset.projects[0].nodes[0];
    const editModule = createWorkflowModuleFromSelection(withAsset, project.id, [source.id], {
      moduleType: "edit",
      prompt: "add a detachable hood",
      modelId: "style-edit"
    });
    const editNode = editModule.projects[0].nodes.find((node) => node.kind === "workflow" && node.moduleType === "edit");
    const upscaleModule = createWorkflowModuleFromSelection(editModule, project.id, [editNode!.id], {
      moduleType: "upscale",
      prompt: "preserve fabric texture while enlarging",
      modelId: "upscale-pro"
    });

    const executed = runWorkflowChain(upscaleModule, project.id, source.id);

    expect(executed.projects[0].connections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ from: source.id, to: editNode!.id, fromNodeId: source.id, toNodeId: editNode!.id })
      ])
    );
    expect(executed.projects[0].connections).toEqual(
      expect.arrayContaining([expect.objectContaining({ from: editNode!.id, fromNodeId: editNode!.id, to: expect.any(String) })])
    );
    expect(executed.projects[0].nodes.filter((node) => node.kind === "generated")).toHaveLength(2);
    expect(executed.history.map((entry) => entry.moduleType)).toEqual(["upscale", "edit"]);
    expect(executed.profile.credits).toBe(4);
  });

  it("groups multiple uploaded reference images and connects them to one generation module", () => {
    const { workspace, project } = createProject(createInitialWorkspace({ credits: 4 }), "Two reference dress");
    const first = addAssetToProject(workspace, project.id, {
      name: "front.png",
      source: "front",
      width: 500,
      height: 700
    });
    const second = addAssetToProject(first, project.id, {
      name: "texture.png",
      source: "texture",
      width: 500,
      height: 700
    });
    const [front, texture] = second.projects[0].nodes;

    const grouped = mergeReferenceSelection(second, project.id, [front.id, texture.id], "front + texture references");
    const groupNode = grouped.projects[0].nodes.find((node) => node.kind === "referenceGroup")!;
    const withGenerationModule = createWorkflowModuleFromSelection(grouped, project.id, [groupNode.id], {
      moduleType: "generate",
      prompt: "参考图一图二做一款新的连衣裙",
      modelId: "fashion-concept"
    });
    const executed = runWorkflowChain(withGenerationModule, project.id, groupNode.id);

    expect(groupNode.referenceIds).toEqual([front.id, texture.id]);
    expect(executed.projects[0].connections).toEqual(
      expect.arrayContaining([expect.objectContaining({ from: groupNode.id, fromNodeId: groupNode.id, to: expect.any(String) })])
    );
    expect(executed.projects[0].nodes.some((node) => node.kind === "generated" && node.referenceIds?.length === 2)).toBe(true);
    expect(executed.history[0]).toMatchObject({
      prompt: "参考图一图二做一款新的连衣裙",
      referenceCount: 2,
      modelId: "fashion-concept"
    });
  });

  it("rejects empty prompts before spending credits", () => {
    const { workspace, project } = createProject(createInitialWorkspace({ credits: 2 }), "Guard rails");
    const withAsset = addAssetToProject(workspace, project.id, {
      name: "empty.png",
      source: "empty",
      width: 300,
      height: 300
    });
    const node = withAsset.projects[0].nodes[0];
    const configured = configureNodeGeneration(withAsset, project.id, node.id, {
      prompt: "  ",
      modelId: "flux-pro",
      outputCount: 1,
      entryPoint: "inline"
    });

    expect(() => runGeneration(configured, project.id, node.id)).toThrow("Prompt is required");
    expect(configured.profile.credits).toBe(2);
  });
});
