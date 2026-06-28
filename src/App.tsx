import {
  Archive,
  BadgeDollarSign,
  BookOpenText,
  BoxSelect,
  Check,
  ChevronDown,
  CircleDashed,
  Clock3,
  Copy,
  Database,
  Download,
  FolderPlus,
  Grid2X2,
  Heart,
  History,
  Image,
  ImagePlus,
  Layers3,
  Maximize2,
  Menu,
  MessageSquareText,
  Minus,
  MousePointer2,
  Network,
  PanelRight,
  Pencil,
  Play,
  Plus,
  RotateCcw,
  Scissors,
  Search,
  Shirt,
  SlidersHorizontal,
  Sparkles,
  SquareDashedMousePointer,
  Trash2,
  Undo2,
  Upload,
  UserRound,
  Wand2,
  ZoomIn,
  ZoomOut,
  type LucideIcon
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type FormEvent, type PointerEvent, type WheelEvent } from "react";
import {
  addAssetToProjectAt,
  addAssetToProject,
  addConfigNode,
  addTextNode,
  addGenerationTargetFrame,
  applyBatchGenerationResultsToCanvas,
  applyGenerationResultToCanvas,
  buildRetryBatchFromFailures,
  buildWorkflowExecutionPlan,
  buildWorkflowGenerationRequests,
  cancelBatchQueue,
  commitShapeEdit,
  configureNodeGeneration,
  configureNodeMetadata,
  connectWorkflowNode,
  copyPasteSelectedNodes,
  createInitialWorkspace,
  createProject,
  createWorkflowModuleFromSelection,
  deleteSelectedNodes,
  importBatchFolder,
  markNodeRunState,
  mergeReferenceSelection,
  redoProject,
  runBatchQueue,
  saveNodeAsAsset,
  selectNodes,
  summarizeBatchQueue,
  undoProject,
  updateNodeTransform,
  updateViewport,
  getWorkflowModuleDefinition,
  type BatchGenerationOutcome,
  type BatchImport,
  type BatchFailurePolicy,
  type CanvasNode,
  type GenerationResult,
  type HistoryEntry,
  type LibraryAsset,
  type MaskSelection,
  type ModelDefinition,
  type OperationType,
  type ModuleType,
  type NodePort,
  type NodeTransform,
  type Profile,
  type Project,
  type Workspace,
  WORKFLOW_MODULE_REGISTRY
} from "./domain/workspace";
import {
  adjustDesignerCredits,
  configureAdminModelPricing,
  configureAdminModelRegistry,
  configureAdminProviderSettings,
  fetchAdminAccounts,
  fetchAdminAudit,
  fetchAdminHistory,
  fetchAdminJobs,
  fetchAdminUsage,
  fetchBackendSnapshot,
  fetchProviderHealth,
  fetchWorkspaceSnapshot,
  deletePromptPresetRemote,
  saveWorkspaceSnapshot,
  savePromptPresetRemote,
  setDesignerCreditLimit,
  submitGenerationRequest,
  type AdminAccountSummary,
  type AdminAuditEntry,
  type AdminHistoryEntry,
  type AdminGenerationJob,
  type AdminUsageSummary,
  type ProviderHealth,
  type ModelRegistryRequest,
  type ProviderSettingsRequest
} from "./services/modelApi";

const TEST_IMAGE = "/fixtures/fashion-reference.jpg";
const SECOND_TEST_IMAGE = "/fixtures/fashion-reference.jpg";

type ViewMode = "login" | "home" | "canvas" | "admin";
type DragMode = "move" | "resize";
type ShapeEditDraft = { nodeId: string; shape: "ellipse" | "rectangle" | "freehand"; prompt: string; mask?: MaskSelection } | null;
type HomeSection = "Projects" | "History" | "Profile";
type RightPanel = "context" | "history" | "assets" | "prompts" | "assistant";
type OpenProjectTarget = { nodeId?: string; historyId?: string };
const DEFAULT_MASK_SELECTION: MaskSelection = { x: 28, y: 24, width: 44, height: 38 };
const workflowModuleIcons: Record<ModuleType, LucideIcon> = {
  generate: Plus,
  edit: Wand2,
  upscale: Maximize2,
  removeBackground: Scissors,
  batch: Upload,
  upload: ImagePlus
};

function readFileAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function clampOutputCount(value: number) {
  return Math.min(8, Math.max(1, Number.isFinite(value) ? Math.round(value) : 1));
}

function clampBatchConcurrency(value: number) {
  return Math.min(8, Math.max(1, Number.isFinite(value) ? Math.round(value) : 1));
}

function historyEntryToAuditEntry(entry: HistoryEntry): AdminAuditEntry {
  return {
    ...entry,
    eventType: "generation",
    actorUserId: entry.userId,
    targetUserId: entry.userId,
    summary: `${entry.designerName ?? entry.userId ?? "Designer"} generated ${entry.outputCount} output${entry.outputCount === 1 ? "" : "s"} with ${entry.modelId}`
  };
}

function auditPrimaryMetric(entry: AdminAuditEntry) {
  if (entry.eventType === "credit-adjustment") return `${entry.creditDelta} credits`;
  if (entry.eventType === "credit-limit") return `limit ${entry.creditLimit}`;
  if (entry.eventType === "model-pricing") return `${entry.creditCost} credits/output`;
  if (entry.eventType === "provider-settings") return entry.provider ?? "provider";
  return `${entry.creditCost ?? 0} credits`;
}

function auditContext(entry: AdminAuditEntry) {
  if ((entry.eventType ?? "generation") === "generation") {
    return [entry.designerName ?? entry.actorUserId ?? entry.userId, entry.projectName ?? entry.projectId].filter(Boolean).join(" · ");
  }
  return [entry.actorUserId ?? entry.designerName, entry.targetUserId, entry.projectName ?? entry.projectId ?? entry.modelId].filter(Boolean).join(" / ");
}

function auditDescription(entry: AdminAuditEntry) {
  return (entry.eventType ?? "generation") === "generation" ? entry.prompt : entry.summary ?? entry.prompt;
}

function formatMoneyCents(priceCents?: number, currency?: string) {
  if (priceCents === undefined) return undefined;
  return `${(priceCents / 100).toFixed(2)} ${currency ?? "CNY"}`;
}

function formatEstimatedSpend(priceCents?: number, currency?: string) {
  const money = formatMoneyCents(priceCents, currency);
  return money ? `${money} estimated spend` : "No price configured";
}

function formatActivityMinute(timestamp?: string) {
  if (!timestamp) return "No activity yet";
  const match = timestamp.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/);
  return match ? `${match[1]} ${match[2]}` : timestamp;
}

function creditAdjustmentReason(summary: string) {
  const reasonStart = summary.indexOf(": ");
  return reasonStart >= 0 ? summary.slice(reasonStart + 2) : summary;
}

function createWorkspace() {
  return createInitialWorkspace({ userId: "designer-lina", designerName: "Lina Zhou", creditBalance: 180, role: "designer" });
}

function operationForNode(node: CanvasNode): OperationType {
  if (node.operation) return node.operation;
  if (node.moduleType) return getWorkflowModuleDefinition(node.moduleType).operation;
  if (node.type === "upscale") return "upscale";
  if (node.type === "removeBg") return "removeBackground";
  if (node.type === "edit") return "edit";
  return "generate";
}

function defaultPromptForModule(moduleType: ModuleType) {
  return getWorkflowModuleDefinition(moduleType).defaultPrompt;
}

function operationForBatchModel(models: ModelDefinition[], modelId: string, preferredOperation?: OperationType): OperationType {
  const model = models.find((item) => item.id === modelId);
  if (preferredOperation && model?.capability.includes(preferredOperation as ModuleType)) {
    return preferredOperation;
  }
  if (model?.capability.includes("generate")) return "generate";
  if (model?.capability.includes("removeBackground")) return "removeBackground";
  if (model?.capability.includes("upscale")) return "upscale";
  if (model?.capability.includes("edit")) return "edit";
  return "generate";
}

function nodeCanFeedModule(node: CanvasNode, moduleType: ModuleType) {
  const definition = getWorkflowModuleDefinition(moduleType);
  const output = node.outputs.find((port) => port.id === "out") ?? node.outputs[0];
  if (!output) return false;
  return definition.inputPorts.some((input) => input.type === output.type || (output.type === "result" && input.type === "image"));
}

function moduleInputLabelsForSources(moduleType: ModuleType, sourceNodes: CanvasNode[]) {
  const definition = getWorkflowModuleDefinition(moduleType);
  const labels = sourceNodes.flatMap((node) => {
    const output = node.outputs.find((port) => port.id === "out") ?? node.outputs[0];
    if (!output) return [];
    return definition.inputPorts
      .filter((input) => input.type === output.type || (output.type === "result" && input.type === "image"))
      .map((input) => input.label);
  });
  return Array.from(new Set(labels));
}

function defaultNodeOutputPort(node: CanvasNode, portId?: string) {
  return (portId ? node.outputs.find((port) => port.id === portId) : undefined) ?? node.outputs.find((port) => port.id === "out") ?? node.outputs[0];
}

function nodePortsAreCompatible(output?: NodePort, input?: NodePort) {
  if (!output || !input) return false;
  return output.type === input.type || (output.type === "result" && input.type === "image");
}

function nodeCanAcceptConnection(source?: CanvasNode, target?: CanvasNode, sourcePortId?: string) {
  if (!source || !target || source.id === target.id) return false;
  const output = defaultNodeOutputPort(source, sourcePortId);
  return target.inputs.some((input) => nodePortsAreCompatible(output, input));
}

function nodeInputCanAcceptConnection(source: CanvasNode | undefined, target: CanvasNode | undefined, inputPortId: string, sourcePortId?: string) {
  if (!source || !target || source.id === target.id) return false;
  const input = target.inputs.find((port) => port.id === inputPortId);
  return nodePortsAreCompatible(defaultNodeOutputPort(source, sourcePortId), input);
}

function portConnectionClass(source: CanvasNode | undefined, target: CanvasNode, input: NodePort, sourcePortId?: string) {
  if (!source || source.id === target.id) return "";
  return nodePortsAreCompatible(defaultNodeOutputPort(source, sourcePortId), input) ? "port-compatible" : "port-incompatible";
}

function portPosition(index: number, total: number) {
  return `${((index + 1) / (total + 1)) * 100}%`;
}

function inputPortElementFromPointer(event: globalThis.PointerEvent) {
  const hitElement =
    typeof document.elementFromPoint === "function"
      ? document.elementFromPoint(event.clientX, event.clientY)
      : event.target instanceof Element
        ? event.target
        : null;
  const directTarget = hitElement?.closest<HTMLElement>("[data-node-input-port]");
  if (directTarget) return directTarget;
  const hitPadding = 8;
  return Array.from(document.querySelectorAll<HTMLElement>("[data-node-input-port]")).find((port) => {
    const rect = port.getBoundingClientRect();
    return (
      event.clientX >= rect.left - hitPadding &&
      event.clientX <= rect.right + hitPadding &&
      event.clientY >= rect.top - hitPadding &&
      event.clientY <= rect.bottom + hitPadding
    );
  }) ?? null;
}

function isCanvasImageNode(node?: CanvasNode) {
  return Boolean(
    node &&
      (node.type === "image" ||
        node.type === "imageGroup" ||
        node.type === "batch" ||
        node.kind === "generated" ||
        node.kind === "operation" ||
        node.kind === "edit")
  );
}

