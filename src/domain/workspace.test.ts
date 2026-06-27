import { describe, expect, it } from "vitest";
import {
  addAssetToProject,
  addAssetToProjectAt,
  addGenerationTargetFrame,
  applyGenerationResultToCanvas,
  applyImageOperation,
  buildWorkflowExecutionPlan,
  connectWorkflowNode,
  commitShapeEdit,
  configureNodeGeneration,
  createInitialWorkspace,
  createProject,
  createWorkflowModuleFromSelection,
  importBatchFolder,
  markNodeRunState,
  mergeReferenceSelection,
  runBatchQueue,
  runGeneration,
  runWorkflowChain,
  saveNodeAsAsset,
  savePromptPreset,
  selectNodes,
  deletePromptPreset
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

  it("keeps backend run state visible after normal canvas selection changes", () => {
    const { workspace, project } = createProject(createInitialWorkspace(), "Run state feedback");
    const withAsset = addAssetToProject(workspace, project.id, {
      name: "vest.png",
      source: "vest-source",
      width: 512,
      height: 640
    });
    const withSecondAsset = addAssetToProject(withAsset, project.id, {
      name: "texture.png",
      source: "texture-source",
      width: 300,
      height: 300
    });
    const [source, texture] = withSecondAsset.projects[0].nodes;
    const undoCount = withSecondAsset.projects[0].undoStack.length;

    const running = markNodeRunState(withSecondAsset, project.id, source.id, "running");
    expect(running.projects[0].nodes[0]).toMatchObject({
      status: "running",
      metadata: { runStatus: "running" }
    });
    expect(running.projects[0].undoStack).toHaveLength(undoCount);

    const failed = markNodeRunState(running, project.id, source.id, "error", "Provider offline");
    expect(failed.projects[0].nodes[0]).toMatchObject({
      status: "error",
      errorMessage: "Provider offline",
      metadata: { runStatus: "error", errorMessage: "Provider offline" }
    });

    const selectedOtherNode = selectNodes(failed, project.id, [texture.id]);
    expect(selectedOtherNode.projects[0].nodes[0].status).toBe("error");
    expect(selectedOtherNode.projects[0].nodes[0].errorMessage).toBe("Provider offline");
    expect(selectedOtherNode.projects[0].nodes[1].status).toBe("selected");

    const reset = markNodeRunState(selectedOtherNode, project.id, source.id, "idle");
    expect(reset.projects[0].nodes[0].status).toBe("idle");
    expect(reset.projects[0].nodes[0].errorMessage).toBeUndefined();
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

  it("places imported reference images side by side instead of overlapping", () => {
    const { workspace, project } = createProject(createInitialWorkspace(), "Reference layout");
    const first = addAssetToProject(workspace, project.id, {
      name: "front.png",
      source: "front",
      width: 360,
      height: 520
    });
    const second = addAssetToProject(first, project.id, {
      name: "texture.png",
      source: "texture",
      width: 360,
      height: 520
    });
    const [front, texture] = second.projects[0].nodes;

    expect(texture.x - front.x).toBeGreaterThanOrEqual(front.width);
    expect(texture.y).toBe(front.y);
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
    expect(generated.projects[0].nodes[1].metadata).toMatchObject({
      historyId: generated.history[0].id,
      creditCost: 2,
      operation: "generate",
      prompt: "make the sleeve satin with soft highlights",
      modelId: "nano-banana"
    });
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
      metadata: { projectId: project.id, historyId: "history-asset", operation: "generate", width: 1024, height: 1024 }
    });
  });

  it("keeps saved asset dimensions for reuse on the canvas", () => {
    const { workspace, project } = createProject(createInitialWorkspace(), "Reusable assets");
    const withAsset = addAssetToProject(workspace, project.id, {
      name: "look-reference.png",
      source: "look-source",
      width: 720,
      height: 960
    });
    const node = withAsset.projects[0].nodes[0];
    const saved = saveNodeAsAsset(withAsset, project.id, node.id);

    expect(saved.assets[0]).toMatchObject({
      title: "look-reference.png",
      metadata: { projectId: project.id, nodeId: node.id, width: 720, height: 960 }
    });
  });

  it("saves designer prompts into the reusable prompt library and can remove them", () => {
    const workspace = createInitialWorkspace();
    const saved = savePromptPreset(workspace, {
      prompt: "Generate a clean embroidered vest concept from the selected references.",
      tags: ["Designer", "Vest", "designer"]
    });

    expect(saved.prompts[0]).toMatchObject({
      title: "Generate a clean embroidered vest concept...",
      prompt: "Generate a clean embroidered vest concept from the selected references.",
      tags: ["designer", "vest"],
      source: "designer"
    });

    const removed = deletePromptPreset(saved, saved.prompts[0].id);
    expect(removed.prompts.some((prompt) => prompt.id === saved.prompts[0].id)).toBe(false);
  });

  it("rejects empty prompt library saves", () => {
    expect(() => savePromptPreset(createInitialWorkspace(), { prompt: "   " })).toThrow("Prompt is required");
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
      prompt: "paint a circular floral patch on the pocket",
      mask: { x: 18, y: 22, width: 42, height: 36 }
    });

    expect(edited.projects[0].nodes).toHaveLength(3);
    expect(edited.projects[0].nodes[1]).toMatchObject({ kind: "operation", operation: "upscale", references: [source.id] });
    expect(edited.projects[0].nodes[2]).toMatchObject({ kind: "edit", editShape: "ellipse", references: [source.id] });
    expect(edited.projects[0].nodes[2].metadata.mask).toEqual({ x: 18, y: 22, width: 42, height: 36 });
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
    const generatedOutputs = executed.projects[0].nodes.filter((node) => node.kind === "generated");
    for (const output of generatedOutputs) {
      const history = executed.history.find((entry) => entry.nodeId === output.parentId);
      expect(history).toBeDefined();
      expect(output.metadata).toMatchObject({
        historyId: history!.id,
        creditCost: history!.creditCost,
        moduleType: history!.moduleType,
        operation: history!.operation
      });
    }
    expect(executed.profile.credits).toBe(4);
  });

  it("builds an auditable workflow execution plan before running chained image operations", () => {
    const { workspace, project } = createProject(createInitialWorkspace({ credits: 40 }), "Workflow plan");
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
      modelId: "gpt-image-2-medium"
    });
    const editNode = editModule.projects[0].nodes.find((node) => node.moduleType === "edit")!;
    const upscaleModule = createWorkflowModuleFromSelection(editModule, project.id, [editNode.id], {
      moduleType: "upscale",
      prompt: "preserve fabric texture while enlarging",
      modelId: "upscale-pro"
    });
    const upscaleNode = upscaleModule.projects[0].nodes.find((node) => node.moduleType === "upscale")!;
    const removeBgModule = createWorkflowModuleFromSelection(upscaleModule, project.id, [upscaleNode.id], {
      moduleType: "removeBackground",
      prompt: "remove the studio background and keep transparent edges",
      modelId: "background-cleaner"
    });

    const plan = buildWorkflowExecutionPlan(removeBgModule, project.id, source.id);

    expect(plan.status).toBe("ready");
    expect(plan.steps.map((step) => step.moduleType)).toEqual(["edit", "upscale", "removeBackground"]);
    expect(plan.steps.map((step) => step.operation)).toEqual(["edit", "upscale", "removeBackground"]);
    expect(plan.steps.map((step) => step.referenceNodeIds)).toEqual([[source.id], [editNode.id], [upscaleNode.id]]);
    expect(plan.totalEstimatedCredits).toBe(13);
    expect(plan.issues).toEqual([]);
  });

  it("blocks workflow execution plans with missing prompts or cycles before credits are spent", () => {
    const { workspace, project } = createProject(createInitialWorkspace({ credits: 20 }), "Broken workflow plan");
    const withAsset = addAssetToProject(workspace, project.id, {
      name: "coat.png",
      source: "coat-source",
      width: 640,
      height: 640
    });
    const source = withAsset.projects[0].nodes[0];
    const editModule = createWorkflowModuleFromSelection(withAsset, project.id, [source.id], {
      moduleType: "edit",
      prompt: "   ",
      modelId: "gpt-image-2-medium"
    });
    const editNode = editModule.projects[0].nodes.find((node) => node.moduleType === "edit")!;
    const upscaleModule = createWorkflowModuleFromSelection(editModule, project.id, [editNode.id], {
      moduleType: "upscale",
      prompt: "preserve fabric texture while enlarging",
      modelId: "upscale-pro"
    });
    const upscaleNode = upscaleModule.projects[0].nodes.find((node) => node.moduleType === "upscale")!;
    const cyclic = connectWorkflowNode(upscaleModule, project.id, upscaleNode.id, editNode.id);

    const plan = buildWorkflowExecutionPlan(cyclic, project.id, source.id);

    expect(plan.status).toBe("blocked");
    expect(plan.steps).toHaveLength(2);
    expect(plan.totalEstimatedCredits).toBe(11);
    expect(plan.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ nodeId: editNode.id, severity: "error", message: "Prompt is required" }),
        expect.objectContaining({ nodeId: editNode.id, severity: "error", message: "Workflow cycle detected" })
      ])
    );
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

  it("connects multiple selected image references directly to one workflow module", () => {
    const { workspace, project } = createProject(createInitialWorkspace(), "Direct multi reference");
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

    const withModule = createWorkflowModuleFromSelection(second, project.id, [front.id, texture.id], {
      moduleType: "generate",
      prompt: "Use both references as one design context",
      modelId: "gpt-image-2-medium"
    });
    const module = withModule.projects[0].nodes.find((node) => node.moduleType === "generate")!;

    expect(module.references).toEqual([front.id, texture.id]);
    expect(withModule.projects[0].connections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ fromNodeId: front.id, toNodeId: module.id }),
        expect.objectContaining({ fromNodeId: texture.id, toNodeId: module.id })
      ])
    );
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
