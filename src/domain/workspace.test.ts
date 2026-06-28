import { describe, expect, it } from "vitest";
import {
  addAssetToProject,
  addAssetToProjectAt,
  addConfigNode,
  addGenerationTargetFrame,
  addTextNode,
  applyBatchGenerationResultsToCanvas,
  applyGenerationResultToCanvas,
  buildRetryBatchFromFailures,
  buildWorkflowGenerationRequests,
  applyImageOperation,
  buildWorkflowExecutionPlan,
  cancelBatchQueue,
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
  summarizeBatchQueue,
  deletePromptPreset,
  getWorkflowModuleDefinition,
  getWorkflowApiPathForOperation,
  WORKFLOW_MODULE_REGISTRY
} from "./workspace";
import type { ModelDefinition } from "./workspace";

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

  it("declares first-pass workflow modules in one reusable registry", () => {
    expect(WORKFLOW_MODULE_REGISTRY.map((definition) => definition.moduleType)).toEqual([
      "generate",
      "edit",
      "upscale",
      "removeBackground",
      "batch",
      "upload"
    ]);

    const removeBgDefinition = getWorkflowModuleDefinition("removeBackground");
    expect(removeBgDefinition).toMatchObject({
      moduleType: "removeBackground",
      nodeType: "removeBg",
      operation: "removeBackground",
      label: "Remove BG",
      defaultModelId: "background-cleaner"
    });
    expect(removeBgDefinition.defaultPrompt).toContain("background");

    const { workspace, project } = createProject(createInitialWorkspace({ credits: 20 }), "Registry-backed module");
    const withAsset = addAssetToProject(workspace, project.id, {
      name: "coat.png",
      source: "coat-source",
      width: 640,
      height: 640
    });
    const source = withAsset.projects[0].nodes[0];
    const withModule = createWorkflowModuleFromSelection(withAsset, project.id, [source.id], {
      moduleType: removeBgDefinition.moduleType,
      prompt: removeBgDefinition.defaultPrompt,
      modelId: removeBgDefinition.defaultModelId
    });
    const moduleNode = withModule.projects[0].nodes.find((node) => node.moduleType === "removeBackground")!;
    const plan = buildWorkflowExecutionPlan(withModule, project.id, source.id);

    expect(moduleNode).toMatchObject({
      type: "removeBg",
      generation: expect.objectContaining({
        prompt: removeBgDefinition.defaultPrompt,
        modelId: "background-cleaner"
      })
    });
    expect(plan.steps[0]).toMatchObject({
      moduleType: "removeBackground",
      operation: "removeBackground",
      modelId: "background-cleaner"
    });
  });

  it("keeps backend operation endpoints in the workflow registry", () => {
    expect(WORKFLOW_MODULE_REGISTRY.map((definition) => [definition.moduleType, definition.operation, definition.apiPath])).toEqual([
      ["generate", "generate", "/api/generations"],
      ["edit", "edit", "/api/edits"],
      ["upscale", "upscale", "/api/upscale"],
      ["removeBackground", "removeBackground", "/api/remove-bg"],
      ["batch", "generate", "/api/generations"],
      ["upload", "generate", "/api/generations"]
    ]);

    expect(getWorkflowApiPathForOperation("generate")).toBe("/api/generations");
    expect(getWorkflowApiPathForOperation("edit")).toBe("/api/edits");
    expect(getWorkflowApiPathForOperation("upscale")).toBe("/api/upscale");
    expect(getWorkflowApiPathForOperation("removeBackground")).toBe("/api/remove-bg");
  });

  it("keeps workflow module ports in the registry and applies them to created nodes", () => {
    const editDefinition = getWorkflowModuleDefinition("edit");
    const batchDefinition = getWorkflowModuleDefinition("batch");

    expect(editDefinition.inputPorts).toEqual([
      { id: "image", type: "image", label: "Image" },
      { id: "text", type: "text", label: "Prompt" },
      { id: "config", type: "config", label: "Mask config" }
    ]);
    expect(editDefinition.outputPorts).toEqual([{ id: "result", type: "result", label: "Edited result" }]);
    expect(batchDefinition.inputPorts).toEqual([
      { id: "image", type: "image", label: "Images" },
      { id: "text", type: "text", label: "Batch prompt" },
      { id: "config", type: "config", label: "Batch settings" }
    ]);

    const { workspace, project } = createProject(createInitialWorkspace(), "Typed ports");
    const first = addAssetToProject(workspace, project.id, {
      name: "front.png",
      source: "front",
      width: 500,
      height: 700
    });
    const second = addAssetToProject(first, project.id, {
      name: "back.png",
      source: "back",
      width: 500,
      height: 700
    });
    const [front, back] = second.projects[0].nodes;

    const withEdit = createWorkflowModuleFromSelection(second, project.id, [front.id], {
      moduleType: "edit",
      prompt: "Change trim color",
      modelId: "gpt-image-2-medium"
    });
    const editNode = withEdit.projects[0].nodes.find((node) => node.moduleType === "edit")!;
    const withBatch = createWorkflowModuleFromSelection(withEdit, project.id, [front.id, back.id], {
      moduleType: "batch",
      prompt: "Apply a shared cleanup",
      modelId: "gpt-image-2-medium"
    });
    const batchNode = withBatch.projects[0].nodes.find((node) => node.moduleType === "batch")!;

    expect(editNode.inputs).toEqual(editDefinition.inputPorts);
    expect(editNode.outputs).toEqual(editDefinition.outputPorts);
    expect(batchNode.inputs).toEqual(batchDefinition.inputPorts);
    expect(batchNode.outputs).toEqual(batchDefinition.outputPorts);
  });

  it("uses registered ports when chaining workflow modules", () => {
    const { workspace, project } = createProject(createInitialWorkspace(), "Registered port chain");
    const withAsset = addAssetToProject(workspace, project.id, {
      name: "front.png",
      source: "front",
      width: 500,
      height: 700
    });
    const source = withAsset.projects[0].nodes[0];
    const withEdit = createWorkflowModuleFromSelection(withAsset, project.id, [source.id], {
      moduleType: "edit",
      prompt: "Change trim color",
      modelId: "gpt-image-2-medium"
    });
    const editNode = withEdit.projects[0].nodes.find((node) => node.moduleType === "edit")!;
    const withUpscale = createWorkflowModuleFromSelection(withEdit, project.id, [editNode.id], {
      moduleType: "upscale",
      prompt: "Upscale the edited result",
      modelId: "upscale-pro"
    });

    expect(withUpscale.projects[0].connections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ fromNodeId: source.id, toNodeId: editNode.id, fromPort: "out", toPort: "image" }),
        expect.objectContaining({ fromNodeId: editNode.id, fromPort: "result", toPort: "image" })
      ])
    );
  });

  it("rejects incompatible manual workflow port connections", () => {
    const { workspace, project } = createProject(createInitialWorkspace(), "Port compatibility");
    const withAsset = addAssetToProject(workspace, project.id, {
      name: "front.png",
      source: "front",
      width: 500,
      height: 700
    });
    const withPrompt = addTextNode(withAsset, project.id, "Use this prompt as text context");
    const imageNode = withPrompt.projects[0].nodes.find((node) => node.type === "image")!;
    const textNode = withPrompt.projects[0].nodes.find((node) => node.type === "text")!;
    const withEdit = createWorkflowModuleFromSelection(withPrompt, project.id, [imageNode.id], {
      moduleType: "edit",
      prompt: "Change trim color",
      modelId: "gpt-image-2-medium"
    });
    const editNode = withEdit.projects[0].nodes.find((node) => node.moduleType === "edit")!;

    expect(() => connectWorkflowNode(withEdit, project.id, textNode.id, editNode.id, "out", "image")).toThrow(
      "Cannot connect text output to image input"
    );
    expect(withEdit.projects[0].connections.some((connection) => connection.fromNodeId === textNode.id && connection.toNodeId === editNode.id)).toBe(false);
  });

  it("routes mixed image and text sources to compatible module input ports", () => {
    const { workspace, project } = createProject(createInitialWorkspace(), "Mixed source ports");
    const withAsset = addAssetToProject(workspace, project.id, {
      name: "front.png",
      source: "front",
      width: 500,
      height: 700
    });
    const withPrompt = addTextNode(withAsset, project.id, "Use a soft showroom cleanup prompt");
    const imageNode = withPrompt.projects[0].nodes.find((node) => node.type === "image")!;
    const textNode = withPrompt.projects[0].nodes.find((node) => node.type === "text")!;

    const withEdit = createWorkflowModuleFromSelection(withPrompt, project.id, [imageNode.id, textNode.id], {
      moduleType: "edit",
      prompt: "Change trim color",
      modelId: "gpt-image-2-medium"
    });
    const editNode = withEdit.projects[0].nodes.find((node) => node.moduleType === "edit")!;

    expect(withEdit.projects[0].connections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ fromNodeId: imageNode.id, toNodeId: editNode.id, fromPort: "out", toPort: "image" }),
        expect.objectContaining({ fromNodeId: textNode.id, toNodeId: editNode.id, fromPort: "out", toPort: "text" })
      ])
    );
  });

  it("skips incompatible optional sources when creating image-only workflow modules", () => {
    const { workspace, project } = createProject(createInitialWorkspace(), "Image only mixed selection");
    const withAsset = addAssetToProject(workspace, project.id, {
      name: "front.png",
      source: "front",
      width: 500,
      height: 700
    });
    const withPrompt = addTextNode(withAsset, project.id, "Text prompt that should not feed upscale");
    const imageNode = withPrompt.projects[0].nodes.find((node) => node.type === "image")!;
    const textNode = withPrompt.projects[0].nodes.find((node) => node.type === "text")!;

    const withUpscale = createWorkflowModuleFromSelection(withPrompt, project.id, [imageNode.id, textNode.id], {
      moduleType: "upscale",
      prompt: "Upscale only image references",
      modelId: "upscale-pro"
    });
    const upscaleNode = withUpscale.projects[0].nodes.find((node) => node.moduleType === "upscale")!;

    expect(withUpscale.projects[0].connections).toEqual(
      expect.arrayContaining([expect.objectContaining({ fromNodeId: imageNode.id, toNodeId: upscaleNode.id, fromPort: "out", toPort: "image" })])
    );
    expect(withUpscale.projects[0].connections.some((connection) => connection.fromNodeId === textNode.id && connection.toNodeId === upscaleNode.id)).toBe(false);
    expect(upscaleNode.references).toEqual([imageNode.id]);
  });

  it("builds backend generation requests from workflow registry definitions", () => {
    const { workspace, project } = createProject(createInitialWorkspace({ credits: 40 }), "Backend workflow requests");
    const withAsset = addAssetToProject(workspace, project.id, {
      name: "coat-front.png",
      source: "coat-front-source",
      width: 640,
      height: 640
    });
    const source = withAsset.projects[0].nodes[0];
    const editDefinition = getWorkflowModuleDefinition("edit");
    const editWorkspace = createWorkflowModuleFromSelection(withAsset, project.id, [source.id], {
      moduleType: "edit",
      prompt: "Change buttons to horn toggles",
      modelId: editDefinition.defaultModelId
    });
    const editNode = editWorkspace.projects[0].nodes.find((node) => node.moduleType === "edit")!;
    const upscaleDefinition = getWorkflowModuleDefinition("upscale");
    const upscaleWorkspace = createWorkflowModuleFromSelection(editWorkspace, project.id, [editNode.id], {
      moduleType: "upscale",
      prompt: upscaleDefinition.defaultPrompt,
      modelId: upscaleDefinition.defaultModelId
    });
    const upscaleNode = upscaleWorkspace.projects[0].nodes.find((node) => node.moduleType === "upscale")!;
    const removeBgDefinition = getWorkflowModuleDefinition("removeBackground");
    const removeBgWorkspace = createWorkflowModuleFromSelection(upscaleWorkspace, project.id, [upscaleNode.id], {
      moduleType: "removeBackground",
      prompt: removeBgDefinition.defaultPrompt,
      modelId: removeBgDefinition.defaultModelId
    });

    const requests = buildWorkflowGenerationRequests(removeBgWorkspace, project.id, source.id);

    expect(requests.map((request) => request.operation)).toEqual(["edit", "upscale", "removeBackground"]);
    expect(requests.map((request) => request.modelId)).toEqual([
      editDefinition.defaultModelId,
      upscaleDefinition.defaultModelId,
      removeBgDefinition.defaultModelId
    ]);
    expect(requests.map((request) => request.referenceNodeIds)).toEqual([[source.id], [editNode.id], [upscaleNode.id]]);
    expect(requests[0]).toMatchObject({
      projectId: project.id,
      nodeId: editNode.id,
      prompt: "Change buttons to horn toggles",
      outputCount: 1
    });
  });

  it("uses connected text input ports as workflow prompts", () => {
    const { workspace, project } = createProject(createInitialWorkspace({ credits: 40 }), "Typed prompt input");
    const withAsset = addAssetToProject(workspace, project.id, {
      name: "dress-front.png",
      source: "dress-front-source",
      width: 640,
      height: 640
    });
    const withPrompt = addTextNode(withAsset, project.id, "Use the floral jacquard from the note and keep studio lighting.");
    const [source, promptNode] = withPrompt.projects[0].nodes;
    const withModule = createWorkflowModuleFromSelection(withPrompt, project.id, [source.id], {
      moduleType: "generate",
      prompt: "Default module prompt should be replaced",
      modelId: "gpt-image-2-medium"
    });
    const generateNode = withModule.projects[0].nodes.find((node) => node.moduleType === "generate")!;
    const connected = connectWorkflowNode(withModule, project.id, promptNode.id, generateNode.id, "out", "text");

    const requests = buildWorkflowGenerationRequests(connected, project.id, source.id);
    const executed = runWorkflowChain(connected, project.id, source.id);

    expect(requests[0]).toMatchObject({
      nodeId: generateNode.id,
      prompt: "Use the floral jacquard from the note and keep studio lighting.",
      referenceNodeIds: [source.id]
    });
    expect(executed.history[0]).toMatchObject({
      nodeId: generateNode.id,
      prompt: "Use the floral jacquard from the note and keep studio lighting."
    });
  });

  it("uses connected image input ports as workflow references", () => {
    const { workspace, project } = createProject(createInitialWorkspace({ credits: 40 }), "Typed image input");
    const withFront = addAssetToProject(workspace, project.id, {
      name: "front.png",
      source: "front-source",
      width: 640,
      height: 640
    });
    const withTexture = addAssetToProject(withFront, project.id, {
      name: "texture.png",
      source: "texture-source",
      width: 512,
      height: 512
    });
    const [front, texture] = withTexture.projects[0].nodes;
    const withModule = createWorkflowModuleFromSelection(withTexture, project.id, [front.id], {
      moduleType: "generate",
      prompt: "Combine the silhouette and texture references.",
      modelId: "gpt-image-2-medium"
    });
    const generateNode = withModule.projects[0].nodes.find((node) => node.moduleType === "generate")!;
    const connected = connectWorkflowNode(withModule, project.id, texture.id, generateNode.id, "out", "image");

    const requests = buildWorkflowGenerationRequests(connected, project.id, front.id);
    const executed = runWorkflowChain(connected, project.id, front.id);
    const generatedNode = executed.projects[0].nodes.find((node) => node.kind === "generated")!;

    expect(requests[0]).toMatchObject({
      nodeId: generateNode.id,
      referenceNodeIds: [front.id, texture.id]
    });
    expect(generatedNode.references).toEqual([front.id, texture.id]);
    expect(executed.history[0]).toMatchObject({
      nodeId: generateNode.id,
      referenceCount: 2
    });
  });

  it("uses connected config input ports as workflow output settings", () => {
    const { workspace, project } = createProject(createInitialWorkspace({ credits: 40 }), "Typed config input");
    const withAsset = addAssetToProject(workspace, project.id, {
      name: "batch-front.png",
      source: "batch-front-source",
      width: 640,
      height: 640
    });
    const source = withAsset.projects[0].nodes[0];
    const withBatch = createWorkflowModuleFromSelection(withAsset, project.id, [source.id], {
      moduleType: "batch",
      prompt: "Apply one batch direction from config.",
      modelId: "gpt-image-2-medium"
    });
    const batchNode = withBatch.projects[0].nodes.find((node) => node.moduleType === "batch")!;
    const withConfig = addConfigNode(withBatch, project.id, { outputCount: 3 });
    const configNode = withConfig.projects[0].nodes.find((node) => node.type === "config" && node.outputs[0]?.type === "config")!;
    const connected = connectWorkflowNode(withConfig, project.id, configNode.id, batchNode.id, "out", "config");

    const plan = buildWorkflowExecutionPlan(connected, project.id, source.id);
    const requests = buildWorkflowGenerationRequests(connected, project.id, source.id);
    const executed = runWorkflowChain(connected, project.id, source.id);
    const generatedNode = executed.projects[0].nodes.find((node) => node.kind === "generated")!;
    const unitCost = connected.modelRegistry.find((model) => model.id === "gpt-image-2-medium")!.cost;

    expect(configNode.generation.outputCount).toBe(3);
    expect(plan.steps[0]).toMatchObject({
      outputCount: 3,
      estimatedCreditCost: unitCost * 3
    });
    expect(requests[0]).toMatchObject({ outputCount: 3 });
    expect(generatedNode.generation.outputCount).toBe(3);
    expect(executed.history[0]).toMatchObject({
      outputCount: 3,
      creditCost: unitCost * 3
    });
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

  it("stores backend generation task metadata on the source canvas node", () => {
    const { workspace, project } = createProject(createInitialWorkspace({ credits: 10 }), "Backend task node");
    const withAsset = addAssetToProject(workspace, project.id, {
      name: "shirt.png",
      source: "shirt-source",
      width: 640,
      height: 800
    });
    const source = withAsset.projects[0].nodes[0];
    const request = {
      projectId: project.id,
      nodeId: source.id,
      modelId: "gpt-image-2-medium",
      prompt: "make a new neckline variation",
      referenceNodeIds: [source.id],
      outputCount: 1,
      operation: "edit" as const
    };
    const updated = applyGenerationResultToCanvas(withAsset, project.id, source.id, request, {
      status: "succeeded",
      historyId: "history-backend-task",
      creditCost: 7,
      outputs: [{ name: "backend shirt edit.jpg", source: "mock://edit/shirt/1", width: 1024, height: 1024 }]
    });
    const updatedSource = updated.projects[0].nodes.find((node) => node.id === source.id)!;
    const output = updated.projects[0].nodes.find((node) => node.parentId === source.id && node.kind === "generated")!;

    expect(updatedSource.status).toBe("done");
    expect(updatedSource.metadata).toMatchObject({
      runStatus: "done",
      inputNodeIds: [source.id],
      outputNodeIds: [output.id],
      historyId: "history-backend-task",
      creditCost: 7,
      operation: "edit",
      modelId: "gpt-image-2-medium",
      prompt: "make a new neckline variation"
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
    expect(processed.projects[0].nodes.filter((node) => node.metadata.batchOriginal)).toHaveLength(3);
    expect(processed.projects[0].nodes.filter((node) => node.kind === "generated")).toHaveLength(3);
    expect(processed.projects[0].connections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fromNodeId: processed.projects[0].nodes.find((node) => node.name === "a.png")!.id,
          toNodeId: processed.projects[0].nodes.find((node) => node.name === "a.png batch result")!.id
        })
      ])
    );
    expect(processed.profile.credits).toBe(2);
    expect(processed.history[0]).toMatchObject({
      modelId: "background-cleaner",
      outputCount: 3,
      creditCost: 6,
      operation: "removeBackground"
    });
  });

  it("stores backend batch status and outputs on each original canvas node", () => {
    const { workspace, project } = createProject(createInitialWorkspace({ credits: 20 }), "Backend batch audit");
    const batch = {
      folderName: "raw trims",
      prompt: "remove background and normalize lighting",
      modelId: "background-cleaner",
      outputCount: 1,
      files: [
        { name: "front.png", source: "front-source", width: 300, height: 300 },
        { name: "back.png", source: "back-source", width: 300, height: 300 }
      ]
    };

    const updated = applyBatchGenerationResultsToCanvas(workspace, project.id, batch, [
      {
        result: {
          status: "succeeded",
          historyId: "history-batch-front",
          creditCost: 2,
          outputs: [{ name: "front-clean.png", source: "mock://batch/front/1", width: 512, height: 512 }]
        }
      },
      { errorMessage: "Provider timed out" }
    ]);
    const originalFront = updated.projects[0].nodes.find((node) => node.name === "front.png")!;
    const originalBack = updated.projects[0].nodes.find((node) => node.name === "back.png")!;
    const frontOutput = updated.projects[0].nodes.find((node) => node.name === "front-clean.png")!;

    expect(originalFront.status).toBe("done");
    expect(originalFront.metadata).toMatchObject({
      runStatus: "done",
      outputNodeIds: [frontOutput.id],
      historyId: "history-batch-front",
      creditCost: 2,
      prompt: "remove background and normalize lighting",
      modelId: "background-cleaner",
      operation: "removeBackground"
    });
    expect(originalBack.status).toBe("error");
    expect(originalBack.metadata).toMatchObject({
      runStatus: "error",
      errorMessage: "Provider timed out",
      prompt: "remove background and normalize lighting",
      modelId: "background-cleaner",
      operation: "removeBackground"
    });
    expect(frontOutput.metadata).toMatchObject({
      sourceFile: "front.png",
      historyId: "history-batch-front",
      creditCost: 2,
      prompt: "remove background and normalize lighting",
      modelId: "background-cleaner",
      operation: "removeBackground"
    });
  });

  it("summarizes, cancels, and retries failed backend batch items without duplicating originals", () => {
    const { workspace, project } = createProject(createInitialWorkspace({ credits: 20 }), "Batch retry queue");
    const batch = {
      folderName: "raw trims",
      prompt: "remove background and normalize lighting",
      modelId: "background-cleaner",
      outputCount: 1,
      files: [
        { name: "front.png", source: "front-source", width: 300, height: 300 },
        { name: "back.png", source: "back-source", width: 300, height: 300 }
      ]
    };
    const firstPass = applyBatchGenerationResultsToCanvas(workspace, project.id, batch, [
      {
        result: {
          status: "succeeded",
          historyId: "history-batch-front",
          creditCost: 2,
          outputs: [{ name: "front-clean.png", source: "mock://batch/front/1", width: 512, height: 512 }]
        }
      },
      { errorMessage: "Provider timed out" }
    ]);

    expect(summarizeBatchQueue(firstPass.projects[0].batchQueue)).toMatchObject({
      total: 2,
      completed: 2,
      succeeded: 1,
      failed: 1,
      cancelled: 0,
      percent: 100,
      status: "error"
    });
    expect(firstPass.projects[0].batchQueue.find((item) => item.name === "back.png")).toMatchObject({
      status: "error",
      attempts: 1,
      errorMessage: "Provider timed out"
    });

    const retryBatch = buildRetryBatchFromFailures(firstPass, project.id);
    expect(retryBatch.files).toEqual([{ name: "back.png", source: "back-source", width: 300, height: 300 }]);

    const retryPass = applyBatchGenerationResultsToCanvas(firstPass, project.id, retryBatch, [
      {
        result: {
          status: "succeeded",
          historyId: "history-batch-back",
          creditCost: 2,
          outputs: [{ name: "back-clean.png", source: "mock://batch/back/1", width: 512, height: 512 }]
        }
      }
    ]);

    expect(summarizeBatchQueue(retryPass.projects[0].batchQueue)).toMatchObject({
      total: 2,
      succeeded: 2,
      failed: 0,
      status: "succeeded"
    });
    expect(retryPass.projects[0].batchQueue.find((item) => item.name === "back.png")).toMatchObject({
      status: "done",
      attempts: 2
    });
    expect(retryPass.projects[0].nodes.filter((node) => node.metadata.batchOriginal && node.name === "back.png")).toHaveLength(1);
    expect(retryPass.projects[0].nodes.filter((node) => node.kind === "generated")).toHaveLength(2);

    const queued = importBatchFolder(workspace, project.id, batch);
    const cancelled = cancelBatchQueue(queued, project.id);
    expect(summarizeBatchQueue(cancelled.projects[0].batchQueue)).toMatchObject({
      total: 2,
      cancelled: 2,
      status: "cancelled"
    });
    expect(cancelled.projects[0].batchQueue.every((item) => item.errorMessage === "Cancelled by designer")).toBe(true);
  });

  it("rejects batch processing with unregistered or non-executable models before spending credits", () => {
    const { workspace, project } = createProject(createInitialWorkspace({ credits: 8 }), "Invalid batch model");
    const queued = importBatchFolder(workspace, project.id, {
      folderName: "raw trims",
      prompt: "process every image",
      modelId: "missing-model",
      outputCount: 1,
      files: [{ name: "a.png", source: "a", width: 300, height: 300 }]
    });
    const uploadOnlyModel: ModelDefinition = {
      id: "upload-only",
      name: "Upload Only",
      provider: "internal",
      group: "Operations",
      capability: ["upload"],
      cost: 3
    };
    const uploadOnly = {
      ...queued,
      modelRegistry: [...queued.modelRegistry, uploadOnlyModel]
    };
    const uploadOnlyQueued = importBatchFolder(uploadOnly, project.id, {
      folderName: "raw trims",
      prompt: "process every image",
      modelId: "upload-only",
      outputCount: 1,
      files: [{ name: "b.png", source: "b", width: 300, height: 300 }]
    });

    expect(() => runBatchQueue(queued, project.id)).toThrow("Model not found");
    expect(() => runBatchQueue(uploadOnlyQueued, project.id)).toThrow("Model upload-only does not support batch operations");
    expect(queued.profile.credits).toBe(8);
    expect(uploadOnlyQueued.profile.credits).toBe(8);
  });

  it("pulls a workflow module from an image and runs chained edit then upscale steps", () => {
    const { workspace, project } = createProject(createInitialWorkspace({ credits: 12 }), "Workflow chain");
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
    expect(executed.profile.credits).toBe(1);
  });

  it("stores workflow node inputs, outputs, status, and history after execution", () => {
    const { workspace, project } = createProject(createInitialWorkspace({ credits: 20 }), "Workflow audit trail");
    const withAsset = addAssetToProject(workspace, project.id, {
      name: "jacket.png",
      source: "jacket-source",
      width: 640,
      height: 640
    });
    const source = withAsset.projects[0].nodes[0];
    const withEditModule = createWorkflowModuleFromSelection(withAsset, project.id, [source.id], {
      moduleType: "edit",
      prompt: "replace buttons with brushed metal buttons",
      modelId: "gpt-image-2-medium"
    });
    const editNode = withEditModule.projects[0].nodes.find((node) => node.moduleType === "edit")!;

    const executed = runWorkflowChain(withEditModule, project.id, source.id);
    const executedProject = executed.projects[0];
    const executedEditNode = executedProject.nodes.find((node) => node.id === editNode.id)!;
    const output = executedProject.nodes.find((node) => node.parentId === editNode.id && node.kind === "generated")!;
    const history = executed.history.find((entry) => entry.nodeId === editNode.id)!;

    expect(executedEditNode.status).toBe("done");
    expect(executedEditNode.metadata).toMatchObject({
      runStatus: "done",
      inputNodeIds: [source.id],
      outputNodeIds: [output.id],
      historyId: history.id,
      creditCost: history.creditCost,
      operation: "edit",
      modelId: "gpt-image-2-medium",
      prompt: "replace buttons with brushed metal buttons"
    });
    expect(history.outputs).toEqual([
      expect.objectContaining({
        name: output.name,
        source: output.source,
        width: output.width,
        height: output.height
      })
    ]);
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

  it("spends the configured model credits when running workflow chains", () => {
    const { workspace, project } = createProject(createInitialWorkspace({ credits: 20 }), "Priced workflow chain");
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

    const executed = runWorkflowChain(upscaleModule, project.id, source.id);

    expect(executed.profile.credits).toBe(9);
    expect(executed.profile.creditUsed).toBe(11);
    expect(executed.history.map((entry) => entry.creditCost)).toEqual([4, 7]);
    const generatedOutputs = executed.projects[0].nodes.filter((node) => node.kind === "generated");
    expect(generatedOutputs.map((node) => node.metadata.creditCost)).toEqual([7, 4]);
  });

  it("executes remove background workflow nodes and records their outputs", () => {
    const { workspace, project } = createProject(createInitialWorkspace({ credits: 20 }), "Remove BG workflow");
    const withAsset = addAssetToProject(workspace, project.id, {
      name: "coat.png",
      source: "coat-source",
      width: 640,
      height: 640
    });
    const source = withAsset.projects[0].nodes[0];
    const removeBgModule = createWorkflowModuleFromSelection(withAsset, project.id, [source.id], {
      moduleType: "removeBackground",
      prompt: "remove the studio background and keep transparent edges",
      modelId: "background-cleaner"
    });
    const removeBgNode = removeBgModule.projects[0].nodes.find((node) => node.moduleType === "removeBackground")!;

    const executed = runWorkflowChain(removeBgModule, project.id, source.id);

    expect(executed.profile.credits).toBe(18);
    expect(executed.profile.creditUsed).toBe(2);
    expect(executed.history[0]).toMatchObject({
      nodeId: removeBgNode.id,
      operation: "removeBackground",
      moduleType: "removeBackground",
      modelId: "background-cleaner",
      creditCost: 2
    });
    const executedProject = executed.projects[0];
    const executedRemoveBgNode = executedProject.nodes.find((node) => node.id === removeBgNode.id)!;
    const generatedOutput = executedProject.nodes.find((node) => node.kind === "generated" && node.parentId === removeBgNode.id)!;
    expect(executedRemoveBgNode.status).toBe("done");
    expect(executedRemoveBgNode.metadata).toMatchObject({
      runStatus: "done",
      operation: "removeBackground",
      outputNodeIds: [generatedOutput.id]
    });
    expect(executedProject.connections).toEqual(expect.arrayContaining([expect.objectContaining({ fromNodeId: removeBgNode.id, toNodeId: generatedOutput.id })]));
  });

  it("blocks workflow execution plans when a model does not support the node operation", () => {
    const { workspace, project } = createProject(createInitialWorkspace({ credits: 40 }), "Capability gated workflow");
    const withAsset = addAssetToProject(workspace, project.id, {
      name: "coat.png",
      source: "coat-source",
      width: 640,
      height: 640
    });
    const source = withAsset.projects[0].nodes[0];
    const invalidUpscale = createWorkflowModuleFromSelection(withAsset, project.id, [source.id], {
      moduleType: "upscale",
      prompt: "preserve fabric texture while enlarging",
      modelId: "gpt-image-2-medium"
    });
    const upscaleNode = invalidUpscale.projects[0].nodes.find((node) => node.moduleType === "upscale")!;

    const plan = buildWorkflowExecutionPlan(invalidUpscale, project.id, source.id);

    expect(plan.status).toBe("blocked");
    expect(plan.steps).toHaveLength(1);
    expect(plan.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          nodeId: upscaleNode.id,
          severity: "error",
          message: "Model gpt-image-2-medium does not support upscale"
        })
      ])
    );
  });

  it("rejects workflow execution with missing or unsupported models before spending credits", () => {
    const { workspace, project } = createProject(createInitialWorkspace({ credits: 40 }), "Runtime capability gate");
    const withAsset = addAssetToProject(workspace, project.id, {
      name: "coat.png",
      source: "coat-source",
      width: 640,
      height: 640
    });
    const source = withAsset.projects[0].nodes[0];
    const unsupportedUpscale = createWorkflowModuleFromSelection(withAsset, project.id, [source.id], {
      moduleType: "upscale",
      prompt: "preserve fabric texture while enlarging",
      modelId: "gpt-image-2-medium"
    });
    const missingModel = createWorkflowModuleFromSelection(withAsset, project.id, [source.id], {
      moduleType: "edit",
      prompt: "add a detachable hood",
      modelId: "retired-style-model"
    });

    expect(() => runWorkflowChain(unsupportedUpscale, project.id, source.id)).toThrow("Model gpt-image-2-medium does not support upscale");
    expect(() => runWorkflowChain(missingModel, project.id, source.id)).toThrow("Model not found");
    expect(withAsset.profile.credits).toBe(40);
    expect(unsupportedUpscale.profile.credits).toBe(40);
    expect(missingModel.profile.credits).toBe(40);
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
    const { workspace, project } = createProject(createInitialWorkspace({ credits: 8 }), "Two reference dress");
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
      modelId: "flux-pro"
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
      modelId: "flux-pro"
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

  it("creates an executable batch workflow node from multiple selected image references", () => {
    const { workspace, project } = createProject(createInitialWorkspace({ credits: 20 }), "Batch workflow node");
    const first = addAssetToProject(workspace, project.id, {
      name: "front.png",
      source: "front",
      width: 500,
      height: 700
    });
    const second = addAssetToProject(first, project.id, {
      name: "back.png",
      source: "back",
      width: 500,
      height: 700
    });
    const [front, back] = second.projects[0].nodes;

    const withBatch = createWorkflowModuleFromSelection(second, project.id, [front.id, back.id], {
      moduleType: "batch",
      prompt: "Apply one consistent edit brief to every selected reference.",
      modelId: "gpt-image-2-medium"
    });
    const batchNode = withBatch.projects[0].nodes.find((node) => node.moduleType === "batch")!;
    const plan = buildWorkflowExecutionPlan(withBatch, project.id, front.id);
    const executed = runWorkflowChain(withBatch, project.id, front.id);

    expect(batchNode).toMatchObject({ type: "batch", kind: "workflow", references: [front.id, back.id] });
    expect(plan.steps[0]).toMatchObject({
      moduleType: "batch",
      operation: "generate",
      referenceNodeIds: [front.id, back.id],
      referenceCount: 2
    });
    expect(executed.history[0]).toMatchObject({
      moduleType: "batch",
      operation: "generate",
      referenceCount: 2,
      modelId: "gpt-image-2-medium"
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