export default function App() {
  const [workspace, setWorkspace] = useState<Workspace>(() => createWorkspace());
  const [view, setView] = useState<ViewMode>("login");
  const [rightPanel, setRightPanel] = useState<RightPanel>("context");
  const [shapeEditDraft, setShapeEditDraft] = useState<ShapeEditDraft>(null);
  const [apiNotice, setApiNotice] = useState("Backend API ready");
  const [workspaceReady, setWorkspaceReady] = useState(false);
  const [currentUserId, setCurrentUserId] = useState<string>();
  const activeProject = workspace.projects.find((project) => project.id === workspace.activeProjectId);
  const selectedNode = activeProject?.nodes.find((node) => node.id === activeProject.selectedNodeIds[0]) ?? activeProject?.nodes[0];
  const activeUserId = currentUserId ?? workspace.profile.userId;

  useEffect(() => {
    if (view === "login" || !workspaceReady) return;
    const saveTimer = window.setTimeout(() => {
      void saveWorkspaceSnapshot(workspace, activeUserId).catch((error) => {
        setApiNotice(error instanceof Error ? `Workspace save failed: ${error.message}` : "Workspace save failed");
      });
    }, 250);
    return () => window.clearTimeout(saveTimer);
  }, [activeUserId, workspace, view, workspaceReady]);

  function login(email: string) {
    const isAdmin = email.toLowerCase().includes("admin");
    const identity = {
      userId: email,
      designerName: isAdmin ? "Admin Ops" : "Lina Zhou",
      role: isAdmin ? ("admin" as const) : ("designer" as const)
    };
    setCurrentUserId(email);
    setWorkspaceReady(false);
    setWorkspace((current) => ({
      ...current,
      profile: {
        ...current.profile,
        ...identity
      }
    }));
    setView("home");
    void fetchWorkspaceSnapshot(email)
      .then((snapshot) => {
        setWorkspace((current) => {
          const projects = snapshot.projects ?? current.projects;
          const activeProjectId = projects.some((project) => project.id === snapshot.activeProjectId)
            ? snapshot.activeProjectId
            : projects[0]?.id;
          return {
            ...current,
            projects,
            activeProjectId,
            history: snapshot.history ?? current.history,
            assets: snapshot.assets ?? current.assets,
            prompts: snapshot.prompts?.length ? snapshot.prompts : current.prompts,
            modelRegistry: snapshot.modelRegistry?.length ? snapshot.modelRegistry : current.modelRegistry,
            profile: {
              ...(snapshot.profile ?? current.profile),
              ...identity
            }
          };
        });
        setApiNotice("Workspace loaded from backend");
      })
      .catch((error) => {
        setApiNotice(error instanceof Error ? `Backend workspace unavailable: ${error.message}` : "Backend workspace unavailable");
      })
      .finally(() => setWorkspaceReady(true));
  }

  function openNewProject() {
    setWorkspace((current) => {
      const created = createProject(current, `Untitled ${current.projects.length + 1}`);
      let next = addAssetToProject(created.workspace, created.project.id, {
        name: "fashion-reference.jpg",
        source: TEST_IMAGE,
        width: 360,
        height: 520
      });
      next = addTextNode(
        next,
        created.project.id,
        "参考当前服装轮廓，生成一款新的女装单品，保持干净棚拍质感。",
        560,
        210
      );
      return next;
    });
    setView("canvas");
  }
  function openProject(projectId: string, target?: OpenProjectTarget) {
    setWorkspace((current) => {
      const active = { ...current, activeProjectId: projectId };
      const project = active.projects.find((item) => item.id === projectId);
      const targetNodeId =
        target?.historyId && project
          ? project.nodes.find((node) => node.metadata.historyId === target.historyId)?.id ?? target.nodeId
          : target?.nodeId;
      return targetNodeId && project?.nodes.some((node) => node.id === targetNodeId) ? selectNodes(active, projectId, [targetNodeId]) : active;
    });
    if (target?.historyId || target?.nodeId) {
      setRightPanel("context");
    }
    setView("canvas");
  }

  function deleteProject(projectId: string) {
    setWorkspace((current) => {
      const projects = current.projects.filter((project) => project.id !== projectId);
      const activeProjectId = current.activeProjectId === projectId ? projects[0]?.id : current.activeProjectId;
      return { ...current, projects, activeProjectId };
    });
  }

  function renameProject(projectId: string, name: string) {
    const trimmedName = name.trim();
    if (!trimmedName) return;
    setWorkspace((current) => ({
      ...current,
      projects: current.projects.map((project) =>
        project.id === projectId ? { ...project, name: trimmedName, updatedAt: new Date().toISOString() } : project
      ),
      history: current.history.map((entry) => (entry.projectId === projectId ? { ...entry, projectName: trimmedName } : entry))
    }));
  }

  function updateSelectedConfig(patch: Partial<CanvasNode["generation"]>) {
    if (!activeProject || !selectedNode) return;
    setWorkspace((current) =>
      configureNodeGeneration(current, activeProject.id, selectedNode.id, {
        ...selectedNode.generation,
        ...patch
      })
    );
  }

  function updateSelectedMetadata(patch: Record<string, unknown>) {
    if (!activeProject || !selectedNode) return;
    setWorkspace((current) => configureNodeMetadata(current, activeProject.id, selectedNode.id, patch));
  }

  function importImagePair() {
    if (!activeProject) return;
    setWorkspace((current) => {
      let next = addAssetToProject(current, activeProject.id, {
        name: "reference-front.jpg",
        source: TEST_IMAGE,
        width: 360,
        height: 520
      });
      next = addAssetToProject(next, activeProject.id, {
        name: "reference-texture.jpg",
        source: SECOND_TEST_IMAGE,
        width: 360,
        height: 520
      });
      return next;
    });
  }

  async function generateNodeThroughApi(
    nodeId?: string,
    overrides: Partial<Pick<CanvasNode["generation"], "modelId" | "prompt" | "outputCount">> & { operation?: OperationType } = {}
  ) {
    if (!activeProject) return;
    const projectId = activeProject.id;
    const source = activeProject.nodes.find((node) => node.id === (nodeId ?? selectedNode?.id));
    if (!source) return;
    const operation = overrides.operation ?? operationForNode(source);
    const prompt = overrides.prompt ?? source.generation.prompt;
    const modelId = overrides.modelId ?? source.generation.modelId;
    const outputCount = overrides.outputCount ?? source.generation.outputCount;
    if (!prompt.trim() && operation !== "upscale" && operation !== "removeBackground") {
      setApiNotice("Prompt is required before sending to backend");
      return;
    }
    const request = {
      projectId,
      nodeId: source.id,
      modelId,
      prompt,
      referenceNodeIds: source.references.length ? source.references : source.type === "imageGroup" ? source.references : [source.id],
      outputCount,
      operation
    };
    try {
      setApiNotice("Running backend model request...");
      setWorkspace((current) => markNodeRunState(current, projectId, source.id, "running"));
      const result = await submitGenerationRequest(request, activeUserId);
      const serverState = await fetchBackendSnapshot(activeUserId);
      setWorkspace((current) =>
        applyGenerationResultToCanvas(markNodeRunState(current, projectId, source.id, "done"), projectId, source.id, request, result, serverState)
      );
      setRightPanel("history");
      setApiNotice(`Backend ${operation} succeeded, ${result.creditCost} credits used`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Backend request failed";
      setWorkspace((current) => markNodeRunState(current, projectId, source.id, "error", message));
      setApiNotice(message);
    }
  }

  function runSelectedGeneration() {
    void generateNodeThroughApi();
  }

  function runImageOperation(operation: "upscale" | "removeBackground") {
    const imageNode = isCanvasImageNode(selectedNode) ? selectedNode : undefined;
    if (!imageNode) return;
    void generateNodeThroughApi(imageNode.id, {
      operation,
      modelId: operation === "upscale" ? "upscale-pro" : "background-cleaner",
      prompt:
        operation === "upscale"
          ? "Upscale this image while preserving garment construction, embroidery, fabric texture and clean product lighting."
          : "",
      outputCount: 1
    });
  }

  function addWorkflowModule(moduleType: ModuleType, sourceNodeIds?: string[]) {
    if (!activeProject) return;
    const projectId = activeProject.id;
    const fallbackSourceId = sourceNodeIds?.[0] ?? activeProject.selectedNodeIds[0] ?? selectedNode?.id;
    if (!fallbackSourceId) return;
    const definition = getWorkflowModuleDefinition(moduleType);
    const prompt = definition.defaultPrompt;
    setWorkspace((current) => {
      const project = current.projects.find((item) => item.id === projectId);
      if (!project) return current;
      const candidateSourceIds = sourceNodeIds?.length ? sourceNodeIds : project.selectedNodeIds.length ? project.selectedNodeIds : [fallbackSourceId];
      const resolvedSourceIds = candidateSourceIds.filter((id) => {
        const node = project.nodes.find((item) => item.id === id);
        return node ? nodeCanFeedModule(node, moduleType) : false;
      });
      if (!resolvedSourceIds.length) {
        const fallbackNode = project.nodes.find((node) => nodeCanFeedModule(node, moduleType));
        if (!fallbackNode) return current;
        resolvedSourceIds.push(fallbackNode.id);
      }
      const firstSource = project.nodes.find((node) => node.id === resolvedSourceIds[0]);
      const operationModel = workspace.modelRegistry.find((model) => model.capability.includes(definition.operation as ModuleType));
      const shouldUseOperationModel = definition.operation === "upscale" || definition.operation === "removeBackground";
      const modelId =
        shouldUseOperationModel ? operationModel?.id ?? definition.defaultModelId : firstSource?.generation.modelId ?? operationModel?.id ?? definition.defaultModelId;
      return createWorkflowModuleFromSelection(current, projectId, resolvedSourceIds, {
        moduleType,
        prompt,
        modelId
      });
    });
  }
  function connectSelectionToNewModule(moduleType: ModuleType, sourceNodeIds?: string[]) {
    addWorkflowModule(moduleType, sourceNodeIds);
  }

  function addWorkflowSettingsNode() {
    if (!activeProject) return;
    const outputCount = selectedNode?.generation.outputCount ?? 3;
    setWorkspace((current) => addConfigNode(current, activeProject.id, { outputCount }));
  }

  function groupReferences() {
    if (!activeProject) return;
    const imageIds = activeProject.selectedNodeIds.filter((id) => activeProject.nodes.find((node) => node.id === id)?.type === "image");
    if (imageIds.length < 2) return;
    setWorkspace((current) => mergeReferenceSelection(current, activeProject.id, imageIds, "Reference group"));
  }

  function runWorkflow() {
    void runWorkflowThroughApi();
  }

  async function runWorkflowThroughApi() {
    if (!activeProject || !selectedNode) return;
    const projectId = activeProject.id;
    const plan = buildWorkflowExecutionPlan(workspace, projectId, selectedNode.id);
    const blockingIssue = plan.issues.find((issue) => issue.severity === "error");
    if (blockingIssue) {
      setApiNotice(`Workflow plan blocked: ${blockingIssue.message}`);
      return;
    }
    if (!plan.steps.length) {
      setApiNotice("No downstream workflow modules");
      return;
    }
    const requests = buildWorkflowGenerationRequests(workspace, projectId, selectedNode.id);
    let executed = 0;
    let runningNodeId: string | undefined;
    try {
      setApiNotice("Running backend workflow chain...");
      for (const request of requests) {
        const nextNode = activeProject.nodes.find((node) => node.id === request.nodeId);
        if (!nextNode) break;
        runningNodeId = nextNode.id;
        setWorkspace((current) => markNodeRunState(current, projectId, nextNode.id, "running"));
        const result = await submitGenerationRequest(request, activeUserId);
        const serverState = await fetchBackendSnapshot(activeUserId);
        setWorkspace((current) =>
          applyGenerationResultToCanvas(markNodeRunState(current, projectId, nextNode.id, "done"), projectId, nextNode.id, request, result, serverState)
        );
        executed += 1;
      }
      setRightPanel("history");
      setApiNotice(executed ? `Backend workflow completed ${executed} module${executed > 1 ? "s" : ""}` : "No downstream workflow modules");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Backend workflow failed";
      if (runningNodeId) {
        setWorkspace((current) => markNodeRunState(current, projectId, runningNodeId!, "error", message));
      }
      setApiNotice(message);
    }
  }

  async function runBatch(files?: FileList | null) {
    if (!activeProject) return;
    const imageFiles = Array.from(files ?? []).filter((file) => file.type.startsWith("image/"));
    if (imageFiles.length) {
      const prompt = selectedNode?.generation.prompt.trim() || "统一去背并调整成柔和棚拍光，保持服装版型清晰。";
      const imported = await Promise.all(
        imageFiles.map(async (file) => ({
          name: file.name,
          source: await readFileAsDataUrl(file),
          width: 240,
          height: 320
        }))
      );
      setWorkspace((current) => {
        const queued = importBatchFolder(current, activeProject.id, {
          folderName: "imported-folder",
          prompt,
          modelId: selectedNode?.generation.modelId || "background-cleaner",
          outputCount: selectedNode?.generation.outputCount || 1,
          files: imported
        });
        return runBatchQueue(queued, activeProject.id);
      });
      return;
    }
    setWorkspace((current) => {
      const queued = importBatchFolder(current, activeProject.id, {
        folderName: "sample-folder",
        prompt: "统一去背并调整成柔和棚拍光，保持服装版型清晰。",
        modelId: "background-cleaner",
        outputCount: 1,
        files: [
          { name: "look-01.jpg", source: TEST_IMAGE, width: 240, height: 320 },
          { name: "look-02.jpg", source: TEST_IMAGE, width: 240, height: 320 },
          { name: "look-03.jpg", source: TEST_IMAGE, width: 240, height: 320 }
        ]
      });
      return runBatchQueue(queued, activeProject.id);
    });
  }

  async function submitBackendBatch(projectId: string, batch: BatchImport) {
    try {
      setApiNotice(`Running backend batch for ${batch.files.length} images...`);
      const outcomes: BatchGenerationOutcome[] = [];
      const operation = operationForBatchModel(workspace.modelRegistry, batch.modelId, selectedNode ? operationForNode(selectedNode) : undefined);
      for (const [index, file] of batch.files.entries()) {
        try {
          const result = await submitGenerationRequest({
            projectId,
            nodeId: `batch-${file.name}-${index + 1}`,
            modelId: batch.modelId,
            prompt: batch.prompt,
            referenceNodeIds: [file.name],
            outputCount: batch.outputCount,
            operation
          }, activeUserId);
          outcomes.push({ result });
        } catch (error) {
          outcomes.push({ errorMessage: error instanceof Error ? error.message : "Batch item failed" });
        }
      }
      const serverState = await fetchBackendSnapshot(activeUserId);
      setWorkspace((current) => applyBatchGenerationResultsToCanvas(current, projectId, batch, outcomes, serverState));
      setRightPanel("history");
      const succeeded = outcomes.filter((outcome) => outcome.result).length;
      const failed = outcomes.length - succeeded;
      setApiNotice(failed ? `Backend batch completed for ${succeeded} of ${batch.files.length} images; ${failed} failed` : `Backend batch completed for ${batch.files.length} images`);
    } catch (error) {
      setApiNotice(error instanceof Error ? error.message : "Backend batch failed");
    }
  }

  async function runBackendBatch(files?: FileList | null) {
    if (!activeProject) return;
    const projectId = activeProject.id;
    const imageFiles = Array.from(files ?? []).filter((file) => file.type.startsWith("image/"));
    const prompt = selectedNode?.generation.prompt.trim() || "Apply the same clean product-image treatment to each image while preserving garment shape and fabric details.";
    const outputCount = selectedNode?.generation.outputCount || 1;
    const batch: BatchImport = imageFiles.length
      ? {
          folderName: "imported-folder",
          prompt,
          modelId: selectedNode?.generation.modelId || "background-cleaner",
          outputCount,
          files: await Promise.all(
            imageFiles.map(async (file) => ({
              name: file.name,
              source: await readFileAsDataUrl(file),
              width: 240,
              height: 320
            }))
          )
        }
      : {
          folderName: "sample-folder",
          prompt,
          modelId: "background-cleaner",
          outputCount,
          files: [
            { name: "look-01.jpg", source: TEST_IMAGE, width: 240, height: 320 },
            { name: "look-02.jpg", source: TEST_IMAGE, width: 240, height: 320 },
            { name: "look-03.jpg", source: TEST_IMAGE, width: 240, height: 320 }
          ]
        };
    await submitBackendBatch(projectId, batch);
  }

  async function retryFailedBatch() {
    if (!activeProject) return;
    try {
      const batch = buildRetryBatchFromFailures(workspace, activeProject.id);
      await submitBackendBatch(activeProject.id, batch);
    } catch (error) {
      setApiNotice(error instanceof Error ? error.message : "No failed batch items to retry");
    }
  }

  function cancelActiveBatch() {
    if (!activeProject) return;
    setWorkspace((current) => cancelBatchQueue(current, activeProject.id));
    setRightPanel("history");
    setApiNotice("Batch queue cancelled");
  }
  function shapeEdit() {
    if (!activeProject) return;
    const imageNode = isCanvasImageNode(selectedNode) ? selectedNode : activeProject.nodes.find(isCanvasImageNode);
    if (!imageNode) return;
    setShapeEditDraft({
      nodeId: imageNode.id,
      shape: "ellipse",
      prompt: "只在圈选区域增加精细刺绣花型，保持其他区域不变。"
    });
  }

  async function confirmShapeEdit() {
    if (!activeProject || !shapeEditDraft) return;
    const projectId = activeProject.id;
    const source = activeProject.nodes.find((node) => node.id === shapeEditDraft.nodeId);
    if (!source) return;
    const editDraft = shapeEditDraft;
    setWorkspace((current) =>
      commitShapeEdit(current, projectId, editDraft.nodeId, {
        shape: editDraft.shape,
        prompt: editDraft.prompt,
        mask: editDraft.mask ?? DEFAULT_MASK_SELECTION
      })
    );
    setShapeEditDraft(null);
    const request = {
      projectId,
      nodeId: source.id,
      modelId: source.generation.modelId,
      prompt: editDraft.prompt,
      referenceNodeIds: source.references.length ? source.references : [source.id],
      outputCount: 1,
      operation: "edit" as OperationType,
      mask: editDraft.mask ?? DEFAULT_MASK_SELECTION
    };
    try {
      setApiNotice("Running backend mask edit...");
      setWorkspace((current) => markNodeRunState(current, projectId, source.id, "running"));
      const result = await submitGenerationRequest(request, activeUserId);
      const serverState = await fetchBackendSnapshot(activeUserId);
      setWorkspace((current) =>
        applyGenerationResultToCanvas(markNodeRunState(current, projectId, source.id, "done"), projectId, source.id, request, result, serverState)
      );
      setRightPanel("history");
      setApiNotice(`Backend mask edit succeeded, ${result.creditCost} credits used`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Backend mask edit failed";
      setWorkspace((current) => markNodeRunState(current, projectId, source.id, "error", message));
      setApiNotice(message);
    }
  }
  function saveAsset() {
    if (!activeProject || !selectedNode) return;
    setWorkspace((current) => saveNodeAsAsset(current, activeProject.id, selectedNode.id));
    setRightPanel("assets");
  }

  async function saveSelectedPrompt() {
    if (!selectedNode) return;
    const prompt = selectedNode.generation.prompt.trim();
    if (!prompt) {
      setApiNotice("Prompt is required before saving to library");
      return;
    }
    try {
      const savedPrompt = await savePromptPresetRemote(
        {
          title: `${selectedNode.name} prompt`,
          prompt,
          tags: ["designer", selectedNode.generation.modelId]
        },
        activeUserId
      );
      setWorkspace((current) => ({
        ...current,
        prompts: [savedPrompt, ...current.prompts.filter((item) => item.id !== savedPrompt.id)]
      }));
      setRightPanel("prompts");
      setApiNotice("Prompt saved to library");
    } catch (error) {
      setApiNotice(error instanceof Error ? error.message : "Prompt save failed");
    }
  }

  async function deletePrompt(promptId: string) {
    try {
      const prompts = await deletePromptPresetRemote(promptId, activeUserId);
      setWorkspace((current) => ({
        ...current,
        prompts
      }));
      setRightPanel("prompts");
      setApiNotice("Prompt removed from library");
    } catch (error) {
      setApiNotice(error instanceof Error ? error.message : "Prompt delete failed");
    }
  }

  function insertAssetIntoCanvas(asset: LibraryAsset) {
    if (!activeProject) return;
    if (asset.type === "text") {
      setWorkspace((current) => addTextNode(current, activeProject.id, asset.source, 620, 360));
      return;
    }
    const width = typeof asset.metadata?.width === "number" ? asset.metadata.width : 320;
    const height = typeof asset.metadata?.height === "number" ? asset.metadata.height : 320;
    setWorkspace((current) =>
      addAssetToProject(current, activeProject.id, {
        name: asset.title,
        source: asset.source,
        width,
        height
      })
    );
  }

  function insertAssistantNote(content: string) {
    if (!activeProject) return;
    setWorkspace((current) => addTextNode(current, activeProject.id, content, 760, 260));
  }

  async function adjustCredits(targetUserId: string, delta: number, reason: string) {
    const updatedProfile = await adjustDesignerCredits({ targetUserId, delta, reason }, activeUserId);
    if (updatedProfile.userId === activeUserId) {
      setWorkspace((current) => ({
        ...current,
        profile: {
          ...current.profile,
          creditBalance: updatedProfile.creditBalance,
          credits: updatedProfile.credits,
          creditUsed: updatedProfile.creditUsed,
          creditLimit: updatedProfile.creditLimit
        }
      }));
    }
    setApiNotice(`Credits updated for ${updatedProfile.userId}: ${updatedProfile.creditBalance} remaining`);
    return updatedProfile;
  }

  async function setCreditLimit(targetUserId: string, creditLimit: number, reason: string) {
    const updatedProfile = await setDesignerCreditLimit({ targetUserId, creditLimit, reason }, activeUserId);
    if (updatedProfile.userId === activeUserId) {
      setWorkspace((current) => ({
        ...current,
        profile: {
          ...current.profile,
          creditBalance: updatedProfile.creditBalance,
          credits: updatedProfile.credits,
          creditUsed: updatedProfile.creditUsed,
          creditLimit: updatedProfile.creditLimit
        }
      }));
    }
    setApiNotice(`Credit limit updated for ${updatedProfile.userId}: ${updatedProfile.creditLimit ?? "unlimited"}`);
    return updatedProfile;
  }

  async function updateModelPricing(modelId: string, cost: number, priceCents: number, currency: ModelDefinition["currency"]) {
    const updatedModel = await configureAdminModelPricing({ modelId, cost, priceCents, currency }, activeUserId);
    setWorkspace((current) => ({
      ...current,
      modelRegistry: current.modelRegistry.map((model) => (model.id === updatedModel.id ? updatedModel : model))
    }));
    setApiNotice(`Model pricing updated for ${updatedModel.name}: ${updatedModel.cost} credits`);
    return updatedModel;
  }

  async function updateModelRegistry(request: ModelRegistryRequest) {
    const updatedModel = await configureAdminModelRegistry(request, activeUserId);
    setWorkspace((current) => {
      const exists = current.modelRegistry.some((model) => model.id === updatedModel.id);
      return {
        ...current,
        modelRegistry: exists
          ? current.modelRegistry.map((model) => (model.id === updatedModel.id ? updatedModel : model))
          : [...current.modelRegistry, updatedModel]
      };
    });
    setApiNotice(`Model registered: ${updatedModel.name}`);
    return updatedModel;
  }

  async function updateProviderSettings(request: ProviderSettingsRequest) {
    const provider = await configureAdminProviderSettings(request, activeUserId);
    setApiNotice(`Provider ${provider.provider} updated to ${provider.mode}`);
    return provider;
  }

  if (view === "canvas" && activeProject) {
    return (
      <CanvasView
        workspace={workspace}
        project={activeProject}
        selectedNode={selectedNode}
        apiNotice={apiNotice}
        rightPanel={rightPanel}
        onBack={() => setView("home")}
        onRightPanel={setRightPanel}
        onWorkspaceChange={setWorkspace}
        shapeEditDraft={shapeEditDraft}
        onShapeEditDraft={setShapeEditDraft}
        onConfirmShapeEdit={confirmShapeEdit}
        onCancelShapeEdit={() => setShapeEditDraft(null)}
        onUpdateConfig={updateSelectedConfig}
        onUpdateMetadata={updateSelectedMetadata}
        onImportImages={importImagePair}
        onGenerate={runSelectedGeneration}
        onGenerateNode={(nodeId) => void generateNodeThroughApi(nodeId)}
        onBatch={runBackendBatch}
        onRetryBatch={retryFailedBatch}
        onCancelBatch={cancelActiveBatch}
        onWorkflow={runWorkflow}
        onAddModule={addWorkflowModule}
        onAddSettingsNode={addWorkflowSettingsNode}
        onConnectModule={connectSelectionToNewModule}
        onGroupReferences={groupReferences}
        onAssistantNote={insertAssistantNote}
        onUpscale={() => runImageOperation("upscale")}
        onRemoveBg={() => runImageOperation("removeBackground")}
        onShapeEdit={shapeEdit}
        onSaveAsset={saveAsset}
        onSavePrompt={saveSelectedPrompt}
        onDeletePrompt={deletePrompt}
        onInsertAsset={insertAssetIntoCanvas}
        onAddTargetFrame={() => setWorkspace((current) => addGenerationTargetFrame(current, activeProject.id))}
      />
    );
  }

  if (view === "admin") {
    return (
      <AdminView
        workspace={workspace}
        activeUserId={activeUserId}
        notice={apiNotice}
        onBack={() => setView("home")}
        onAdjustCredits={adjustCredits}
        onSetCreditLimit={setCreditLimit}
        onUpdateModelPricing={updateModelPricing}
        onUpdateModelRegistry={updateModelRegistry}
        onConfigureProvider={updateProviderSettings}
      />
    );
  }

  if (view === "login") {
    return <LoginView onLogin={login} />;
  }

  return <HomeView workspace={workspace} onCreateProject={openNewProject} onOpenProject={openProject} onRenameProject={renameProject} onDeleteProject={deleteProject} onAdmin={() => setView("admin")} />;
}

function LoginView({ onLogin }: { onLogin: (email: string) => void }) {
  const [email, setEmail] = useState("admin@company.local");
  const [password, setPassword] = useState("canvas-demo");
  return (
    <main className="login-shell">
      <section className="login-panel">
        <div className="login-brand">
          <span>内部访问</span>
          <h1>登录 Canvas Ops</h1>
          <p>进入公司设计工作台，统一管理项目、图片素材、生图接口、额度和后台监控。</p>
        </div>
        <label>
          <span>邮箱</span>
          <input aria-label="Email" value={email} onChange={(event) => setEmail(event.target.value)} />
        </label>
        <label>
          <span>密码</span>
          <input aria-label="Password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} />
        </label>
        <button type="button" className="generate-button" onClick={() => email.trim() && password.trim() && onLogin(email)}>
          登录
        </button>
      </section>
      <aside className="login-copy">
        <strong>团队工作台</strong>
        <p>把公司内部图片生产集中到一个受控空间。</p>
        <ul>
          <li>项目、画布和图片来源都会绑定到团队账号。</li>
          <li>生图接口密钥只保存在公司后端边界内。</li>
          <li>生成图片会带着创建人、模型和提示词回到素材库。</li>
        </ul>
      </aside>
    </main>
  );
}

function HomeView({
  workspace,
  onCreateProject,
  onOpenProject,
  onRenameProject,
  onDeleteProject,
  onAdmin
}: {
  workspace: Workspace;
  onCreateProject: () => void;
  onOpenProject: (projectId: string, target?: OpenProjectTarget) => void;
  onRenameProject: (projectId: string, name: string) => void;
  onDeleteProject: (projectId: string) => void;
  onAdmin: () => void;
}) {
  const [activeSection, setActiveSection] = useState<HomeSection>("Projects");
  const projectCards = workspace.projects.length ? workspace.projects : [];
  return (
    <main className="home-shell">
      <SideNav
        workspace={workspace}
        active={activeSection}
        onAdmin={onAdmin}
        onCreateProject={onCreateProject}
        onNavigate={(section) => {
          if (section === "Projects" || section === "History" || section === "Profile") setActiveSection(section);
        }}
      />
      <section className="home-main">
        <div className="home-banner">
          <div>
            <h1>Design canvas for internal image production</h1>
            <p>Projects, prompts, assets, workflow nodes, model usage and designer credits in one controlled workspace.</p>
          </div>
          <div className="home-metric">
            <span>Team balance</span>
            <strong>{workspace.profile.creditBalance}</strong>
            <small>{workspace.profile.creditUsed} credits used</small>
          </div>
        </div>
        {activeSection === "Projects" && <ProjectsPanel projects={projectCards} onCreateProject={onCreateProject} onOpenProject={onOpenProject} onRenameProject={onRenameProject} onDeleteProject={onDeleteProject} />}
        {activeSection === "History" && <HistoryPanel workspace={workspace} onOpenProject={onOpenProject} />}
        {activeSection === "Profile" && <ProfilePanel workspace={workspace} />}
      </section>
    </main>
  );
}

function ProjectsPanel({
  projects,
  onCreateProject,
  onOpenProject,
  onRenameProject,
  onDeleteProject
}: {
  projects: Project[];
  onCreateProject: () => void;
  onOpenProject: (projectId: string, target?: OpenProjectTarget) => void;
  onRenameProject: (projectId: string, name: string) => void;
  onDeleteProject: (projectId: string) => void;
}) {
  const [editingProjectId, setEditingProjectId] = useState<string | null>(null);
  const [draftProjectName, setDraftProjectName] = useState("");

  function startRename(project: Project) {
    setEditingProjectId(project.id);
    setDraftProjectName(project.name);
  }

  function saveRename(event: FormEvent<HTMLFormElement>, project: Project) {
    event.preventDefault();
    onRenameProject(project.id, draftProjectName);
    setEditingProjectId(null);
    setDraftProjectName("");
  }

  return (
    <>
      <div className="home-filters">
        <button type="button" className="filter active">My projects</button>
        <button type="button" className="filter">Shared by me</button>
        <button type="button" className="filter">Shared with me</button>
        <button type="button" className="filter">Featured projects</button>
        <button type="button" className="filter muted">Last opened <ChevronDown size={13} /></button>
      </div>
      <section className="project-grid" aria-label="Projects">
        <button type="button" className="project-card create-card" onClick={onCreateProject} aria-label="New project">
          <span className="plus">+</span>
          <strong>Create new project</strong>
        </button>
        {projects.map((project) => (
          <article className="project-card managed-project-card" key={project.id}>
            <button type="button" className="project-card-main" aria-label={`Open project ${project.name}`} onClick={() => onOpenProject(project.id)}>
              <div className="project-thumb">
                {project.nodes[0]?.source ? <img src={project.nodes[0].source} alt="" /> : <span>No images</span>}
              </div>
              <strong>{project.name}</strong>
              <small>{project.nodes.length} nodes · modified just now</small>
            </button>
            {editingProjectId === project.id ? (
              <form className="project-rename-form" onSubmit={(event) => saveRename(event, project)}>
                <input
                  aria-label={`Project name for ${project.name}`}
                  value={draftProjectName}
                  onChange={(event) => setDraftProjectName(event.target.value)}
                />
                <button type="submit" aria-label={`Save project name for ${project.name}`}>
                  <Check size={14} />
                </button>
              </form>
            ) : null}
            <div className="project-card-actions">
              <button type="button" className="project-card-icon" aria-label={`Rename project ${project.name}`} onClick={() => startRename(project)}>
                <Pencil size={14} />
              </button>
              <button type="button" className="project-card-icon" aria-label={`Delete project ${project.name}`} onClick={() => onDeleteProject(project.id)}>
                <Trash2 size={14} />
              </button>
            </div>
          </article>
        ))}
        {!projects.length && (
          <article className="project-card empty-project-card">
            <div className="project-thumb"><span>No images</span></div>
            <strong>Untitled</strong>
            <small>Create a task to enter canvas</small>
          </article>
        )}
      </section>
    </>
  );
}

function HistoryPanel({ workspace, onOpenProject }: { workspace: Workspace; onOpenProject: (projectId: string, target?: OpenProjectTarget) => void }) {
  const generatedNodes = workspace.projects.flatMap((project) =>
    project.nodes
      .filter((node) => node.kind === "generated" || node.kind === "edit" || node.kind === "operation")
      .map((node) => ({ project, node }))
  );
  function sourceForHistoryOutput(entryId: string, outputName: string, remoteSource: string) {
    const match = generatedNodes.find(
      ({ node }) => node.metadata.historyId === entryId && (node.metadata.remoteSource === remoteSource || node.name === outputName)
    );
    return match?.node.source ?? remoteSource;
  }
  return (
    <section className="home-section" aria-label="History management">
      <div className="section-heading">
        <div>
          <h2>History</h2>
          <p>Designer generation records, model usage, credit cost, project source and reusable outputs.</p>
        </div>
        <span>{workspace.history.length} records</span>
      </div>
      <div className="history-layout">
        <div className="history-records">
          {workspace.history.length ? (
            workspace.history.map((entry) => {
              const project = workspace.projects.find((item) => item.id === entry.projectId);
              return (
                <article className="history-record" key={entry.id}>
                  <div>
                    <strong>{entry.modelId}</strong>
                    <small>{entry.creditCost} credits · {entry.outputCount} output · {entry.referenceCount ?? 0} refs</small>
                  </div>
                  <p>{entry.prompt}</p>
                  {entry.outputs?.length ? (
                    <div className="history-output-strip" aria-label={`History outputs for ${entry.id}`}>
                      {entry.outputs.map((output) => (
                        <img
                          key={`${entry.id}-${output.name}-${output.source}`}
                          src={sourceForHistoryOutput(entry.id, output.name, output.source)}
                          alt={`History output ${output.name}`}
                        />
                      ))}
                    </div>
                  ) : null}
                  <button type="button" onClick={() => project && onOpenProject(project.id, { historyId: entry.id, nodeId: entry.nodeId })} disabled={!project}>
                    Open project
                  </button>
                </article>
              );
            })
          ) : (
            <article className="empty-history">
              <strong>No generation history yet</strong>
              <p>Run a generation, edit, upscale, remove background or batch job inside a project to populate this ledger.</p>
            </article>
          )}
        </div>
        <div className="history-gallery" aria-label="Generated image gallery">
          {generatedNodes.length ? (
            generatedNodes.slice(0, 12).map(({ project, node }) => (
              <button
                type="button"
                key={node.id}
                className="history-thumb"
                onClick={() =>
                  onOpenProject(project.id, {
                    nodeId: node.id,
                    historyId: typeof node.metadata.historyId === "string" ? node.metadata.historyId : undefined
                  })
                }
              >
                <img src={node.source} alt="" />
                <strong>{node.name}</strong>
                <small>{project.name}</small>
              </button>
            ))
          ) : (
            <div className="history-thumb empty">No generated images</div>
          )}
        </div>
      </div>
    </section>
  );
}

function ProfilePanel({ workspace }: { workspace: Workspace }) {
  const creditUsageBase = workspace.profile.creditLimit ?? workspace.profile.creditUsed + workspace.profile.creditBalance;
  const usagePercent = Math.min(100, Math.round((workspace.profile.creditUsed / Math.max(1, creditUsageBase)) * 100));
  const modelSpend = workspace.history.reduce<Record<string, number>>((memo, entry) => {
    memo[entry.modelId] = (memo[entry.modelId] ?? 0) + entry.creditCost;
    return memo;
  }, {});
  return (
    <section className="home-section" aria-label="Profile credit management">
      <div className="section-heading">
        <div>
          <h2>Profile</h2>
          <p>Account quota management for the designer name, role, model access and credit usage.</p>
        </div>
        <span>{workspace.profile.role}</span>
      </div>
      <div className="profile-grid">
        <article className="profile-card account-card">
          <span>Designer</span>
          <strong>{workspace.profile.designerName}</strong>
          <small>{workspace.profile.userId}</small>
        </article>
        <article className="profile-card credit-card">
          <span>Credit balance</span>
          <strong>{workspace.profile.creditBalance}</strong>
          <small>
            {workspace.profile.creditUsed} credits used 路 limit {workspace.profile.creditLimit ?? "not set"}
          </small>
          <div className="credit-meter"><i style={{ width: `${usagePercent}%` }} /></div>
        </article>
        <article className="profile-card">
          <span>Project access</span>
          <strong>{workspace.projects.length}</strong>
          <small>active internal workspaces</small>
        </article>
        <article className="profile-card">
          <span>Model registry</span>
          <strong>{workspace.modelRegistry.length}</strong>
          <small>server-hosted provider entries</small>
        </article>
      </div>
      <div className="profile-ledger">
        <article>
          <h3>Credit ledger</h3>
          {workspace.history.length ? (
            workspace.history.slice(0, 6).map((entry) => (
              <div className="ledger-row" key={entry.id}>
                <span>{entry.modelId}</span>
                <strong>-{entry.creditCost}</strong>
                <small>{entry.prompt}</small>
              </div>
            ))
          ) : (
            <p>No credit deductions yet. Failed or empty-prompt jobs do not spend credits.</p>
          )}
        </article>
        <article>
          <h3>Model spend</h3>
          {Object.keys(modelSpend).length ? (
            Object.entries(modelSpend).map(([modelId, credits]) => (
              <div className="ledger-row" key={modelId}>
                <span>{modelId}</span>
                <strong>{credits}</strong>
                <small>credits consumed</small>
              </div>
            ))
          ) : (
            <p>Spend by model will appear after designers run generation jobs.</p>
          )}
        </article>
      </div>
    </section>
  );
}

function AdminView({
  workspace,
  activeUserId,
  notice,
  onBack,
  onAdjustCredits,
  onSetCreditLimit,
  onUpdateModelPricing,
  onUpdateModelRegistry,
  onConfigureProvider
}: {
  workspace: Workspace;
  activeUserId?: string;
  notice: string;
  onBack: () => void;
  onAdjustCredits: (targetUserId: string, delta: number, reason: string) => Promise<Profile>;
  onSetCreditLimit: (targetUserId: string, creditLimit: number, reason: string) => Promise<Profile>;
  onUpdateModelPricing: (modelId: string, cost: number, priceCents: number, currency: ModelDefinition["currency"]) => Promise<ModelDefinition>;
  onUpdateModelRegistry: (request: ModelRegistryRequest) => Promise<ModelDefinition>;
  onConfigureProvider: (request: ProviderSettingsRequest) => Promise<ProviderHealth>;
}) {
  const totalNodes = workspace.projects.reduce((sum, project) => sum + project.nodes.length, 0);
  const totalConnections = workspace.projects.reduce((sum, project) => sum + project.connections.length, 0);
  const runningJobs = workspace.projects.reduce((sum, project) => sum + project.nodes.filter((node) => node.status === "running").length, 0);
  const [targetUserId, setTargetUserId] = useState(workspace.profile.userId);
  const [creditDelta, setCreditDelta] = useState("20");
  const [creditReason, setCreditReason] = useState("Monthly design allocation");
  const [creditLimit, setCreditLimitValue] = useState(String(workspace.profile.creditLimit ?? workspace.profile.creditBalance));
  const [limitReason, setLimitReason] = useState("Monthly designer cap");
  const [pricingModelId, setPricingModelId] = useState(workspace.modelRegistry[0]?.id ?? "");
  const selectedPricingModel = workspace.modelRegistry.find((model) => model.id === pricingModelId) ?? workspace.modelRegistry[0];
  const [modelCost, setModelCost] = useState(String(selectedPricingModel?.cost ?? 1));
  const [modelPriceCents, setModelPriceCents] = useState(String(selectedPricingModel?.priceCents ?? 0));
  const [modelCurrency, setModelCurrency] = useState<ModelDefinition["currency"]>(selectedPricingModel?.currency ?? "CNY");
  const [registryModelId, setRegistryModelId] = useState("custom-fashion-v1");
  const [registryModelName, setRegistryModelName] = useState("Custom Fashion V1");
  const [registryProvider, setRegistryProvider] = useState<ModelDefinition["provider"]>("runninghub");
  const [registryGroup, setRegistryGroup] = useState<ModelDefinition["group"]>("Image");
  const [registryCapabilities, setRegistryCapabilities] = useState<ModuleType[]>(["generate", "edit"]);
  const [registryCost, setRegistryCost] = useState("6");
  const [registryPriceCents, setRegistryPriceCents] = useState("399");
  const [registryCurrency, setRegistryCurrency] = useState<ModelDefinition["currency"]>("CNY");
  const [providerId, setProviderId] = useState<ModelDefinition["provider"]>(workspace.modelRegistry[0]?.provider ?? "openai");
  const [providerMode, setProviderMode] = useState<ProviderHealth["mode"]>("mock");
  const [providerEndpointUrl, setProviderEndpointUrl] = useState("");
  const [providerSecretName, setProviderSecretName] = useState("OPENAI_API_KEY");
  const [providerSecretValue, setProviderSecretValue] = useState("");
  const [creditNotice, setCreditNotice] = useState(notice);
  const [isAdjusting, setIsAdjusting] = useState(false);
  const [providerHealth, setProviderHealth] = useState<ProviderHealth[]>([]);
  const [adminAccounts, setAdminAccounts] = useState<AdminAccountSummary[]>([]);
  const [adminUsage, setAdminUsage] = useState<AdminUsageSummary | null>(null);
  const [adminJobs, setAdminJobs] = useState<AdminGenerationJob[]>([]);
  const [adminHistory, setAdminHistory] = useState<AdminHistoryEntry[]>([]);
  const [filteredAdminHistory, setFilteredAdminHistory] = useState<AdminHistoryEntry[] | null>(null);
  const [adminHistoryUserFilter, setAdminHistoryUserFilter] = useState("all");
  const [adminAudit, setAdminAudit] = useState<AdminAuditEntry[]>(workspace.history.map(historyEntryToAuditEntry));
  const estimatedSpend = formatMoneyCents(adminUsage?.totalPriceCents, adminUsage?.currency);
  const providers = workspace.modelRegistry.reduce<Record<string, number>>((memo, model) => {
    memo[model.provider] = (memo[model.provider] ?? 0) + 1;
    return memo;
  }, {});
  const configurableProviders = Array.from(new Set(["openai", "nanobanana", "runninghub", "comfyui", "internal", ...workspace.modelRegistry.map((model) => model.provider)])) as ModelDefinition["provider"][];
  const modelGroupOptions: ModelDefinition["group"][] = ["Trending models", "Image", "Edit", "Operations"];
  const modelCapabilityOptions: ModuleType[] = ["generate", "edit", "upscale", "removeBackground"];
  const visibleAdminAudit = adminAudit.length ? adminAudit : workspace.history.map(historyEntryToAuditEntry);
  const adminHistoryDesigners = Array.from(
    new Map(adminHistory.map((entry) => [entry.userId ?? "unknown-user", entry.designerName ?? entry.userId ?? "Unknown designer"])).entries()
  ).sort(([left], [right]) => left.localeCompare(right));
  const visibleAdminHistory =
    adminHistoryUserFilter === "all"
      ? adminHistory
      : filteredAdminHistory ?? adminHistory.filter((entry) => entry.userId === adminHistoryUserFilter);

  useEffect(() => {
    let cancelled = false;
    void fetchProviderHealth(activeUserId)
      .then((health) => {
        if (!cancelled) setProviderHealth(health);
      })
      .catch((error) => {
        if (!cancelled) setCreditNotice(error instanceof Error ? error.message : "Provider health unavailable");
      });
    return () => {
      cancelled = true;
    };
  }, [activeUserId]);

  useEffect(() => {
    let cancelled = false;
    void fetchAdminAccounts(activeUserId)
      .then((accounts) => {
        if (!cancelled) setAdminAccounts(accounts);
      })
      .catch((error) => {
        if (!cancelled) setCreditNotice(error instanceof Error ? error.message : "Account list unavailable");
      });
    return () => {
      cancelled = true;
    };
  }, [activeUserId]);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([fetchAdminUsage(activeUserId), fetchAdminAudit(activeUserId), fetchAdminJobs(activeUserId), fetchAdminHistory(activeUserId)])
      .then(([usage, audit, jobs, history]) => {
        if (!cancelled) {
          setAdminUsage(usage);
          setAdminAudit(audit);
          setAdminJobs(jobs);
          setAdminHistory(history);
        }
      })
      .catch((error) => {
        if (!cancelled) setCreditNotice(error instanceof Error ? error.message : "Admin usage unavailable");
      });
    return () => {
      cancelled = true;
    };
  }, [activeUserId]);

  useEffect(() => {
    if (adminHistoryUserFilter === "all") {
      setFilteredAdminHistory(null);
      return;
    }
    let cancelled = false;
    void fetchAdminHistory(activeUserId, adminHistoryUserFilter)
      .then((history) => {
        if (!cancelled) setFilteredAdminHistory(history);
      })
      .catch((error) => {
        if (!cancelled) setCreditNotice(error instanceof Error ? error.message : "Filtered team history unavailable");
      });
    return () => {
      cancelled = true;
    };
  }, [activeUserId, adminHistoryUserFilter]);

  function syncAccountRow(profile: Profile) {
    setAdminAccounts((current) => {
      const nextAccount: AdminAccountSummary = {
        userId: profile.userId,
        designerName: profile.designerName,
        role: profile.role,
        creditBalance: profile.creditBalance,
        creditUsed: profile.creditUsed,
        credits: profile.credits,
        creditLimit: profile.creditLimit,
        projectCount: current.find((account) => account.userId === profile.userId)?.projectCount ?? 0,
        historyCount: current.find((account) => account.userId === profile.userId)?.historyCount ?? 0,
        assetCount: current.find((account) => account.userId === profile.userId)?.assetCount ?? 0,
        lastActivityAt: current.find((account) => account.userId === profile.userId)?.lastActivityAt
      };
      const exists = current.some((account) => account.userId === profile.userId);
      const updated = exists ? current.map((account) => (account.userId === profile.userId ? nextAccount : account)) : [...current, nextAccount];
      return updated.sort((left, right) => left.userId.localeCompare(right.userId));
    });
  }

  async function refreshAdminReports() {
    const [usage, audit] = await Promise.all([fetchAdminUsage(activeUserId), fetchAdminAudit(activeUserId)]);
    setAdminUsage(usage);
    setAdminAudit(audit);
  }

  async function submitCreditAdjustment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsAdjusting(true);
    try {
      const profile = await onAdjustCredits(targetUserId, Number(creditDelta), creditReason);
      syncAccountRow(profile);
      await refreshAdminReports();
      setCreditNotice(`${profile.designerName} now has ${profile.creditBalance} credits`);
    } catch (error) {
      setCreditNotice(error instanceof Error ? error.message : "Credit adjustment failed");
    } finally {
      setIsAdjusting(false);
    }
  }

  async function submitCreditLimit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsAdjusting(true);
    try {
      const profile = await onSetCreditLimit(targetUserId, Number(creditLimit), limitReason);
      syncAccountRow(profile);
      await refreshAdminReports();
      setCreditNotice(`${profile.designerName} credit limit set to ${profile.creditLimit}`);
    } catch (error) {
      setCreditNotice(error instanceof Error ? error.message : "Credit limit update failed");
    } finally {
      setIsAdjusting(false);
    }
  }

  async function submitModelPricing(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsAdjusting(true);
    try {
      const model = await onUpdateModelPricing(pricingModelId, Number(modelCost), Number(modelPriceCents), modelCurrency);
      await refreshAdminReports();
      setCreditNotice(`${model.name} now costs ${model.cost} credits per output`);
    } catch (error) {
      setCreditNotice(error instanceof Error ? error.message : "Model pricing update failed");
    } finally {
      setIsAdjusting(false);
    }
  }

  function toggleRegistryCapability(capability: ModuleType) {
    setRegistryCapabilities((current) =>
      current.includes(capability) ? current.filter((item) => item !== capability) : [...current, capability]
    );
  }

  async function submitModelRegistry(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsAdjusting(true);
    try {
      const model = await onUpdateModelRegistry({
        modelId: registryModelId,
        name: registryModelName,
        provider: registryProvider,
        group: registryGroup,
        capability: registryCapabilities,
        cost: Number(registryCost),
        priceCents: Number(registryPriceCents),
        currency: registryCurrency
      });
      setPricingModelId(model.id);
      setModelCost(String(model.cost));
      setModelPriceCents(String(model.priceCents ?? 0));
      setModelCurrency(model.currency ?? "CNY");
      await refreshAdminReports();
      setCreditNotice(`${model.name} registered for ${model.provider}`);
    } catch (error) {
      setCreditNotice(error instanceof Error ? error.message : "Model registration failed");
    } finally {
      setIsAdjusting(false);
    }
  }

  async function submitProviderSettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsAdjusting(true);
    try {
      const provider = await onConfigureProvider({
        provider: providerId,
        mode: providerMode,
        endpointUrl: providerEndpointUrl || undefined,
        secretName: providerSecretName || undefined,
        secretValue: providerSecretValue || undefined
      });
      setProviderHealth((current) => {
        const exists = current.some((item) => item.provider === provider.provider);
        return exists ? current.map((item) => (item.provider === provider.provider ? provider : item)) : [...current, provider];
      });
      await refreshAdminReports();
      setProviderSecretValue("");
      setCreditNotice(`${provider.provider} provider set to ${provider.mode}`);
    } catch (error) {
      setCreditNotice(error instanceof Error ? error.message : "Provider update failed");
    } finally {
      setIsAdjusting(false);
    }
  }

  return (
    <main className="admin-shell">
      <SideNav workspace={workspace} active="Profile" onAdmin={onBack} />
      <section className="admin-main">
        <header className="admin-header">
          <button type="button" className="toolbar-pill" onClick={onBack}>Back to projects</button>
          <div>
            <h1>Admin monitoring</h1>
            <p>账号额度、模型渠道、项目活动和生成审计。</p>
          </div>
        </header>
        <section className="admin-metrics">
          <MetricCard label="Projects" value={workspace.projects.length} detail="active canvas workspaces" />
          <MetricCard label="Canvas nodes" value={totalNodes} detail={`${totalConnections} workflow links`} />
          <MetricCard label="Credits used" value={adminUsage?.totalCreditsUsed ?? workspace.profile.creditUsed} detail={`${workspace.profile.creditBalance} remaining`} />
          <MetricCard label="Running jobs" value={runningJobs} detail={`${adminUsage?.totalHistoryEntries ?? workspace.history.length} history entries`} />
          <MetricCard label="Estimated spend" value={estimatedSpend ?? "Not priced"} detail="from configured model prices" />
        </section>
        <section className="admin-grid">
          <article className="admin-card team-accounts-card">
            <h2>Team accounts</h2>
            {adminAccounts.length ? (
              <div className="admin-account-list" aria-label="Team account list">
                {adminAccounts.map((account) => (
                  <div className="admin-account-row" key={account.userId}>
                    <div>
                      <strong>{account.designerName}</strong>
                      <span>{account.userId}</span>
                    </div>
                    <div>
                      <b>{account.creditBalance} remaining</b>
                      <small>
                        {account.creditUsed} used / limit {account.creditLimit ?? "not set"}
                      </small>
                    </div>
                    <small>
                      {account.projectCount} projects / {account.historyCount} history / {account.assetCount} assets
                    </small>
                    <small>Last active {formatActivityMinute(account.lastActivityAt)}</small>
                    <em>{account.role}</em>
                  </div>
                ))}
              </div>
            ) : (
              <p>No designer accounts loaded yet.</p>
            )}
          </article>
          <article className="admin-card">
            <h2>Model providers</h2>
            {providerHealth.map((provider) => (
              <div className="admin-row" key={provider.provider}>
                <span>{provider.provider}</span>
                <strong>{provider.status} / {provider.mode}</strong>
                <small>
                  {provider.modelCount} models · {provider.adapterId} ·{" "}
                  {provider.secretConfigured ? `configured: ${provider.configuredSecrets.join(", ") || "server internal"}` : `missing: ${provider.missingSecrets.join(" or ")}`}
                </small>
              </div>
            ))}
            {!providerHealth.length && Object.entries(providers).map(([provider, count]) => (
              <div className="admin-row" key={provider}>
                <span>{provider}</span>
                <strong>{count} models</strong>
                <small>healthy · backend hosted</small>
              </div>
            ))}
          </article>
          <article className="admin-card">
            <h2>Provider configuration</h2>
            <form className="admin-credit-form" onSubmit={submitProviderSettings}>
              <label>
                <span>Provider</span>
                <select
                  aria-label="Provider to configure"
                  value={providerId}
                  onChange={(event) => {
                    const nextProvider = event.target.value as ModelDefinition["provider"];
                    const health = providerHealth.find((item) => item.provider === nextProvider);
                    setProviderId(nextProvider);
                    setProviderMode(health?.mode ?? "mock");
                    setProviderEndpointUrl(health?.endpointUrl ?? "");
                    setProviderSecretName(health?.requiredSecrets[0] ?? "");
                  }}
                >
                  {configurableProviders.map((provider) => (
                    <option key={provider} value={provider}>
                      {provider}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>Mode</span>
                <select aria-label="Provider mode" value={providerMode} onChange={(event) => setProviderMode(event.target.value as ProviderHealth["mode"])}>
                  <option value="mock">Mock</option>
                  <option value="live-ready">Live ready</option>
                </select>
              </label>
              <label>
                <span>Endpoint URL</span>
                <input
                  aria-label="Provider endpoint URL"
                  value={providerEndpointUrl}
                  onChange={(event) => setProviderEndpointUrl(event.target.value)}
                  placeholder="https://api.provider.com/v1/images"
                />
              </label>
              <label>
                <span>Secret name</span>
                <input aria-label="Provider secret name" value={providerSecretName} onChange={(event) => setProviderSecretName(event.target.value)} />
              </label>
              <label>
                <span>Secret value</span>
                <input
                  aria-label="Provider secret value"
                  type="password"
                  value={providerSecretValue}
                  onChange={(event) => setProviderSecretValue(event.target.value)}
                  placeholder="Stored only on backend"
                />
              </label>
              <button type="submit" className="generate-button" disabled={isAdjusting}>
                Update provider
              </button>
            </form>
          </article>
          <article className="admin-card">
            <h2>Model registry</h2>
            <form className="admin-credit-form" onSubmit={submitModelRegistry}>
              <label>
                <span>Model ID</span>
                <input aria-label="Registry model ID" value={registryModelId} onChange={(event) => setRegistryModelId(event.target.value)} />
              </label>
              <label>
                <span>Model name</span>
                <input aria-label="Registry model name" value={registryModelName} onChange={(event) => setRegistryModelName(event.target.value)} />
              </label>
              <label>
                <span>Provider</span>
                <select aria-label="Registry provider" value={registryProvider} onChange={(event) => setRegistryProvider(event.target.value as ModelDefinition["provider"])}>
                  {configurableProviders.map((provider) => (
                    <option key={provider} value={provider}>
                      {provider}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>Group</span>
                <select aria-label="Registry group" value={registryGroup} onChange={(event) => setRegistryGroup(event.target.value as ModelDefinition["group"])}>
                  {modelGroupOptions.map((group) => (
                    <option key={group} value={group}>
                      {group}
                    </option>
                  ))}
                </select>
              </label>
              <div className="admin-checkbox-group" aria-label="Registry capabilities">
                {modelCapabilityOptions.map((capability) => (
                  <label key={capability}>
                    <input
                      type="checkbox"
                      checked={registryCapabilities.includes(capability)}
                      onChange={() => toggleRegistryCapability(capability)}
                    />
                    <span>{capability}</span>
                  </label>
                ))}
              </div>
              <label>
                <span>Credits per output</span>
                <input aria-label="Registry model credit cost" type="number" min={1} step={1} value={registryCost} onChange={(event) => setRegistryCost(event.target.value)} />
              </label>
              <label>
                <span>Price cents</span>
                <input
                  aria-label="Registry model price cents"
                  type="number"
                  min={0}
                  step={1}
                  value={registryPriceCents}
                  onChange={(event) => setRegistryPriceCents(event.target.value)}
                />
              </label>
              <label>
                <span>Currency</span>
                <select aria-label="Registry model currency" value={registryCurrency} onChange={(event) => setRegistryCurrency(event.target.value as ModelDefinition["currency"])}>
                  <option value="CNY">CNY</option>
                  <option value="USD">USD</option>
                </select>
              </label>
              <button type="submit" className="generate-button" disabled={isAdjusting}>
                Register model
              </button>
            </form>
            <div className="admin-price-list" aria-label="Registered model registry">
              {workspace.modelRegistry.slice(-6).map((model) => (
                <small key={model.id}>
                  {model.name}: {model.provider} / {model.capability.join(" + ")} / {model.cost} credits
                </small>
              ))}
            </div>
          </article>
          <article className="admin-card">
            <h2>Model usage</h2>
            {adminUsage?.modelUsage.length ? (
              adminUsage.modelUsage.map((usage) => (
                <div className="admin-row" key={usage.modelId}>
                  <span>{usage.modelId}</span>
                  <strong>{usage.credits} credits / {usage.count} outputs</strong>
                  <small>{formatEstimatedSpend(usage.priceCents, usage.currency)}</small>
                </div>
              ))
            ) : (
              <p>No model usage yet. Completed image jobs will appear here.</p>
            )}
          </article>
          <article className="admin-card">
            <h2>Team credit ledger</h2>
            <div className="admin-credit-summary" aria-label="Team credit totals">
              <strong>{adminUsage?.totalCreditsAllocated ?? 0} credits allocated</strong>
              <strong>{adminUsage?.totalCreditsRemoved ?? 0} credits removed</strong>
            </div>
            {adminUsage?.creditAdjustments.length ? (
              adminUsage.creditAdjustments.slice(0, 8).map((adjustment) => (
                <div className="admin-row" key={adjustment.id}>
                  <span>{adjustment.targetUserId}</span>
                  <strong>{adjustment.creditDelta > 0 ? `+${adjustment.creditDelta}` : adjustment.creditDelta} credits</strong>
                  <small>Balance {adjustment.creditBalance ?? "not recorded"}</small>
                  <small>{creditAdjustmentReason(adjustment.summary)}</small>
                  <small>{formatActivityMinute(adjustment.createdAt)} / {adjustment.actorUserId ?? "system"}</small>
                </div>
              ))
            ) : (
              <p>No credit adjustments yet. Admin allocations and removals will appear here.</p>
            )}
          </article>
          <article className="admin-card">
            <h2>Generation jobs</h2>
            {adminJobs.length ? (
              adminJobs.slice(0, 8).map((job) => (
                <div className="admin-row" key={job.id}>
                  <span>{job.designerName ?? job.userId} · {job.operation}</span>
                  <strong>
                    {job.status} · {job.creditCost} credits · {job.outputCount} output{job.outputCount === 1 ? "" : "s"}
                  </strong>
                  {job.priceCents !== undefined ? <small>Job spend {formatEstimatedSpend(job.priceCents, job.currency)}</small> : null}
                  <small>{job.projectName ?? job.projectId} / {job.modelId}</small>
                  {job.errorMessage && <small>{job.errorMessage}</small>}
                  {job.outputs?.length ? (
                    <div className="history-output-strip" aria-label={`Job outputs for ${job.id}`}>
                      {job.outputs.slice(0, 4).map((output) => (
                        <img key={`${job.id}-${output.name}`} src={output.source} alt={`Job output ${output.name}`} />
                      ))}
                    </div>
                  ) : null}
                  <small>{job.historyId ?? job.id}</small>
                </div>
              ))
            ) : (
              <p>No generation jobs yet. Completed or failed provider tasks will appear here.</p>
            )}
          </article>
          <article className="admin-card">
            <h2>Team history</h2>
            {adminHistory.length ? (
              <label className="admin-inline-filter">
                <span>Designer</span>
                <select
                  aria-label="Team history designer filter"
                  value={adminHistoryUserFilter}
                  onChange={(event) => setAdminHistoryUserFilter(event.target.value)}
                >
                  <option value="all">All designers</option>
                  {adminHistoryDesigners.map(([userId, designerName]) => (
                    <option key={userId} value={userId}>
                      {designerName}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            {visibleAdminHistory.length ? (
              visibleAdminHistory.slice(0, 6).map((entry) => (
                <div className="admin-row" key={entry.id}>
                  <span>{entry.designerName ?? entry.userId} · {entry.projectName ?? entry.projectId} · {entry.modelId}</span>
                  <strong>
                    {entry.creditCost} credits · {entry.outputCount} output{entry.outputCount === 1 ? "" : "s"}
                  </strong>
                  <small>{entry.prompt}</small>
                  {entry.outputs?.length ? (
                    <div className="history-output-strip" aria-label={`Team history outputs for ${entry.id}`}>
                      {entry.outputs.slice(0, 4).map((output) => (
                        <img key={`${entry.id}-${output.name}`} src={output.source} alt={`Team history output ${output.name}`} />
                      ))}
                    </div>
                  ) : (
                    <small>No output thumbnails recorded</small>
                  )}
                </div>
              ))
            ) : adminHistory.length ? (
              <p>No team generation history matches this designer.</p>
            ) : (
              <p>No team generation history yet. Designer outputs will appear here.</p>
            )}
          </article>
          <article className="admin-card">
            <h2>Admin audit</h2>
            {visibleAdminAudit.length ? (
              visibleAdminAudit.slice(0, 6).map((entry) => (
                <div className="admin-row" key={entry.id}>
                  <span>{entry.eventType ?? "generation"}</span>
                  <strong>{auditPrimaryMetric(entry)}</strong>
                  <small>{auditContext(entry)}</small>
                  {entry.priceCents !== undefined ? <small>Audit spend {formatEstimatedSpend(entry.priceCents, entry.currency)}</small> : null}
                  <small>{auditDescription(entry)}</small>
                </div>
              ))
            ) : (
              <p>No generation audit yet. Run a canvas job to populate this panel.</p>
            )}
          </article>
          <article className="admin-card">
            <h2>Access policy</h2>
            <div className="admin-row">
              <span>API keys</span>
              <strong>Server only</strong>
              <small>front end stores model ids and parameters, never provider secrets</small>
            </div>
            <div className="admin-row">
              <span>Role</span>
              <strong>{workspace.profile.role}</strong>
              <small>
                {workspace.profile.userId} 路 limit {workspace.profile.creditLimit ?? "not set"}
              </small>
            </div>
          </article>
          <article className="admin-card">
            <h2>Credit management</h2>
            <form className="admin-credit-form" onSubmit={submitCreditAdjustment}>
              <label>
                <span>Designer account</span>
                <input
                  aria-label="Designer account"
                  value={targetUserId}
                  onChange={(event) => setTargetUserId(event.target.value)}
                  placeholder="designer@company.local"
                />
              </label>
              <label>
                <span>Credit delta</span>
                <input
                  aria-label="Credit delta"
                  type="number"
                  step={1}
                  value={creditDelta}
                  onChange={(event) => setCreditDelta(event.target.value)}
                />
              </label>
              <label>
                <span>Reason</span>
                <input
                  aria-label="Credit reason"
                  value={creditReason}
                  onChange={(event) => setCreditReason(event.target.value)}
                />
              </label>
              <button type="submit" className="generate-button" disabled={isAdjusting}>
                {isAdjusting ? "Updating..." : "Update credits"}
              </button>
              <small aria-live="polite">{creditNotice}</small>
            </form>
          </article>
          <article className="admin-card">
            <h2>Designer credit limit</h2>
            <form className="admin-credit-form" onSubmit={submitCreditLimit}>
              <label>
                <span>Designer account</span>
                <input
                  aria-label="Limit designer account"
                  value={targetUserId}
                  onChange={(event) => setTargetUserId(event.target.value)}
                  placeholder="designer@company.local"
                />
              </label>
              <label>
                <span>Maximum credits</span>
                <input
                  aria-label="Credit limit"
                  type="number"
                  min={0}
                  step={1}
                  value={creditLimit}
                  onChange={(event) => setCreditLimitValue(event.target.value)}
                />
              </label>
              <label>
                <span>Reason</span>
                <input aria-label="Credit limit reason" value={limitReason} onChange={(event) => setLimitReason(event.target.value)} />
              </label>
              <button type="submit" className="generate-button" disabled={isAdjusting}>
                Set credit limit
              </button>
            </form>
          </article>
          <article className="admin-card">
            <h2>Model pricing</h2>
            <form className="admin-credit-form" onSubmit={submitModelPricing}>
              <label>
                <span>Model</span>
                <select
                  aria-label="Pricing model"
                  value={pricingModelId}
                  onChange={(event) => {
                    const model = workspace.modelRegistry.find((item) => item.id === event.target.value);
                    setPricingModelId(event.target.value);
                    setModelCost(String(model?.cost ?? 1));
                    setModelPriceCents(String(model?.priceCents ?? 0));
                    setModelCurrency(model?.currency ?? "CNY");
                  }}
                >
                  {workspace.modelRegistry.map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>Credits per output</span>
                <input aria-label="Model credit cost" type="number" min={1} step={1} value={modelCost} onChange={(event) => setModelCost(event.target.value)} />
              </label>
              <label>
                <span>Price cents</span>
                <input
                  aria-label="Model price cents"
                  type="number"
                  min={0}
                  step={1}
                  value={modelPriceCents}
                  onChange={(event) => setModelPriceCents(event.target.value)}
                />
              </label>
              <label>
                <span>Currency</span>
                <select aria-label="Model currency" value={modelCurrency} onChange={(event) => setModelCurrency(event.target.value as ModelDefinition["currency"])}>
                  <option value="CNY">CNY</option>
                  <option value="USD">USD</option>
                </select>
              </label>
              <button type="submit" className="generate-button" disabled={isAdjusting}>
                Update model pricing
              </button>
            </form>
            <div className="admin-price-list" aria-label="Configured model pricing">
              {workspace.modelRegistry.slice(0, 5).map((model) => (
                <small key={model.id}>
                  {model.name}: {model.cost} credits{model.priceCents !== undefined ? ` / ${(model.priceCents / 100).toFixed(2)} ${model.currency ?? "CNY"}` : ""}
                </small>
              ))}
            </div>
          </article>
        </section>
      </section>
    </main>
  );
}

function MetricCard({ label, value, detail }: { label: string; value: number | string; detail: string }) {
  return (
    <article className="metric-card">
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </article>
  );
}

function exportProjectPackage(workspace: Workspace, project: Project) {
  const payload = {
    project,
    assets: workspace.assets,
    prompts: workspace.prompts,
    history: workspace.history.filter((entry) => entry.projectId === project.id),
    models: workspace.modelRegistry.map(({ id, name, provider, group, capability }) => ({ id, name, provider, group, capability })),
    exportedAt: new Date().toISOString()
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${project.name.replace(/\s+/g, "-").toLowerCase()}-canvas-package.json`;
  link.click();
  URL.revokeObjectURL(url);
}

export function downloadCanvasNode(node?: CanvasNode) {
  if (!node?.source) return;
  const link = document.createElement("a");
  link.href = node.source;
  link.download = node.name.replace(/[\\/:*?"<>|]+/g, "-") || "canvas-image.png";
  link.click();
}

function CanvasView({
  workspace,
  project,
  selectedNode,
  apiNotice,
  rightPanel,
  shapeEditDraft,
  onBack,
  onRightPanel,
  onWorkspaceChange,
  onShapeEditDraft,
  onConfirmShapeEdit,
  onCancelShapeEdit,
  onUpdateConfig,
  onUpdateMetadata,
  onImportImages,
  onGenerate,
  onGenerateNode,
  onBatch,
  onRetryBatch,
  onCancelBatch,
  onWorkflow,
  onAddModule,
  onAddSettingsNode,
  onConnectModule,
  onGroupReferences,
  onAssistantNote,
  onUpscale,
  onRemoveBg,
  onShapeEdit,
  onSaveAsset,
  onSavePrompt,
  onDeletePrompt,
  onInsertAsset,
  onAddTargetFrame
}: {
  workspace: Workspace;
  project: Project;
  selectedNode?: CanvasNode;
  apiNotice: string;
  rightPanel: RightPanel;
  shapeEditDraft: ShapeEditDraft;
  onBack: () => void;
  onRightPanel: (panel: RightPanel) => void;
  onWorkspaceChange: (updater: (workspace: Workspace) => Workspace) => void;
  onShapeEditDraft: (draft: ShapeEditDraft) => void;
  onConfirmShapeEdit: () => void;
  onCancelShapeEdit: () => void;
  onUpdateConfig: (patch: Partial<CanvasNode["generation"]>) => void;
  onUpdateMetadata: (patch: Record<string, unknown>) => void;
  onImportImages: () => void;
  onGenerate: () => void;
  onGenerateNode: (nodeId: string) => void;
  onBatch: () => void;
  onRetryBatch: () => void;
  onCancelBatch: () => void;
  onWorkflow: () => void;
  onAddModule: (moduleType: ModuleType) => void;
  onAddSettingsNode: () => void;
  onConnectModule: (moduleType: ModuleType, sourceNodeIds?: string[]) => void;
  onGroupReferences: () => void;
  onAssistantNote: (content: string) => void;
  onUpscale: () => void;
  onRemoveBg: () => void;
  onShapeEdit: () => void;
  onSaveAsset: () => void;
  onSavePrompt: () => void;
  onDeletePrompt: (promptId: string) => void;
  onInsertAsset: (asset: LibraryAsset) => void;
  onAddTargetFrame: () => void;
}) {
  const stats = useMemo(
    () => ({
      images: project.nodes.filter((node) => node.type === "image" || node.type === "imageGroup").length,
      texts: project.nodes.filter((node) => node.type === "text").length,
      modules: project.nodes.filter((node) => node.kind === "workflow" || ["config", "edit", "upscale", "removeBg"].includes(node.type)).length
    }),
    [project.nodes]
  );
  const selectedImageNode = isCanvasImageNode(selectedNode) ? selectedNode : undefined;

  return (
    <main className="canvas-app">
      <TopToolbar
        onBack={onBack}
        onImportImages={onImportImages}
        onWorkflow={onWorkflow}
        onUndo={() => onWorkspaceChange((current) => undoProject(current, project.id))}
        onRedo={() => onWorkspaceChange((current) => redoProject(current, project.id))}
        onCopy={() => onWorkspaceChange((current) => copyPasteSelectedNodes(current, project.id))}
        onDelete={() => onWorkspaceChange((current) => deleteSelectedNodes(current, project.id))}
        onAddTargetFrame={onAddTargetFrame}
        onExport={() => exportProjectPackage(workspace, project)}
        onShapeEdit={onShapeEdit}
        onRemoveBg={onRemoveBg}
      />
      <section className="recraft-canvas">
        <PromptCard
          workspace={workspace}
          selectedNode={selectedNode}
          apiNotice={apiNotice}
          onUpdateConfig={onUpdateConfig}
          onUpdateMetadata={onUpdateMetadata}
          onGenerate={onGenerate}
          onBatch={onBatch}
          onBatchFiles={onBatch}
          onPromptInsert={(prompt) => onUpdateConfig({ prompt })}
        />
        <CanvasStage
          workspace={workspace}
          project={project}
          selectedNode={selectedNode}
          onWorkspaceChange={onWorkspaceChange}
          onConnectModule={onConnectModule}
          onGenerateNode={onGenerateNode}
        />
        <NodeToolbar
          selectedNode={selectedImageNode}
          onUpscale={onUpscale}
          onRemoveBg={onRemoveBg}
          onShapeEdit={onShapeEdit}
          onSaveAsset={onSaveAsset}
          onGroupReferences={onGroupReferences}
          onDownload={() => downloadCanvasNode(selectedImageNode)}
        />
        <RightDock
          workspace={workspace}
          project={project}
          selectedNode={selectedNode}
          panel={rightPanel}
          stats={stats}
          onPanel={onRightPanel}
          onAddModule={onAddModule}
          onAddSettingsNode={onAddSettingsNode}
          onPromptInsert={(prompt) => onUpdateConfig({ prompt })}
          onSavePrompt={onSavePrompt}
          onPromptDelete={onDeletePrompt}
          onAssetInsert={onInsertAsset}
          onAssistantNote={onAssistantNote}
          onRetryBatch={onRetryBatch}
          onCancelBatch={onCancelBatch}
        />
        <ShapeEditDialog
          draft={shapeEditDraft}
          node={shapeEditDraft ? project.nodes.find((node) => node.id === shapeEditDraft.nodeId) : undefined}
          onDraft={onShapeEditDraft}
          onCancel={onCancelShapeEdit}
          onConfirm={onConfirmShapeEdit}
        />
      </section>
    </main>
  );
}

function SideNav({
  workspace,
  active,
  onAdmin,
  onCreateProject,
  onNavigate
}: {
  workspace: Workspace;
  active: string;
  onAdmin?: () => void;
  onCreateProject?: () => void;
  onNavigate?: (section: string) => void;
}) {
  const items = [
    ["Projects", Grid2X2],
    ["Editing templates", Layers3],
    ["Community", Network],
    ["Styles", Image],
    ["Favorites", Heart],
    ["History", History],
    ["Profile", UserRound],
    ["What's new", Sparkles]
  ] as const;
  return (
    <aside className="side-nav">
      <div className="side-top">
        <button type="button" className="icon-button"><Menu size={15} /></button>
        <strong>{active}</strong>
      </div>
      <button type="button" className="black-action" onClick={onCreateProject}><FolderPlus size={14} /> Create new project</button>
      {workspace.profile.role === "admin" && (
        <button type="button" className="admin-action" onClick={onAdmin}>
          <Database size={14} />
          Admin monitoring
        </button>
      )}
      <nav>
        {items.map(([label, Icon]) => {
          const enabled = label === "Projects" || label === "History" || label === "Profile";
          return (
          <button
            type="button"
            key={label}
            className={`${active === label ? "active" : ""} ${enabled ? "" : "disabled"}`}
            onClick={() => enabled && onNavigate?.(label)}
            disabled={!enabled}
          >
            <Icon size={15} />
            {label}
          </button>
          );
        })}
      </nav>
      <div className="credit-chip">
        <span>{workspace.profile.designerName.slice(0, 1)}</span>
        <small>{workspace.profile.designerName} · {workspace.profile.creditBalance} credits</small>
      </div>
      <div className="profile-mini">
        <span>Designer credits</span>
        <strong>{workspace.profile.creditBalance}</strong>
        <small>{workspace.profile.role} account</small>
      </div>
    </aside>
  );
}

function TopToolbar({
  onBack,
  onImportImages,
  onWorkflow,
  onUndo,
  onRedo,
  onCopy,
  onDelete,
  onAddTargetFrame,
  onExport,
  onShapeEdit,
  onRemoveBg
}: {
  onBack: () => void;
  onImportImages: () => void;
  onWorkflow: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onCopy: () => void;
  onDelete: () => void;
  onAddTargetFrame: () => void;
  onExport: () => void;
  onShapeEdit: () => void;
  onRemoveBg: () => void;
}) {
  return (
    <header className="canvas-toolbar">
      <div className="toolbar-left">
        <button type="button" className="icon-button" onClick={onBack} title="Projects"><Menu size={15} /></button>
        <button type="button" className="toolbar-pill">Switch to new UI</button>
        <button type="button" className="toolbar-text">Insert <ChevronDown size={13} /></button>
        <button type="button" className="toolbar-text">Templates <ChevronDown size={13} /></button>
        <button type="button" className="icon-button" title="Select"><MousePointer2 size={15} /></button>
      </div>
      <div className="toolbar-center">
        <button type="button" onClick={onImportImages}><ImagePlus size={14} /> Upload images</button>
        <button type="button" onClick={onAddTargetFrame}><SquareDashedMousePointer size={14} /> Target frame</button>
        <button type="button" onClick={onShapeEdit}><BoxSelect size={14} /> Edit area</button>
        <button type="button" onClick={onRemoveBg}><Scissors size={14} /> Remove bg</button>
        <button type="button"><Shirt size={14} /> Make Mockup</button>
        <button type="button"><Archive size={14} /> Vectorize</button>
        <button type="button" onClick={onWorkflow}><Play size={14} /> Run workflow</button>
        <button type="button" onClick={onExport}><Download size={14} /> Export package</button>
      </div>
      <div className="toolbar-right">
        <button type="button" className="icon-button" onClick={onUndo} title="Undo"><Undo2 size={15} /></button>
        <button type="button" className="icon-button" onClick={onRedo} title="Redo"><RotateCcw size={15} /></button>
        <button type="button" className="icon-button" onClick={onCopy} title="Copy/Paste"><Copy size={15} /></button>
        <button type="button" className="icon-button danger" onClick={onDelete} title="Delete"><Trash2 size={15} /></button>
      </div>
    </header>
  );
}

function ModelPicker({
  label,
  models,
  value,
  onChange,
  operation,
  compact = false
}: {
  label: string;
  models: ModelDefinition[];
  value: string;
  onChange: (modelId: string) => void;
  operation?: OperationType;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const visibleModels = operation ? models.filter((model) => model.capability.includes(operation as ModuleType)) : models;
  const selected = visibleModels.find((model) => model.id === value) ?? models.find((model) => model.id === value) ?? visibleModels[0] ?? models[0];
  const groups = Array.from(new Set(visibleModels.map((model) => model.group)));
  return (
    <div className={`model-picker ${compact ? "compact" : ""}`} onPointerDown={(event) => event.stopPropagation()}>
      <button
        type="button"
        className="model-picker-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`${label} ${selected?.name ?? value}`}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="model-provider-badge">{selected?.provider === "openai" ? "AI" : selected?.provider.slice(0, 1).toUpperCase()}</span>
        <span>
          <small>{label}</small>
          <strong>{selected?.name ?? value}</strong>
        </span>
        <ChevronDown size={14} />
      </button>
      {open && (
        <div className="model-menu" role="listbox" aria-label={`${label} options`}>
          {groups.map((group) => (
            <section key={group} aria-label={group}>
              <small className="model-menu-group">{group}</small>
              {visibleModels.filter((model) => model.group === group).map((model) => (
                <button
                  type="button"
                  key={model.id}
                  role="option"
                  aria-selected={model.id === value}
                  aria-label={`${model.name} ${model.cost} credits ${model.capability.join(" ")}`}
                  className={model.id === value ? "selected" : ""}
                  onClick={() => {
                    onChange(model.id);
                    setOpen(false);
                  }}
                >
                  <span className="model-provider-badge">{model.provider === "openai" ? "AI" : model.provider.slice(0, 1).toUpperCase()}</span>
                  <span>
                    <strong>{model.name}</strong>
                    <small>{model.provider} · {model.capability.join(" / ")}</small>
                  </span>
                  <em>{model.cost} credits</em>
                </button>
              ))}
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

function PromptCard({
  workspace,
  selectedNode,
  apiNotice,
  onUpdateConfig,
  onUpdateMetadata,
  onGenerate,
  onBatch,
  onBatchFiles,
  onPromptInsert
}: {
  workspace: Workspace;
  selectedNode?: CanvasNode;
  apiNotice: string;
  onUpdateConfig: (patch: Partial<CanvasNode["generation"]>) => void;
  onUpdateMetadata: (patch: Record<string, unknown>) => void;
  onGenerate: () => void;
  onBatch: () => void;
  onBatchFiles: (files: FileList | null) => void;
  onPromptInsert: (prompt: string) => void;
}) {
  const batchInputRef = useRef<HTMLInputElement | null>(null);
  const isSettingsNode = selectedNode?.type === "config";
  const selectedBatchConcurrency =
    typeof selectedNode?.metadata.batchConcurrency === "number" ? selectedNode.metadata.batchConcurrency : 1;
  const selectedFailurePolicy: BatchFailurePolicy = selectedNode?.metadata.failurePolicy === "stop" ? "stop" : "continue";
  return (
    <aside className="prompt-card">
      <div className="prompt-title">
        <span>IMAGE</span>
        <small>W {selectedNode?.width ?? 0}</small>
        <small>H {selectedNode?.height ?? 0}</small>
        <small>r {selectedNode?.transform.rotation ?? 0}</small>
      </div>
      <div className="model-row">
        <Sparkles size={18} />
        <ModelPicker
          label="Model"
          models={workspace.modelRegistry}
          value={selectedNode?.generation.modelId ?? "gpt-image-2-medium"}
          operation={selectedNode ? operationForNode(selectedNode) : "generate"}
          onChange={(modelId) => onUpdateConfig({ modelId })}
        />
      </div>
      <label className="model-row">
        <Image size={18} />
        <span>
          <small>Style</small>
          <strong>Not selected</strong>
        </span>
      </label>
      <textarea
        className="prompt-text"
        value={selectedNode?.generation.prompt ?? ""}
        onChange={(event) => onUpdateConfig({ prompt: event.target.value })}
        placeholder="[TARGET] 基于当前参考图做款式变化，只修改需要变化的区域，保持主体比例、背景和棚拍光感。"
      />
      <div className="quick-prompts">
        {workspace.prompts.slice(0, 2).map((prompt) => (
          <button type="button" key={prompt.id} onClick={() => onPromptInsert(prompt.prompt)}>
            {prompt.title}
          </button>
        ))}
      </div>
      <button type="button" className="extract-button"><Search size={13} /> Extract prompt</button>
      <div className="image-count">
        <span className="swatch active" />
        <span className="swatch" />
        <strong>{selectedNode?.generation.outputCount ?? 1} images</strong>
        <input
          aria-label="Output count"
          type="range"
          min={1}
          max={8}
          value={selectedNode?.generation.outputCount ?? 1}
          onChange={(event) => onUpdateConfig({ outputCount: clampOutputCount(Number(event.target.value)) })}
        />
        <input
          aria-label="Output count value"
          className="count-number-input"
          type="number"
          min={1}
          max={8}
          value={selectedNode?.generation.outputCount ?? 1}
          onChange={(event) => onUpdateConfig({ outputCount: clampOutputCount(Number(event.target.value)) })}
        />
      </div>
      <button type="button" className="generate-button" onClick={onGenerate}>Generate</button>
      {isSettingsNode ? (
        <div className="settings-fields" aria-label="Workflow batch settings">
          <label>
            <span>Batch concurrency</span>
            <input
              aria-label="Batch concurrency"
              type="number"
              min={1}
              max={8}
              value={selectedBatchConcurrency}
              onChange={(event) => onUpdateMetadata({ batchConcurrency: clampBatchConcurrency(Number(event.target.value)) })}
            />
          </label>
          <label>
            <span>Batch failure policy</span>
            <select
              aria-label="Batch failure policy"
              value={selectedFailurePolicy}
              onChange={(event) => onUpdateMetadata({ failurePolicy: event.target.value as BatchFailurePolicy })}
            >
              <option value="continue">Continue on failure</option>
              <option value="stop">Stop on failure</option>
            </select>
          </label>
        </div>
      ) : null}
      <small className="api-notice" aria-live="polite">{apiNotice}</small>
      <button type="button" className="secondary-button" onClick={onBatch}>Batch mode</button>
      <button type="button" className="secondary-button" onClick={() => batchInputRef.current?.click()}>
        <Upload size={13} /> Import folder
      </button>
      <input
        ref={batchInputRef}
        className="hidden-file-input"
        aria-label="Batch folder input"
        type="file"
        multiple
        accept="image/*"
        onChange={(event) => onBatchFiles(event.currentTarget.files)}
        {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
      />
    </aside>
  );
}

function CanvasStage({
  workspace,
  project,
  selectedNode,
  onWorkspaceChange,
  onConnectModule,
  onGenerateNode
}: {
  workspace: Workspace;
  project: Project;
  selectedNode?: CanvasNode;
  onWorkspaceChange: (updater: (workspace: Workspace) => Workspace) => void;
  onConnectModule: (moduleType: ModuleType, sourceNodeIds?: string[]) => void;
  onGenerateNode: (nodeId: string) => void;
}) {
  const stageRef = useRef<HTMLElement | null>(null);
  const [lasso, setLasso] = useState<{ x: number; y: number; width: number; height: number } | null>(null);
  const [modulePicker, setModulePicker] = useState<{ nodeId: string; sourceIds: string[]; x: number; y: number } | null>(null);
  const [connectionSource, setConnectionSource] = useState<{ nodeId: string; portId?: string } | null>(null);
  const connectionSourceRef = useRef<{ nodeId: string; portId?: string } | null>(null);
  const selectedIds = project.selectedNodeIds;
  const selectedSet = new Set(selectedIds);
  const connectionSourceNode = connectionSource ? project.nodes.find((node) => node.id === connectionSource.nodeId) : undefined;

  async function importCanvasFiles(files: FileList | File[], clientX?: number, clientY?: number) {
    const imageFiles = Array.from(files).filter((file) => file.type.startsWith("image/"));
    if (!imageFiles.length) return;
    const rect = stageRef.current?.getBoundingClientRect();
    const baseX = rect && typeof clientX === "number" ? (clientX - rect.left - project.viewport.x) / project.viewport.zoom : 640;
    const baseY = rect && typeof clientY === "number" ? (clientY - rect.top - project.viewport.y) / project.viewport.zoom : 360;
    const imported = await Promise.all(
      imageFiles.map(async (file, index) => ({
        asset: {
          name: file.name,
          source: await readFileAsDataUrl(file),
          width: 360,
          height: 520
        },
        x: Math.round(baseX + index * 36),
        y: Math.round(baseY + index * 36)
      }))
    );
    onWorkspaceChange((current) =>
      imported.reduce((workspace, item) => addAssetToProjectAt(workspace, project.id, item.asset, item.x, item.y), current)
    );
  }

  function selectNode(id: string, append: boolean) {
    onWorkspaceChange((current) => selectNodes(current, project.id, [id], append));
  }

  function canReferenceNode(node: CanvasNode) {
    return node.type === "image" || node.type === "imageGroup" || node.type === "batch" || node.kind === "generated" || node.kind === "operation" || node.kind === "edit";
  }

  function openModulePicker(node: CanvasNode) {
    const selectedReferenceIds =
      project.selectedNodeIds.includes(node.id)
        ? project.selectedNodeIds.filter((id) => {
            const selected = project.nodes.find((item) => item.id === id);
            return selected ? canReferenceNode(selected) : false;
          })
        : [];
    const sourceIds = selectedReferenceIds.length > 1 ? selectedReferenceIds : [node.id];
    if (!project.selectedNodeIds.includes(node.id) || sourceIds.length === 1) {
      onWorkspaceChange((current) => selectNodes(current, project.id, sourceIds));
    }
    setModulePicker({ nodeId: node.id, sourceIds, x: node.x + node.width + 38, y: node.y + 8 });
  }

  function startConnectionDrag(node: CanvasNode, portId?: string) {
    const source = { nodeId: node.id, portId };
    connectionSourceRef.current = source;
    setConnectionSource(source);
    setModulePicker(null);
  }

  function finishConnectionDrag(node: CanvasNode, dropTarget?: { nodeId: string; portId: string }) {
    const source = connectionSourceRef.current;
    connectionSourceRef.current = null;
    setConnectionSource(null);
    if (!source) return;
    if (dropTarget) {
      const sourceNode = project.nodes.find((item) => item.id === source.nodeId);
      const targetNode = project.nodes.find((item) => item.id === dropTarget.nodeId);
      if (nodeInputCanAcceptConnection(sourceNode, targetNode, dropTarget.portId, source.portId)) {
        setModulePicker(null);
        onWorkspaceChange((current) =>
          connectWorkflowNode(current, project.id, source.nodeId, dropTarget.nodeId, source.portId, dropTarget.portId)
        );
      }
      return;
    }
    openModulePicker(node);
  }

  function panCanvas(event: PointerEvent<HTMLElement>) {
    if (event.target !== event.currentTarget) return;
    event.preventDefault();
    setModulePicker(null);
    const rect = event.currentTarget.getBoundingClientRect();
    const startX = event.clientX;
    const startY = event.clientY;
    const origin = project.viewport;
    const boxSelect = event.ctrlKey || event.metaKey;
    if (boxSelect) {
      const initial = { x: event.clientX - rect.left, y: event.clientY - rect.top, width: 0, height: 0 };
      setLasso(initial);
      const handleMove = (moveEvent: globalThis.PointerEvent) => {
        setLasso({
          x: Math.min(initial.x, moveEvent.clientX - rect.left),
          y: Math.min(initial.y, moveEvent.clientY - rect.top),
          width: Math.abs(moveEvent.clientX - startX),
          height: Math.abs(moveEvent.clientY - startY)
        });
      };
      const handleUp = () => {
        setLasso((current) => {
          if (current) {
            const selected = project.nodes
              .filter((node) => {
                const x = node.x * project.viewport.zoom + project.viewport.x;
                const y = node.y * project.viewport.zoom + project.viewport.y;
                return x >= current.x && y >= current.y && x <= current.x + current.width && y <= current.y + current.height;
              })
              .map((node) => node.id);
            onWorkspaceChange((workspace) => selectNodes(workspace, project.id, selected));
          }
          return null;
        });
        window.removeEventListener("pointermove", handleMove);
        window.removeEventListener("pointerup", handleUp);
      };
      window.addEventListener("pointermove", handleMove);
      window.addEventListener("pointerup", handleUp);
      return;
    }
    const handleMove = (moveEvent: globalThis.PointerEvent) => {
      onWorkspaceChange((current) =>
        updateViewport(current, project.id, {
          x: origin.x + moveEvent.clientX - startX,
          y: origin.y + moveEvent.clientY - startY
        })
      );
    };
    const handleUp = () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
    };
    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
  }

  function zoomCanvas(event: WheelEvent<HTMLElement>) {
    event.preventDefault();
    const delta = event.deltaY > 0 ? -0.08 : 0.08;
    const zoom = Math.min(2.2, Math.max(0.35, Number((project.viewport.zoom + delta).toFixed(2))));
    onWorkspaceChange((current) => updateViewport(current, project.id, { zoom }));
  }

  return (
    <section
      ref={stageRef}
      className={`stage ${project.viewport.background}`}
      aria-label="Infinite canvas"
      tabIndex={0}
      onPointerDown={panCanvas}
      onWheel={zoomCanvas}
      onDragOver={(event) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
      }}
      onDrop={(event) => {
        event.preventDefault();
        void importCanvasFiles(event.dataTransfer.files, event.clientX, event.clientY);
      }}
      onPaste={(event) => {
        void importCanvasFiles(event.clipboardData.files);
      }}
    >
      {!project.nodes.length && (
        <div className="drop-hint">
          <Upload size={18} />
          <span>Drop images here</span>
        </div>
      )}
      <div className="stage-world" style={{ transform: `translate(${project.viewport.x}px, ${project.viewport.y}px) scale(${project.viewport.zoom})` }}>
        <svg className="stage-wires" viewBox="0 0 2400 1600" aria-hidden="true">
          {project.connections.map((connection) => {
            const from = project.nodes.find((node) => node.id === connection.fromNodeId);
            const to = project.nodes.find((node) => node.id === connection.toNodeId);
            if (!from || !to) return null;
            const active = selectedSet.has(from.id) || selectedSet.has(to.id);
            return (
              <path
                key={connection.id}
                className={active ? "active" : ""}
                d={`M ${from.x + from.width + 10} ${from.y + from.height / 2} C ${from.x + from.width + 180} ${from.y + from.height / 2}, ${to.x - 180} ${to.y + to.height / 2}, ${to.x - 10} ${to.y + to.height / 2}`}
              />
            );
          })}
        </svg>
        {project.nodes.map((node) => (
          <CanvasNodeView
            key={node.id}
            projectId={project.id}
            node={node}
            selected={selectedSet.has(node.id)}
            highlighted={Boolean(selectedNode && project.connections.some((item) => (item.fromNodeId === selectedNode.id && item.toNodeId === node.id) || (item.toNodeId === selectedNode.id && item.fromNodeId === node.id)))}
            connectionState={
              connectionSource
                ? connectionSource.nodeId === node.id
                  ? "source"
                  : nodeCanAcceptConnection(connectionSourceNode, node, connectionSource.portId)
                    ? "compatible"
                    : "incompatible"
                : undefined
            }
            connectionSourceNode={connectionSourceNode}
            connectionSourcePortId={connectionSource?.portId}
            onSelect={selectNode}
            onWorkspaceChange={onWorkspaceChange}
            onStartConnectionDrag={startConnectionDrag}
            onFinishConnectionDrag={finishConnectionDrag}
            onGenerateNode={onGenerateNode}
            workspace={workspace}
          />
        ))}
      </div>
      {modulePicker && (
        <WorkflowModulePicker
          x={modulePicker.x * project.viewport.zoom + project.viewport.x}
          y={modulePicker.y * project.viewport.zoom + project.viewport.y}
          referenceCount={modulePicker.sourceIds.length}
          sourceNodes={modulePicker.sourceIds.flatMap((id) => project.nodes.find((node) => node.id === id) ?? [])}
          onPick={(moduleType) => {
            onConnectModule(moduleType, modulePicker.sourceIds);
            setModulePicker(null);
          }}
          onCancel={() => setModulePicker(null)}
        />
      )}
      {lasso && <div className="lasso" style={lasso} />}
      <ZoomControls workspace={workspace} project={project} onWorkspaceChange={onWorkspaceChange} />
      {project.viewport.minimapOpen && <MiniMap project={project} />}
    </section>
  );
}

function WorkflowModulePicker({
  x,
  y,
  referenceCount,
  sourceNodes,
  onPick,
  onCancel
}: {
  x: number;
  y: number;
  referenceCount: number;
  sourceNodes: CanvasNode[];
  onPick: (moduleType: ModuleType) => void;
  onCancel: () => void;
}) {
  const options = WORKFLOW_MODULE_REGISTRY.map((option) => ({
    ...option,
    inputLabels: moduleInputLabelsForSources(option.moduleType, sourceNodes)
  })).filter((option) => option.inputLabels.length);

  return (
    <div className="workflow-picker" style={{ left: x, top: y }} onPointerDown={(event) => event.stopPropagation()}>
      <strong>Choose module</strong>
      <small>{referenceCount} reference{referenceCount > 1 ? "s" : ""} selected</small>
      {options.map((option) => (
        <button type="button" key={option.moduleType} onClick={() => onPick(option.moduleType)}>
          <b>{option.label}</b>
          <span>{option.detail}</span>
          <em>to {option.inputLabels.join(", ")}</em>
        </button>
      ))}
      <button type="button" className="workflow-picker-cancel" onClick={onCancel}>Cancel</button>
    </div>
  );
}

function CanvasNodeView({
  projectId,
  node,
  selected,
  highlighted,
  connectionState,
  connectionSourceNode,
  connectionSourcePortId,
  onSelect,
  onWorkspaceChange,
  onStartConnectionDrag,
  onFinishConnectionDrag,
  onGenerateNode,
  workspace
}: {
  projectId: string;
  node: CanvasNode;
  selected: boolean;
  highlighted: boolean;
  connectionState?: "source" | "compatible" | "incompatible";
  connectionSourceNode?: CanvasNode;
  connectionSourcePortId?: string;
  onSelect: (id: string, append: boolean) => void;
  onWorkspaceChange: (updater: (workspace: Workspace) => Workspace) => void;
  onStartConnectionDrag: (node: CanvasNode, portId?: string) => void;
  onFinishConnectionDrag: (node: CanvasNode, dropTarget?: { nodeId: string; portId: string }) => void;
  onGenerateNode: (nodeId: string) => void;
  workspace: Workspace;
}) {
  const isWorkflowNode = node.kind === "workflow";
  const isImageLike =
    !isWorkflowNode &&
    (node.type === "image" ||
      node.type === "batch" ||
      node.type === "imageGroup" ||
      node.kind === "generated" ||
      node.kind === "operation" ||
      node.kind === "edit");
  const isText = node.type === "text";
  const isModule = isWorkflowNode || (!isImageLike && !isText);
  const nodeHistoryId = typeof node.metadata.historyId === "string" ? node.metadata.historyId : "";
  const nodeCreditCost = typeof node.metadata.creditCost === "number" ? node.metadata.creditCost : undefined;
  const nodeTaskLabel = nodeHistoryId
    ? `${nodeHistoryId}${nodeCreditCost !== undefined ? ` · ${nodeCreditCost} credits` : ""}`
    : "";
  const [inlineEditorOpen, setInlineEditorOpen] = useState(false);

  function startPointer(event: PointerEvent<HTMLDivElement>, mode: DragMode = "move") {
    if ((event.target as HTMLElement).closest(".node-port, .inline-node-editor")) return;
    event.preventDefault();
    event.stopPropagation();
    onSelect(node.id, event.shiftKey || event.ctrlKey || event.metaKey);
    const startX = event.clientX;
    const startY = event.clientY;
    const origin = node.transform;
    const handleMove = (moveEvent: globalThis.PointerEvent) => {
      if (mode === "resize") {
        const width = Math.max(120, origin.width + moveEvent.clientX - startX);
        const ratio = origin.height / origin.width || 1;
        const height = origin.lockedRatio ? width * ratio : Math.max(80, origin.height + moveEvent.clientY - startY);
        patchTransform({ width: Math.round(width), height: Math.round(height) });
      } else {
        patchTransform({ x: Math.round(origin.x + moveEvent.clientX - startX), y: Math.round(origin.y + moveEvent.clientY - startY) });
      }
    };
    const handleUp = () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
    };
    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
  }

  function patchTransform(patch: Partial<NodeTransform>) {
    onWorkspaceChange((current) => updateNodeTransform(current, projectId, node.id, patch));
  }

  function startWire(event: PointerEvent<HTMLSpanElement>, portId?: string) {
    event.stopPropagation();
    event.preventDefault();
    onStartConnectionDrag(node, portId);
    const handleUp = (upEvent: globalThis.PointerEvent) => {
      const target = inputPortElementFromPointer(upEvent);
      onFinishConnectionDrag(
        node,
        target?.dataset.nodeId && target.dataset.portId
          ? { nodeId: target.dataset.nodeId, portId: target.dataset.portId }
          : undefined
      );
      window.removeEventListener("pointerup", handleUp);
    };
    window.addEventListener("pointerup", handleUp);
  }

  return (
    <div
      role="button"
      aria-label={`${isImageLike ? "Image" : isText ? "Text" : "Workflow"} ${node.name}`}
      data-testid="canvas-node"
      tabIndex={0}
      className={`stage-node ${node.type} ${node.status} ${selected ? "selected" : ""} ${highlighted ? "highlighted" : ""} ${connectionState ? `connection-${connectionState}` : ""}`}
      style={{ left: node.x, top: node.y, width: node.width, minHeight: node.height }}
      onPointerDown={(event) => startPointer(event)}
      onDoubleClick={(event) => {
        event.stopPropagation();
        onSelect(node.id, false);
        if (isImageLike) setInlineEditorOpen((current) => !current);
      }}
    >
      <span className="node-label">{isImageLike ? "Image" : isText ? "Text" : node.moduleType ?? node.type}</span>
      {isModule && node.status === "idle" && <span className="node-status ready">Ready</span>}
      {node.status === "running" && <span className="node-status running">Running</span>}
      {node.status === "done" && <span className="node-status done">Done</span>}
      {node.status === "error" && <span className="node-status error">Error</span>}
      {isImageLike && node.type !== "imageGroup" && (
        <>
          <img src={node.source} alt={node.name} style={{ width: node.width, height: node.height }} />
          <strong className="stage-node-name">{node.name}</strong>
          {nodeTaskLabel && <small className="node-task-trace">{nodeTaskLabel}</small>}
          {node.status === "error" && <small className="node-error-message">{node.errorMessage}</small>}
          <div className="thumb-strip">
            <span>ORIGINAL</span>
            <img src={node.source} alt="" />
            <img src={node.source} alt="" />
          </div>
        </>
      )}
      {node.type === "imageGroup" && (
        <div className="reference-group-node">
          <Grid2X2 size={22} />
          <strong>{node.name}</strong>
          <small>{node.references.length} linked reference images</small>
        </div>
      )}
      {isText && (
        <div className="text-node">
          <MessageSquareText size={18} />
          <p>{String(node.metadata.content ?? node.source)}</p>
        </div>
      )}
      {isModule && (
        <div className="workflow-box">
          <Network size={20} />
          <strong>{node.metadata.targetFrame ? node.name : node.moduleType ?? node.type}</strong>
          <small>{node.generation.modelId}</small>
          {nodeTaskLabel && <small className="node-task-trace">{nodeTaskLabel}</small>}
          <span>{node.references.length} refs</span>
          {node.status === "error" && <em>{node.errorMessage}</em>}
        </div>
      )}
      {selected && <SelectionHandles width={node.width} height={node.height} />}
      {selected && (
        <span
          className="resize-handle"
          style={{ left: node.width - 18, top: Math.max(28, node.height - 18) }}
          onPointerDown={(event) => startPointer(event as PointerEvent<HTMLDivElement>, "resize")}
          aria-label="Resize image"
        />
      )}
      {selected && inlineEditorOpen && isImageLike && (
        <InlineNodeEditor
          node={node}
          models={workspace.modelRegistry}
          onUpdate={(patch) =>
            onWorkspaceChange((current) =>
              configureNodeGeneration(current, projectId, node.id, {
                ...node.generation,
                ...patch,
                entryPoint: "inline"
              })
            )
          }
          onGenerate={() => onGenerateNode(node.id)}
        />
      )}
      {node.inputs.map((port, index) => (
        <span
          key={port.id}
          className={`node-port input ${portConnectionClass(connectionSourceNode, node, port, connectionSourcePortId)}`}
          style={{ top: portPosition(index, node.inputs.length) }}
          aria-label={`${port.label} input port on ${node.name}`}
          data-node-input-port="true"
          data-node-id={node.id}
          data-port-id={port.id}
          title={`${port.label} input`}
        />
      ))}
      {node.outputs.map((port, index) => (
        <span
          key={port.id}
          className={`node-port output ${connectionState === "source" && (!connectionSourcePortId || connectionSourcePortId === port.id) ? "port-source" : ""}`}
          style={{ top: portPosition(index, node.outputs.length) }}
          data-testid={index === 0 ? `workflow-output-port-${node.id}` : undefined}
          aria-label={index === 0 ? `Create workflow from ${node.name}` : `${port.label} output port on ${node.name}`}
          onPointerDown={(event) => startWire(event, port.id)}
          title={`${port.label} output`}
        />
      ))}
    </div>
  );
}

function InlineNodeEditor({
  node,
  models,
  onUpdate,
  onGenerate
}: {
  node: CanvasNode;
  models: Workspace["modelRegistry"];
  onUpdate: (patch: Partial<CanvasNode["generation"]>) => void;
  onGenerate: () => void;
}) {
  return (
    <div className="inline-node-editor" onPointerDown={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()}>
      <ModelPicker
        label="Inline model"
        models={models}
        value={node.generation.modelId}
        operation={operationForNode(node)}
        onChange={(modelId) => onUpdate({ modelId })}
        compact
      />
      <textarea
        aria-label="Inline prompt"
        value={node.generation.prompt}
        onChange={(event) => onUpdate({ prompt: event.target.value })}
        placeholder="在图片下方直接输入提示词，例如：参考这张服装做一款新的刺绣马甲。"
      />
      <div className="inline-node-actions">
        <label>
          <span>Count</span>
          <input
            aria-label="Inline output count"
            type="number"
            min={1}
            max={4}
            value={node.generation.outputCount}
            onChange={(event) => onUpdate({ outputCount: Number(event.target.value) })}
          />
        </label>
        <button type="button" onClick={onGenerate} disabled={!node.generation.prompt.trim()}>
          Generate
        </button>
      </div>
    </div>
  );
}

function SelectionHandles({ width, height }: { width: number; height: number }) {
  return (
    <>
      <i className="handle tl" />
      <i className="handle tr" style={{ left: width - 4 }} />
      <i className="handle bl" style={{ top: height + 18 }} />
      <i className="handle br" style={{ left: width - 4, top: height + 18 }} />
    </>
  );
}

function ZoomControls({
  workspace,
  project,
  onWorkspaceChange
}: {
  workspace: Workspace;
  project: Project;
  onWorkspaceChange: (updater: (workspace: Workspace) => Workspace) => void;
}) {
  const setZoom = (zoom: number) => onWorkspaceChange((current) => updateViewport(current, project.id, { zoom }));
  return (
    <div className="zoom-controls">
      <button type="button" title="Zoom out" onClick={() => setZoom(Math.max(0.35, project.viewport.zoom - 0.1))}><ZoomOut size={14} /></button>
      <input
        aria-label="Canvas zoom"
        type="range"
        min={35}
        max={220}
        value={Math.round(project.viewport.zoom * 100)}
        onChange={(event) => setZoom(Number(event.target.value) / 100)}
      />
      <button type="button" title="Zoom in" onClick={() => setZoom(Math.min(2.2, project.viewport.zoom + 0.1))}><ZoomIn size={14} /></button>
      <button type="button" title="Reset view" onClick={() => onWorkspaceChange(() => updateViewport(workspace, project.id, { x: 0, y: 0, zoom: 1 }))}><RotateCcw size={14} /></button>
      <span>{Math.round(project.viewport.zoom * 100)}%</span>
    </div>
  );
}

function MiniMap({ project }: { project: Project }) {
  return (
    <div className="mini-map" aria-label="Canvas minimap">
      {project.nodes.map((node) => (
        <span
          key={node.id}
          className={project.selectedNodeIds.includes(node.id) ? "active" : ""}
          style={{ left: `${node.x / 24}px`, top: `${node.y / 18}px`, width: `${Math.max(8, node.width / 30)}px`, height: `${Math.max(6, node.height / 40)}px` }}
        />
      ))}
    </div>
  );
}

function NodeToolbar({
  selectedNode,
  onUpscale,
  onRemoveBg,
  onShapeEdit,
  onSaveAsset,
  onGroupReferences,
  onDownload
}: {
  selectedNode?: CanvasNode;
  onUpscale: () => void;
  onRemoveBg: () => void;
  onShapeEdit: () => void;
  onSaveAsset: () => void;
  onGroupReferences: () => void;
  onDownload: () => void;
}) {
  if (!selectedNode) return null;
  return (
    <div className="node-toolbar" aria-label="selected image toolbar">
      <button type="button" title="Upscale" onClick={onUpscale}><Maximize2 size={15} /></button>
      <button type="button" title="Remove background" onClick={onRemoveBg}><Scissors size={15} /></button>
      <button type="button" title="Mask edit" onClick={onShapeEdit}><CircleDashed size={15} /></button>
      <button type="button" title="Group references" onClick={onGroupReferences}><SquareDashedMousePointer size={15} /></button>
      <button type="button" title="Save asset" onClick={onSaveAsset}><Database size={15} /></button>
      <button type="button" title="Download" onClick={onDownload}><Download size={15} /></button>
      <button type="button" title="Magic edit" onClick={onShapeEdit}><Wand2 size={15} /></button>
    </div>
  );
}

function ShapeEditDialog({
  draft,
  node,
  onDraft,
  onCancel,
  onConfirm
}: {
  draft: ShapeEditDraft;
  node?: CanvasNode;
  onDraft: (draft: ShapeEditDraft) => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  if (!draft || !node) return null;
  const shapes: Array<NonNullable<ShapeEditDraft>["shape"]> = ["ellipse", "rectangle", "freehand"];
  const mask = draft.mask ?? DEFAULT_MASK_SELECTION;
  const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
  const updateMaskCenter = (event: PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const centerX = ((event.clientX - rect.left) / rect.width) * 100;
    const centerY = ((event.clientY - rect.top) / rect.height) * 100;
    const nextMask = {
      ...mask,
      x: Math.round(clamp(centerX - mask.width / 2, 0, 100 - mask.width)),
      y: Math.round(clamp(centerY - mask.height / 2, 0, 100 - mask.height))
    };
    onDraft({ ...draft, mask: nextMask });
  };
  const updateMaskSize = (size: number) => {
    const width = clamp(size, 18, 78);
    const height = clamp(Math.round(size * 0.86), 16, 70);
    const centerX = mask.x + mask.width / 2;
    const centerY = mask.y + mask.height / 2;
    onDraft({
      ...draft,
      mask: {
        x: Math.round(clamp(centerX - width / 2, 0, 100 - width)),
        y: Math.round(clamp(centerY - height / 2, 0, 100 - height)),
        width,
        height
      }
    });
  };
  return (
    <div className="shape-dialog" role="dialog" aria-label="Mask edit confirmation">
      <div
        className="shape-preview"
        role="application"
        aria-label="Mask placement preview"
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
          updateMaskCenter(event);
        }}
        onPointerMove={(event) => {
          if (event.buttons === 1) updateMaskCenter(event);
        }}
      >
        <img src={node.source} alt={node.name} />
        <span
          className={`shape-overlay ${draft.shape}`}
          style={{
            left: `${mask.x}%`,
            top: `${mask.y}%`,
            width: `${mask.width}%`,
            height: `${mask.height}%`
          }}
        />
      </div>
      <div className="shape-panel">
        <strong>Confirm mask edit</strong>
        <small>Click or drag on the preview to position the edit mask.</small>
        <div className="shape-options" aria-label="Mask shape">
          {shapes.map((shape) => (
            <button
              type="button"
              key={shape}
              className={draft.shape === shape ? "active" : ""}
              onClick={() => onDraft({ ...draft, shape })}
            >
              {shape}
            </button>
          ))}
        </div>
        <label className="mask-size-control">
          <span>Mask size</span>
          <input
            aria-label="Mask size"
            type="range"
            min={18}
            max={78}
            value={mask.width}
            onChange={(event) => updateMaskSize(Number(event.target.value))}
          />
        </label>
        <output className="mask-coordinates" aria-label="Mask coordinates">
          x {mask.x} · y {mask.y} · w {mask.width} · h {mask.height}
        </output>
        <textarea
          aria-label="Mask edit prompt"
          value={draft.prompt}
          onChange={(event) => onDraft({ ...draft, prompt: event.target.value })}
        />
        <div className="shape-actions">
          <button type="button" className="secondary-button" onClick={onCancel}>Cancel</button>
          <button type="button" className="generate-button" onClick={onConfirm} disabled={!draft.prompt.trim()}>
            Confirm edit
          </button>
        </div>
      </div>
    </div>
  );
}

function RightDock({
  workspace,
  project,
  selectedNode,
  panel,
  stats,
  onPanel,
  onAddModule,
  onAddSettingsNode,
  onPromptInsert,
  onSavePrompt,
  onPromptDelete,
  onAssetInsert,
  onAssistantNote,
  onRetryBatch,
  onCancelBatch
}: {
  workspace: Workspace;
  project: Project;
  selectedNode?: CanvasNode;
  panel: RightPanel;
  stats: { images: number; texts: number; modules: number };
  onPanel: (panel: RightPanel) => void;
  onAddModule: (moduleType: ModuleType) => void;
  onAddSettingsNode: () => void;
  onPromptInsert: (prompt: string) => void;
  onSavePrompt: () => void;
  onPromptDelete: (promptId: string) => void;
  onAssetInsert: (asset: LibraryAsset) => void;
  onAssistantNote: (content: string) => void;
  onRetryBatch: () => void;
  onCancelBatch: () => void;
}) {
  const [promptSearch, setPromptSearch] = useState("");
  const normalizedPromptSearch = promptSearch.trim().toLowerCase();
  const filteredPrompts = normalizedPromptSearch
    ? workspace.prompts.filter((prompt) => {
        const haystack = `${prompt.title} ${prompt.prompt} ${prompt.tags.join(" ")}`.toLowerCase();
        return haystack.includes(normalizedPromptSearch);
      })
    : workspace.prompts;
  const workflowPlan = useMemo(
    () => (selectedNode ? buildWorkflowExecutionPlan(workspace, project.id, selectedNode.id) : undefined),
    [workspace, project.id, selectedNode?.id]
  );
  const selectedHistoryId = typeof selectedNode?.metadata.historyId === "string" ? selectedNode.metadata.historyId : undefined;
  const selectedHistory = selectedHistoryId ? workspace.history.find((entry) => entry.id === selectedHistoryId) : undefined;
  const selectedOperation =
    selectedHistory?.operation ??
    (typeof selectedNode?.metadata.operation === "string" ? selectedNode.metadata.operation : selectedNode?.operation);
  const selectedCreditCost =
    selectedHistory?.creditCost ?? (typeof selectedNode?.metadata.creditCost === "number" ? selectedNode.metadata.creditCost : undefined);
  const selectedOutputCount = selectedHistory?.outputCount ?? selectedNode?.generation.outputCount ?? 1;
  const selectedPrompt =
    selectedHistory?.prompt ??
    (typeof selectedNode?.metadata.prompt === "string" ? selectedNode.metadata.prompt : selectedNode?.generation.prompt);
  const selectedModelId =
    selectedHistory?.modelId ??
    (typeof selectedNode?.metadata.modelId === "string" ? selectedNode.metadata.modelId : selectedNode?.generation.modelId);
  const selectedBatchConcurrency =
    typeof selectedNode?.metadata.batchConcurrency === "number" ? selectedNode.metadata.batchConcurrency : undefined;
  const selectedFailurePolicy =
    selectedNode?.metadata.failurePolicy === "stop" ? "stop" : selectedNode?.metadata.failurePolicy === "continue" ? "continue" : undefined;
  const batchSummary = summarizeBatchQueue(project.batchQueue);
  const hasRetryableBatchItems = project.batchQueue.some((item) => item.status === "error" || item.status === "cancelled");
  const hasCancellableBatchItems = project.batchQueue.some((item) => item.status === "queued" || item.status === "processing");
  const assistantCards = [
    {
      title: "Two-reference concept",
      prompt: "Use the selected references as a combined design context. Keep the silhouette readable, borrow the strongest material/detail cues, and generate a new fashion item for the same collection."
    },
    {
      title: "Edit then upscale chain",
      prompt: "First make a controlled local edit while preserving pose, lighting, and background. Then upscale the approved result with clean garment edges and visible textile texture."
    },
    {
      title: "Batch cleanup brief",
      prompt: "Apply one consistent cleanup direction to every imported image: remove background distractions, keep garment proportions unchanged, preserve fabric texture, and return production-ready cutouts."
    }
  ];

  return (
    <aside className="context-dock">
      <div className="dock-tabs">
        <button type="button" aria-label="Context" className={panel === "context" ? "active" : ""} onClick={() => onPanel("context")} title="Context"><PanelRight size={15} /></button>
        <button type="button" aria-label="History" className={panel === "history" ? "active" : ""} onClick={() => onPanel("history")} title="History"><Clock3 size={15} /></button>
        <button type="button" aria-label="Assets" className={panel === "assets" ? "active" : ""} onClick={() => onPanel("assets")} title="Assets"><Database size={15} /></button>
        <button type="button" aria-label="Prompts" className={panel === "prompts" ? "active" : ""} onClick={() => onPanel("prompts")} title="Prompts"><BookOpenText size={15} /></button>
        <button type="button" aria-label="Assistant" className={panel === "assistant" ? "active" : ""} onClick={() => onPanel("assistant")} title="Assistant"><Sparkles size={15} /></button>
      </div>
      {panel === "context" && (
        <>
          <strong>Context panel</strong>
          <span>{stats.images} images</span>
          <span>{stats.texts} text nodes</span>
          <span>{stats.modules} modules</span>
          <div className="dock-actions">
            {WORKFLOW_MODULE_REGISTRY.map((definition) => {
              const Icon = workflowModuleIcons[definition.moduleType];
              return (
                <button type="button" key={definition.moduleType} onClick={() => onAddModule(definition.moduleType)}>
                  <Icon size={13} /> {definition.label} node
                </button>
              );
            })}
            <button type="button" onClick={onAddSettingsNode}>
              <SlidersHorizontal size={13} /> Settings node
            </button>
          </div>
          {selectedNode && (
            <section className="node-task-card" aria-label="Selected node task">
              <strong>Selected node task</strong>
              {selectedHistoryId ? <span>{selectedHistoryId}</span> : <small>No linked history yet</small>}
              {selectedOperation && selectedModelId ? <span>{selectedOperation} / {selectedModelId}</span> : null}
              {selectedCreditCost !== undefined ? (
                <span>{selectedCreditCost} credits · {selectedOutputCount} output{selectedOutputCount === 1 ? "" : "s"}</span>
              ) : null}
              {selectedBatchConcurrency || selectedFailurePolicy ? (
                <span>
                  Batch: {selectedBatchConcurrency ?? 1} concurrent / {selectedFailurePolicy === "stop" ? "stop on failure" : "continue on failure"}
                </span>
              ) : null}
              {selectedNode.inputs.length ? <span>Inputs: {selectedNode.inputs.map((port) => port.label).join(", ")}</span> : null}
              {selectedNode.outputs.length ? <span>Outputs: {selectedNode.outputs.map((port) => port.label).join(", ")}</span> : null}
              {selectedPrompt?.trim() ? <p>{selectedPrompt}</p> : null}
            </section>
          )}
          {workflowPlan && (
            <div className={`workflow-plan ${workflowPlan.status}`} aria-label="Workflow execution plan">
              <div className="workflow-plan-header">
                <strong>Workflow plan</strong>
                <small>{workflowPlan.status}</small>
              </div>
              <span>{workflowPlan.steps.length} executable steps</span>
              <span>Estimated {workflowPlan.totalEstimatedCredits} credits</span>
              {workflowPlan.steps.length ? (
                workflowPlan.steps.map((step, index) => (
                  <article className="workflow-plan-step" key={step.nodeId}>
                    <b>{index + 1}. {step.name}</b>
                    <small>
                      {step.operation} / {step.modelId} / {step.referenceCount} refs
                    </small>
                  </article>
                ))
              ) : (
                <small>No downstream workflow modules</small>
              )}
              {workflowPlan.issues.map((issue, index) => (
                <small className={`workflow-plan-issue ${issue.severity}`} key={`${issue.nodeId ?? "plan"}-${issue.message}-${index}`}>
                  {issue.severity}: {issue.message}
                </small>
              ))}
            </div>
          )}
          <small>Workflow modules</small>
        </>
      )}
      {panel === "history" && (
        <div className="dock-list">
          <strong>History</strong>
          {project.batchQueue.length ? (
            <section className="batch-queue-log" aria-label="Batch queue">
              <b>Batch queue</b>
              <p>
                Batch progress {batchSummary.succeeded}/{batchSummary.total} succeeded · {batchSummary.failed} failed · {batchSummary.percent}% complete
              </p>
              <div className="dock-actions compact">
                <button type="button" aria-label="Retry failed batch items" onClick={onRetryBatch} disabled={!hasRetryableBatchItems}>
                  Retry failed
                </button>
                <button type="button" aria-label="Cancel remaining batch items" onClick={onCancelBatch} disabled={!hasCancellableBatchItems}>
                  Cancel remaining
                </button>
              </div>
              {project.batchQueue.map((item) => (
                <article key={item.id} className={`batch-queue-item ${item.status}`}>
                  <span>{item.name}</span>
                  <em>{item.status}</em>
                  {item.attempts ? <small>attempt {item.attempts}</small> : null}
                  {item.errorMessage ? <small>{item.errorMessage}</small> : null}
                </article>
              ))}
            </section>
          ) : null}
          {workspace.history.length ? workspace.history.map((item) => (
            <article key={item.id}>
              <b>{item.modelId}</b>
              <span>{item.creditCost} credits · {item.outputCount} output</span>
              <p>{item.prompt}</p>
            </article>
          )) : <small>No generation history yet</small>}
        </div>
      )}
      {panel === "assets" && (
        <div className="dock-list">
          <strong>My assets</strong>
          {workspace.assets.length ? workspace.assets.map((asset) => (
            <button type="button" key={asset.id} onClick={() => onAssetInsert(asset)}>
              <b>{asset.title}</b>
              <span>{asset.type} · Use in canvas</span>
            </button>
          )) : <small>Save a selected node to collect it here</small>}
        </div>
      )}
      {panel === "prompts" && (
        <div className="dock-list">
          <strong>Prompt library</strong>
          <div className="prompt-library-tools">
            <label>
              <Search size={13} />
              <input
                aria-label="Search prompts"
                value={promptSearch}
                onChange={(event) => setPromptSearch(event.target.value)}
                placeholder="Search prompt library"
              />
            </label>
            <button type="button" onClick={onSavePrompt} disabled={!selectedNode?.generation.prompt.trim()}>
              Save current prompt
            </button>
          </div>
          {filteredPrompts.length ? filteredPrompts.map((prompt) => (
            <article className="prompt-preset-row" key={prompt.id}>
              <button type="button" className="prompt-preset-main" onClick={() => onPromptInsert(prompt.prompt)}>
                <b>{prompt.title}</b>
                <span>{prompt.tags.join(", ")}</span>
                {prompt.designerName ? <span>Saved by {prompt.designerName}</span> : null}
                <small>{prompt.prompt}</small>
              </button>
              {prompt.source === "designer" && (
                <button type="button" className="prompt-delete" aria-label={`Delete prompt ${prompt.title}`} onClick={() => onPromptDelete(prompt.id)}>
                  <Trash2 size={13} />
                </button>
              )}
            </article>
          )) : <small>No prompts match this search</small>}
        </div>
      )}
      {panel === "assistant" && (
        <div className="dock-list">
          <strong>Assistant</strong>
          <small>{project.name} · {stats.images} references · {stats.modules} modules</small>
          {assistantCards.map((card) => (
            <article key={card.title}>
              <b>{card.title}</b>
              <p>{card.prompt}</p>
              <div className="dock-actions compact">
                <button type="button" onClick={() => onPromptInsert(card.prompt)}>Use as prompt</button>
                <button type="button" onClick={() => onAssistantNote(card.prompt)}>Add note node</button>
              </div>
            </article>
          ))}
        </div>
      )}
      <div className="dock-footer">
        <BadgeDollarSign size={14} />
        <span>{workspace.profile.creditBalance} credits left</span>
        <small>{project.name}</small>
      </div>
    </aside>
  );
}
