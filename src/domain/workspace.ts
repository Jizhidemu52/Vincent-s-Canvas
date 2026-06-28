export type NodeType =
  | "image"
  | "text"
  | "imageGroup"
  | "config"
  | "edit"
  | "upscale"
  | "removeBg"
  | "batch"
  | "assistant";

export type NodeKind = "upload" | "generated" | "operation" | "edit" | "workflow" | "referenceGroup";
export type NodeStatus = "idle" | "selected" | "running" | "done" | "error";
export type OperationType = "generate" | "edit" | "upscale" | "removeBackground" | "crop" | "duplicate" | "download";
export type ModuleType = "upload" | "edit" | "upscale" | "removeBackground" | "generate" | "batch";
export type PortType = "image" | "text" | "config" | "result";
export type GenerationApiPath = "/api/generations" | "/api/edits" | "/api/upscale" | "/api/remove-bg";

export interface Profile {
  userId: string;
  designerName: string;
  role: "designer" | "admin";
  creditBalance: number;
  creditUsed: number;
  credits: number;
  creditLimit?: number;
}

export interface NodePort {
  id: string;
  type: PortType;
  label: string;
}

export interface NodeTransform {
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  scaleX: number;
  scaleY: number;
  lockedRatio: boolean;
}

export interface GenerationConfig {
  prompt: string;
  modelId: string;
  outputCount: number;
  entryPoint: "inspector" | "inline" | "workflow";
  size?: string;
  quality?: string;
}

export interface MaskSelection {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CanvasNode {
  id: string;
  type: NodeType;
  kind: NodeKind;
  name: string;
  source: string;
  x: number;
  y: number;
  width: number;
  height: number;
  inputs: NodePort[];
  outputs: NodePort[];
  status: NodeStatus;
  metadata: Record<string, unknown>;
  references: string[];
  referenceIds?: string[];
  transform: NodeTransform;
  generation: GenerationConfig;
  parentId?: string;
  operation?: OperationType;
  editShape?: "ellipse" | "rectangle" | "freehand";
  moduleType?: ModuleType;
  errorMessage?: string;
}

export interface Connection {
  id: string;
  fromNodeId: string;
  fromPort: string;
  toNodeId: string;
  toPort: string;
  from: string;
  to: string;
}

export interface Viewport {
  x: number;
  y: number;
  zoom: number;
  background: "blank" | "dots" | "grid";
  minimapOpen: boolean;
}

export interface BatchItem {
  id: string;
  name: string;
  source: string;
  width: number;
  height: number;
  status: "queued" | "processing" | "done" | "error" | "cancelled";
  attempts?: number;
  maxAttempts?: number;
  errorMessage?: string;
}

export interface BatchQueue {
  folderName: string;
  prompt: string;
  modelId: string;
  outputCount: number;
  items: BatchItem[];
}

export interface AssetInput {
  name: string;
  source: string;
  width: number;
  height: number;
}

export interface BatchImport {
  folderName: string;
  prompt: string;
  modelId: string;
  outputCount: number;
  files: AssetInput[];
}

export interface GenerationRequest {
  projectId: string;
  nodeId: string;
  modelId: string;
  prompt: string;
  referenceNodeIds: string[];
  outputCount: number;
  operation: OperationType;
  mask?: MaskSelection;
}

export interface GenerationResult {
  status: "queued" | "running" | "succeeded" | "failed";
  outputs: AssetInput[];
  creditCost: number;
  historyId: string;
  errorMessage?: string;
}

export interface BatchGenerationOutcome {
  result?: GenerationResult;
  errorMessage?: string;
}

export interface HistoryEntry {
  id: string;
  projectId: string;
  projectName?: string;
  nodeId: string;
  prompt: string;
  modelId: string;
  outputCount: number;
  creditCost: number;
  priceCents?: number;
  currency?: ModelDefinition["currency"];
  userId?: string;
  designerName?: string;
  operation?: OperationType;
  moduleType?: ModuleType;
  referenceCount?: number;
  outputs?: AssetInput[];
  createdAt: string;
}

export interface WorkflowPlanIssue {
  nodeId?: string;
  severity: "warning" | "error";
  message: string;
}

export interface WorkflowPlanStep {
  nodeId: string;
  name: string;
  moduleType?: ModuleType;
  operation: OperationType;
  modelId: string;
  prompt: string;
  outputCount: number;
  referenceNodeIds: string[];
  referenceCount: number;
  estimatedCreditCost: number;
}

export interface WorkflowExecutionPlan {
  status: "ready" | "blocked" | "empty";
  startNodeId: string;
  steps: WorkflowPlanStep[];
  issues: WorkflowPlanIssue[];
  totalEstimatedCredits: number;
}

export interface LibraryAsset {
  id: string;
  type: "image" | "text";
  title: string;
  source: string;
  tags: string[];
  createdAt: string;
  metadata?: Record<string, unknown>;
}

export interface PromptPreset {
  id: string;
  title: string;
  prompt: string;
  tags: string[];
  source: "internal" | "designer" | "remote";
  userId?: string;
  designerName?: string;
  createdAt?: string;
}

interface ProjectSnapshot {
  nodes: CanvasNode[];
  connections: Connection[];
  viewport: Viewport;
  selectedNodeIds: string[];
}

export interface Project {
  id: string;
  name: string;
  nodes: CanvasNode[];
  connections: Connection[];
  selectedNodeIds: string[];
  viewport: Viewport;
  batchQueue: BatchItem[];
  batchConfig?: Omit<BatchQueue, "items">;
  undoStack: ProjectSnapshot[];
  redoStack: ProjectSnapshot[];
  updatedAt: string;
}

export interface ModelDefinition {
  id: string;
  name: string;
  provider: "openai" | "nanobanana" | "comfyui" | "runninghub" | "internal";
  group: "Trending models" | "Image" | "Edit" | "Operations";
  capability: ModuleType[];
  cost: number;
  priceCents?: number;
  currency?: "CNY" | "USD";
}

export interface WorkflowModuleDefinition {
  moduleType: ModuleType;
  nodeType: NodeType;
  operation: OperationType;
  apiPath: GenerationApiPath;
  label: string;
  detail: string;
  defaultPrompt: string;
  defaultModelId: string;
}

export const WORKFLOW_MODULE_REGISTRY: WorkflowModuleDefinition[] = [
  {
    moduleType: "generate",
    nodeType: "config",
    operation: "generate",
    apiPath: "/api/generations",
    label: "Generate",
    detail: "new design from references",
    defaultPrompt: "Generate a new fashion design from the upstream references and prompt.",
    defaultModelId: "gpt-image-2-medium"
  },
  {
    moduleType: "edit",
    nodeType: "edit",
    operation: "edit",
    apiPath: "/api/edits",
    label: "Edit",
    detail: "controlled image edit",
    defaultPrompt: "Make a controlled local fashion edit while preserving pose and garment structure.",
    defaultModelId: "gpt-image-2-medium"
  },
  {
    moduleType: "upscale",
    nodeType: "upscale",
    operation: "upscale",
    apiPath: "/api/upscale",
    label: "Upscale",
    detail: "clean high-res output",
    defaultPrompt: "Upscale while preserving garment texture, embroidery, and clean product edges.",
    defaultModelId: "upscale-pro"
  },
  {
    moduleType: "removeBackground",
    nodeType: "removeBg",
    operation: "removeBackground",
    apiPath: "/api/remove-bg",
    label: "Remove BG",
    detail: "cutout for product use",
    defaultPrompt: "Remove the background and keep clean product edges for internal design review.",
    defaultModelId: "background-cleaner"
  },
  {
    moduleType: "batch",
    nodeType: "batch",
    operation: "generate",
    apiPath: "/api/generations",
    label: "Batch",
    detail: "same brief across selected images",
    defaultPrompt: "Apply one consistent edit brief to every selected reference image.",
    defaultModelId: "gpt-image-2-medium"
  },
  {
    moduleType: "upload",
    nodeType: "image",
    operation: "generate",
    apiPath: "/api/generations",
    label: "Upload Reference",
    detail: "reference handoff node",
    defaultPrompt: "Use this upload reference as an upstream image input.",
    defaultModelId: "gpt-image-2-medium"
  }
];

export function getWorkflowModuleDefinition(moduleType: ModuleType) {
  const definition = WORKFLOW_MODULE_REGISTRY.find((item) => item.moduleType === moduleType);
  if (!definition) throw new Error(`Workflow module ${moduleType} is not registered`);
  return definition;
}

export function getWorkflowApiPathForOperation(operation: GenerationRequest["operation"]): GenerationApiPath {
  const definition = WORKFLOW_MODULE_REGISTRY.find((item) => item.operation === operation);
  if (!definition) throw new Error(`Workflow operation ${operation} is not registered`);
  return definition.apiPath;
}

export interface Workspace {
  profile: Profile;
  projects: Project[];
  activeProjectId?: string;
  history: HistoryEntry[];
  assets: LibraryAsset[];
  prompts: PromptPreset[];
  modelRegistry: ModelDefinition[];
}

let idCounter = 0;

function createId(prefix: string) {
  idCounter += 1;
  const randomPart =
    typeof globalThis.crypto?.randomUUID === "function"
      ? globalThis.crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return `${prefix}-${Date.now().toString(36)}-${idCounter.toString(36)}-${randomPart}`;
}

function now() {
  return new Date().toISOString();
}

function defaultViewport(): Viewport {
  return { x: 0, y: 0, zoom: 1, background: "blank", minimapOpen: true };
}

function defaultGeneration(overrides: Partial<GenerationConfig> = {}): GenerationConfig {
  return {
    prompt: "",
    modelId: "gpt-image-2-medium",
    outputCount: 1,
    entryPoint: "inspector",
    size: "1:1",
    quality: "auto",
    ...overrides
  };
}

function portsFor(type: NodeType): Pick<CanvasNode, "inputs" | "outputs"> {
  if (type === "image" || type === "text") {
    return {
      inputs: [{ id: "in", type: type === "text" ? "text" : "image", label: "Input" }],
      outputs: [{ id: "out", type: type === "text" ? "text" : "image", label: "Output" }]
    };
  }
  if (type === "imageGroup") {
    return {
      inputs: [{ id: "refs", type: "image", label: "References" }],
      outputs: [{ id: "out", type: "image", label: "Reference group" }]
    };
  }
  return {
    inputs: [
      { id: "image", type: "image", label: "Images" },
      { id: "text", type: "text", label: "Prompt" }
    ],
    outputs: [{ id: "result", type: "result", label: "Result" }]
  };
}

function createNode(input: {
  type: NodeType;
  kind?: NodeKind;
  name: string;
  source?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  generation?: Partial<GenerationConfig>;
  references?: string[];
  operation?: OperationType;
  moduleType?: ModuleType;
  parentId?: string;
  metadata?: Record<string, unknown>;
}): CanvasNode {
  const ports = portsFor(input.type);
  const transform = {
    x: input.x,
    y: input.y,
    width: input.width,
    height: input.height,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    lockedRatio: input.type === "image"
  };
  const references = input.references ?? [];
  return {
    id: createId("node"),
    type: input.type,
    kind: input.kind ?? (input.type === "image" ? "upload" : input.type === "imageGroup" ? "referenceGroup" : "workflow"),
    name: input.name,
    source: input.source ?? "",
    x: input.x,
    y: input.y,
    width: input.width,
    height: input.height,
    ...ports,
    status: "idle",
    metadata: input.metadata ?? {},
    references,
    referenceIds: references,
    transform,
    generation: defaultGeneration(input.generation),
    parentId: input.parentId,
    operation: input.operation,
    moduleType: input.moduleType
  };
}

function snapshot(project: Project): ProjectSnapshot {
  return {
    nodes: project.nodes,
    connections: project.connections,
    viewport: project.viewport,
    selectedNodeIds: project.selectedNodeIds
  };
}

function withUndo(project: Project, patch: Omit<Partial<Project>, "undoStack" | "redoStack">): Project {
  return {
    ...project,
    ...patch,
    undoStack: [snapshot(project), ...project.undoStack].slice(0, 50),
    redoStack: [],
    updatedAt: now()
  };
}

function updateProject(workspace: Workspace, projectId: string, updater: (project: Project) => Project): Workspace {
  return {
    ...workspace,
    projects: workspace.projects.map((project) => (project.id === projectId ? updater(project) : project))
  };
}

export function findProject(workspace: Workspace, projectId: string) {
  const project = workspace.projects.find((item) => item.id === projectId);
  if (!project) throw new Error("Project not found");
  return project;
}

export function findNode(project: Project, nodeId: string) {
  const node = project.nodes.find((item) => item.id === nodeId);
  if (!node) throw new Error("Node not found");
  return node;
}

function connect(fromNodeId: string, toNodeId: string, fromPort = "out", toPort = "image"): Connection {
  return {
    id: createId("connection"),
    fromNodeId,
    fromPort,
    toNodeId,
    toPort,
    from: fromNodeId,
    to: toNodeId
  };
}

function operationForModuleNode(node: CanvasNode): OperationType {
  if (node.operation) return node.operation;
  if (node.moduleType) return getWorkflowModuleDefinition(node.moduleType).operation;
  if (node.type === "upscale") return "upscale";
  if (node.type === "removeBg") return "removeBackground";
  if (node.type === "edit") return "edit";
  return "generate";
}

function defaultOperationForModel(model: ModelDefinition): OperationType | undefined {
  if (model.capability.includes("generate")) return "generate";
  if (model.capability.includes("removeBackground")) return "removeBackground";
  if (model.capability.includes("upscale")) return "upscale";
  if (model.capability.includes("edit")) return "edit";
  return undefined;
}

function isExecutableWorkflowNode(node: CanvasNode) {
  return node.kind === "workflow" || node.type === "config" || node.type === "edit" || node.type === "upscale" || node.type === "removeBg";
}

function placeNextTo(node: CanvasNode, index = 1) {
  return {
    x: node.x + node.width + 120 * index,
    y: node.y + 34 * (index - 1)
  };
}

function spendCredits(workspace: Workspace, cost: number): Workspace {
  if (workspace.profile.creditBalance < cost) throw new Error("Not enough credits");
  return {
    ...workspace,
    profile: {
      ...workspace.profile,
      creditBalance: workspace.profile.creditBalance - cost,
      creditUsed: workspace.profile.creditUsed + cost,
      credits: workspace.profile.creditBalance - cost
    }
  };
}

function assetFromNode(node: CanvasNode, projectId: string): LibraryAsset {
  const operation = typeof node.metadata.operation === "string" ? node.metadata.operation : node.operation;
  return {
    id: createId("asset"),
    type: node.type === "text" ? "text" : "image",
    title: node.name,
    source: node.source,
    tags: ["generated", String(operation ?? node.type)],
    createdAt: now(),
    metadata: { projectId, nodeId: node.id, historyId: node.metadata.historyId, operation, width: node.width, height: node.height }
  };
}

function createBatchOriginalNodes(batch: BatchImport, existingCount = 0): CanvasNode[] {
  return batch.files.map((file, index) =>
    createNode({
      type: "image",
      kind: "upload",
      name: file.name,
      source: file.source,
      x: 220 + (existingCount + index) * 148,
      y: 520,
      width: file.width,
      height: file.height,
      generation: {
        prompt: batch.prompt,
        modelId: batch.modelId,
        outputCount: batch.outputCount,
        entryPoint: "workflow"
      },
      metadata: {
        batchOriginal: true,
        folderName: batch.folderName,
        sourceFile: file.name,
        originalWidth: file.width,
        originalHeight: file.height
      }
    })
  );
}

function batchFileKey(file: Pick<AssetInput, "name" | "source">) {
  return `${file.name}\u0000${file.source}`;
}

function batchItemKey(item: Pick<BatchItem, "name" | "source">) {
  return `${item.name}\u0000${item.source}`;
}

function batchOriginalKey(node: CanvasNode) {
  return `${String(node.metadata.sourceFile ?? node.name)}\u0000${node.source}`;
}

export function summarizeBatchQueue(items: BatchItem[]) {
  const total = items.length;
  const queued = items.filter((item) => item.status === "queued").length;
  const processing = items.filter((item) => item.status === "processing").length;
  const succeeded = items.filter((item) => item.status === "done").length;
  const failed = items.filter((item) => item.status === "error").length;
  const cancelled = items.filter((item) => item.status === "cancelled").length;
  const completed = succeeded + failed + cancelled;
  const percent = total ? Math.round((completed / total) * 100) : 0;
  const status =
    total === 0
      ? "empty"
      : failed
        ? "error"
        : processing
          ? "running"
          : cancelled && completed === total
            ? "cancelled"
            : completed === total
              ? "succeeded"
              : "queued";
  return { total, queued, processing, completed, succeeded, failed, cancelled, percent, status };
}

export function createInitialWorkspace(profile: Partial<Profile> = {}): Workspace {
  const creditBalance = profile.creditBalance ?? profile.credits ?? 120;
  return {
    profile: {
      ...profile,
      userId: profile.userId ?? "designer-demo",
      designerName: profile.designerName ?? "Demo Designer",
      role: profile.role ?? "designer",
      creditBalance,
      creditUsed: profile.creditUsed ?? 0,
      credits: creditBalance,
      creditLimit: profile.creditLimit
    },
    projects: [],
    history: [],
    assets: [],
    prompts: [
      {
        id: "prompt-fashion-edit",
        title: "局部服装改款",
        prompt: "只修改选区内的服装细节，保持模特姿势、背景、光线和版型不变。",
        tags: ["edit", "fashion"],
        source: "internal"
      },
      {
        id: "prompt-reference-design",
        title: "双参考设计",
        prompt: "参考图一的版型和图二的纹理，生成一款新的女装单品，保持高级成衣摄影质感。",
        tags: ["reference", "design"],
        source: "internal"
      }
    ],
    modelRegistry: [
      { id: "gpt-image-2-high", name: "GPT Image 2 High", provider: "openai", group: "Trending models", capability: ["generate", "edit"], cost: 24 },
      { id: "gpt-image-2-medium", name: "GPT Image 2 Medium", provider: "openai", group: "Trending models", capability: ["generate", "edit"], cost: 7 },
      { id: "gpt-image-2-low", name: "GPT Image 2 Low", provider: "openai", group: "Trending models", capability: ["generate", "edit"], cost: 2 },
      { id: "nanobanana2", name: "Nano Banana 2", provider: "nanobanana", group: "Trending models", capability: ["generate", "edit"], cost: 11 },
      { id: "nanobanana2-pro", name: "Nano Banana Pro", provider: "nanobanana", group: "Trending models", capability: ["generate", "edit"], cost: 20 },
      { id: "flux-pro", name: "Flux Pro", provider: "internal", group: "Image", capability: ["generate", "edit"], cost: 6 },
      { id: "upscale-pro", name: "Creative Upscale", provider: "internal", group: "Operations", capability: ["upscale"], cost: 4 },
      { id: "background-cleaner", name: "Remove Background", provider: "internal", group: "Operations", capability: ["removeBackground"], cost: 2 }
    ]
  };
}

export function createProject(workspace: Workspace, name: string) {
  const project: Project = {
    id: createId("project"),
    name,
    nodes: [],
    connections: [],
    selectedNodeIds: [],
    viewport: defaultViewport(),
    batchQueue: [],
    undoStack: [],
    redoStack: [],
    updatedAt: now()
  };
  return {
    workspace: { ...workspace, projects: [project, ...workspace.projects], activeProjectId: project.id },
    project
  };
}

export function addAssetToProjectAt(workspace: Workspace, projectId: string, asset: AssetInput, x?: number, y?: number): Workspace {
  return updateProject(workspace, projectId, (project) => {
    const imageIndex = project.nodes.filter((node) => node.type === "image" || node.type === "imageGroup" || node.type === "batch").length;
    const column = imageIndex % 4;
    const row = Math.floor(imageIndex / 4);
    const node = createNode({
      type: "image",
      kind: "upload",
      name: asset.name,
      source: asset.source,
      x: x ?? 640 + column * 430,
      y: y ?? 90 + row * 560,
      width: asset.width,
      height: asset.height,
      metadata: { originalWidth: asset.width, originalHeight: asset.height }
    });
    return withUndo(project, { nodes: [...project.nodes, node], selectedNodeIds: [node.id] });
  });
}

export function addAssetToProject(workspace: Workspace, projectId: string, asset: AssetInput): Workspace {
  return addAssetToProjectAt(workspace, projectId, asset);
}

export function addTextNode(workspace: Workspace, projectId: string, content: string, x = 620, y = 260): Workspace {
  return updateProject(workspace, projectId, (project) => {
    const node = createNode({
      type: "text",
      kind: "workflow",
      name: "Prompt note",
      source: content,
      x,
      y,
      width: 260,
      height: 160,
      metadata: { content }
    });
    return withUndo(project, { nodes: [...project.nodes, node], selectedNodeIds: [node.id] });
  });
}

export function configureNodeGeneration(
  workspace: Workspace,
  projectId: string,
  nodeId: string,
  generation: GenerationConfig
): Workspace {
  return updateProject(workspace, projectId, (project) =>
    withUndo(project, {
      nodes: project.nodes.map((node) => (node.id === nodeId ? { ...node, generation } : node))
    })
  );
}

export function updateNodeTransform(
  workspace: Workspace,
  projectId: string,
  nodeId: string,
  patch: Partial<NodeTransform>
): Workspace {
  return updateProject(workspace, projectId, (project) =>
    withUndo(project, {
      nodes: project.nodes.map((node) => {
        if (node.id !== nodeId) return node;
        const transform = { ...node.transform, ...patch };
        return { ...node, transform, x: transform.x, y: transform.y, width: transform.width, height: transform.height };
      })
    })
  );
}

export function updateViewport(workspace: Workspace, projectId: string, patch: Partial<Viewport>): Workspace {
  return updateProject(workspace, projectId, (project) => withUndo(project, { viewport: { ...project.viewport, ...patch } }));
}

export function markNodeRunState(
  workspace: Workspace,
  projectId: string,
  nodeId: string,
  status: Extract<NodeStatus, "running" | "done" | "error" | "idle">,
  errorMessage?: string
): Workspace {
  return updateProject(workspace, projectId, (project) => ({
    ...project,
    nodes: project.nodes.map((node) =>
      node.id === nodeId
        ? {
            ...node,
            status,
            errorMessage: status === "error" ? errorMessage || "Backend request failed" : undefined,
            metadata: {
              ...node.metadata,
              runStatus: status,
              errorMessage: status === "error" ? errorMessage || "Backend request failed" : undefined
            }
          }
        : node
    ),
    updatedAt: now()
  }));
}

export function selectNodes(workspace: Workspace, projectId: string, nodeIds: string[], append = false): Workspace {
  return updateProject(workspace, projectId, (project) => {
    const selected = append ? Array.from(new Set([...project.selectedNodeIds, ...nodeIds])) : nodeIds;
    return {
      ...project,
      selectedNodeIds: selected,
      nodes: project.nodes.map((node) => {
        const hasRunState = node.status === "running" || node.status === "done" || node.status === "error";
        return hasRunState ? node : { ...node, status: selected.includes(node.id) ? "selected" : "idle" };
      })
    };
  });
}

export function deleteSelectedNodes(workspace: Workspace, projectId: string): Workspace {
  return updateProject(workspace, projectId, (project) => {
    const selected = new Set(project.selectedNodeIds);
    return withUndo(project, {
      nodes: project.nodes.filter((node) => !selected.has(node.id)),
      connections: project.connections.filter((item) => !selected.has(item.fromNodeId) && !selected.has(item.toNodeId)),
      selectedNodeIds: []
    });
  });
}

export function copyPasteSelectedNodes(workspace: Workspace, projectId: string): Workspace {
  return updateProject(workspace, projectId, (project) => {
    const selected = project.nodes.filter((node) => project.selectedNodeIds.includes(node.id));
    const idMap = new Map<string, string>();
    const clones = selected.map((node) => {
      const id = createId("node");
      idMap.set(node.id, id);
      return {
        ...node,
        id,
        name: `${node.name} copy`,
        x: node.x + 42,
        y: node.y + 42,
        transform: { ...node.transform, x: node.transform.x + 42, y: node.transform.y + 42 },
        parentId: node.id,
        status: "selected" as NodeStatus
      };
    });
    const clonedConnections = project.connections
      .filter((connection) => idMap.has(connection.fromNodeId) && idMap.has(connection.toNodeId))
      .map((connection) => connect(idMap.get(connection.fromNodeId)!, idMap.get(connection.toNodeId)!, connection.fromPort, connection.toPort));
    return withUndo(project, {
      nodes: [...project.nodes.map((node) => ({ ...node, status: "idle" as NodeStatus })), ...clones],
      connections: [...project.connections, ...clonedConnections],
      selectedNodeIds: clones.map((node) => node.id)
    });
  });
}

export function undoProject(workspace: Workspace, projectId: string): Workspace {
  return updateProject(workspace, projectId, (project) => {
    const [previous, ...rest] = project.undoStack;
    if (!previous) return project;
    return {
      ...project,
      ...previous,
      undoStack: rest,
      redoStack: [snapshot(project), ...project.redoStack],
      updatedAt: now()
    };
  });
}

export function redoProject(workspace: Workspace, projectId: string): Workspace {
  return updateProject(workspace, projectId, (project) => {
    const [next, ...rest] = project.redoStack;
    if (!next) return project;
    return {
      ...project,
      ...next,
      redoStack: rest,
      undoStack: [snapshot(project), ...project.undoStack],
      updatedAt: now()
    };
  });
}

export function runGeneration(workspace: Workspace, projectId: string, nodeId: string): Workspace {
  const project = findProject(workspace, projectId);
  const source = findNode(project, nodeId);
  if (!source.generation.prompt.trim()) throw new Error("Prompt is required");
  const cost = source.generation.outputCount;
  const historyId = createId("history");
  const charged = spendCredits(workspace, cost);

  const generatedNodes = Array.from({ length: source.generation.outputCount }, (_, index) => {
    const position = placeNextTo(source, index + 1);
    return createNode({
      type: "image",
      kind: "generated",
      name: `${source.name} result ${index + 1}`,
      source: `${source.source || "generated"}#generated-${index + 1}`,
      x: position.x,
      y: position.y,
      width: source.width,
      height: source.height,
      generation: source.generation,
      parentId: source.id,
      references: source.type === "imageGroup" ? source.references : source.references.length ? source.references : [source.id],
      metadata: {
        historyId,
        operation: "generate",
        creditCost: cost,
        prompt: source.generation.prompt,
        modelId: source.generation.modelId
      }
    });
  });

  const updated = updateProject(charged, projectId, (item) =>
    withUndo(item, {
      nodes: [...item.nodes, ...generatedNodes],
      connections: [...item.connections, ...generatedNodes.map((node) => connect(source.id, node.id, "out", "in"))],
      selectedNodeIds: generatedNodes.map((node) => node.id)
    })
  );

  return {
    ...updated,
    history: [
      {
        id: historyId,
        projectId,
        nodeId,
        prompt: source.generation.prompt,
        modelId: source.generation.modelId,
        outputCount: source.generation.outputCount,
        creditCost: cost,
        operation: "generate",
        referenceCount: source.references.length || 1,
        createdAt: now()
      },
      ...updated.history
    ]
  };
}

export function applyGenerationResultToCanvas(
  workspace: Workspace,
  projectId: string,
  nodeId: string,
  request: GenerationRequest,
  result: GenerationResult,
  serverState: { profile?: Profile; history?: HistoryEntry[]; models?: ModelDefinition[] } = {}
): Workspace {
  const project = findProject(workspace, projectId);
  const source = findNode(project, nodeId);
  const references = request.referenceNodeIds.length
    ? request.referenceNodeIds
    : source.type === "imageGroup"
      ? source.references
      : source.references.length
        ? source.references
        : [source.id];
  const outputs = result.outputs.length
    ? result.outputs
    : Array.from({ length: request.outputCount }, (_, index) => ({
        name: `${source.name} result ${index + 1}`,
        source: `${source.source || "generated"}#api-result-${index + 1}`,
        width: source.width,
        height: source.height
      }));
  const generatedNodes = outputs.map((output, index) => {
    const position = placeNextTo(source, index + 1);
    const outputSource = output.source.startsWith("mock://") ? `${source.source || "generated"}#${result.historyId}-${index + 1}` : output.source;
    return createNode({
      type: "image",
      kind: "generated",
      name: output.name || `${source.name} result ${index + 1}`,
      source: outputSource,
      x: position.x,
      y: position.y,
      width: output.width || source.width,
      height: output.height || source.height,
      generation: {
        ...source.generation,
        prompt: request.prompt,
        modelId: request.modelId,
        outputCount: request.outputCount,
        entryPoint: source.generation.entryPoint
      },
      parentId: source.id,
      references,
      metadata: {
        historyId: result.historyId,
        operation: request.operation,
        creditCost: result.creditCost,
        remoteSource: output.source,
        prompt: request.prompt,
        modelId: request.modelId
      }
    });
  });
  const updated = updateProject(workspace, projectId, (item) =>
    withUndo(item, {
      nodes: [
        ...item.nodes.map((node) =>
          node.id === source.id
            ? {
                ...node,
                status: "done" as NodeStatus,
                metadata: {
                  ...node.metadata,
                  runStatus: "done",
                  inputNodeIds: references,
                  outputNodeIds: [...(Array.isArray(node.metadata.outputNodeIds) ? node.metadata.outputNodeIds : []), ...generatedNodes.map((output) => output.id)],
                  historyId: result.historyId,
                  creditCost: result.creditCost,
                  operation: request.operation,
                  modelId: request.modelId,
                  prompt: request.prompt
                }
              }
            : node
        ),
        ...generatedNodes
      ],
      connections: [...item.connections, ...generatedNodes.map((node) => connect(source.id, node.id, "out", "in"))],
      selectedNodeIds: generatedNodes.map((node) => node.id)
    })
  );
  return {
    ...updated,
    profile: serverState.profile ?? updated.profile,
    history: serverState.history ?? updated.history,
    modelRegistry: serverState.models ?? updated.modelRegistry,
    assets: [...generatedNodes.map((node) => assetFromNode(node, projectId)), ...updated.assets]
  };
}

export function applyBatchGenerationResultsToCanvas(
  workspace: Workspace,
  projectId: string,
  batch: BatchImport,
  outcomes: BatchGenerationOutcome[],
  serverState: { profile?: Profile; history?: HistoryEntry[]; models?: ModelDefinition[] } = {}
): Workspace {
  let generatedNodes: CanvasNode[] = [];
  const model = workspace.modelRegistry.find((item) => item.id === batch.modelId);
  const operation = model ? defaultOperationForModel(model) ?? "generate" : "generate";
  const updated = updateProject(workspace, projectId, (project) => {
    const existingOriginalByFile = new Map(
      project.nodes.filter((node) => node.metadata.batchOriginal).map((node) => [batchOriginalKey(node), node])
    );
    const missingFiles = batch.files.filter((file) => !existingOriginalByFile.has(batchFileKey(file)));
    const newOriginalNodes = createBatchOriginalNodes(
      { ...batch, files: missingFiles },
      project.nodes.filter((node) => node.metadata.batchOriginal).length
    );
    const originalByFile = new Map<string, CanvasNode>([...existingOriginalByFile, ...newOriginalNodes.map((node) => [batchOriginalKey(node), node] as const)]);
    generatedNodes = batch.files.flatMap((file, fileIndex) => {
      const result = outcomes[fileIndex]?.result;
      const outputs = result?.outputs.length ? result.outputs : [];
      const originalNode = originalByFile.get(batchFileKey(file));
      return outputs.map((output, outputIndex) => {
        const x = (originalNode?.x ?? 220 + fileIndex * 148) + (originalNode?.width ?? file.width) + 112 + outputIndex * 24;
        const y = (originalNode?.y ?? 520) + outputIndex * 28;
        return createNode({
          type: "batch",
          kind: "generated",
          name: output.name || `${file.name} batch result ${outputIndex + 1}`,
          source: output.source.startsWith("mock://") ? `${file.source}#batch-${fileIndex + 1}-${outputIndex + 1}` : output.source,
          x,
          y,
          width: output.width || file.width,
          height: output.height || file.height,
          parentId: originalNode?.id,
          generation: {
            prompt: batch.prompt,
            modelId: batch.modelId,
            outputCount: batch.outputCount,
            entryPoint: "workflow"
          },
          references: originalNode ? [originalNode.id] : [file.name],
          metadata: {
            folderName: batch.folderName,
            sourceFile: file.name,
            historyId: result?.historyId,
            creditCost: result?.creditCost,
            remoteSource: output.source,
            prompt: batch.prompt,
            modelId: batch.modelId,
            operation
          }
        });
      });
    });
    const outputIdsByOriginal = new Map<string, string[]>();
    for (const node of generatedNodes) {
      if (!node.parentId) continue;
      outputIdsByOriginal.set(node.parentId, [...(outputIdsByOriginal.get(node.parentId) ?? []), node.id]);
    }
    const auditedOriginalNodes = batch.files.map((file, fileIndex) => {
      const node = originalByFile.get(batchFileKey(file))!;
      const outcome = outcomes[fileIndex];
      const result = outcome?.result;
      const outputNodeIds = outputIdsByOriginal.get(node.id) ?? [];
      const failed = !result;
      return {
        ...node,
        status: failed ? ("error" as NodeStatus) : ("done" as NodeStatus),
        errorMessage: failed ? outcome?.errorMessage ?? "Batch item failed" : undefined,
        metadata: {
          ...node.metadata,
          runStatus: failed ? "error" : "done",
          inputNodeIds: [node.id],
          outputNodeIds,
          historyId: result?.historyId,
          creditCost: result?.creditCost,
          errorMessage: failed ? outcome?.errorMessage ?? "Batch item failed" : undefined,
          prompt: batch.prompt,
          modelId: batch.modelId,
          operation
        }
      };
    });
    const auditedById = new Map(auditedOriginalNodes.map((node) => [node.id, node]));
    const batchConnections = generatedNodes.flatMap((node) => (node.parentId ? [connect(node.parentId, node.id, "out", "image")] : []));
    const existingQueueByFile = new Map(project.batchQueue.map((item) => [batchItemKey(item), item]));
    const nextQueueByFile = new Map(project.batchQueue.map((item) => [batchItemKey(item), item]));
    for (const [fileIndex, file] of batch.files.entries()) {
      const key = batchFileKey(file);
      const existing = existingQueueByFile.get(key);
      const result = outcomes[fileIndex]?.result;
      const errorMessage = outcomes[fileIndex]?.errorMessage ?? (!result ? "Batch item failed" : undefined);
      nextQueueByFile.set(key, {
        id: existing?.id ?? createId("batch"),
        name: file.name,
        source: file.source,
        width: file.width,
        height: file.height,
        status: result ? "done" : "error",
        attempts: (existing?.attempts ?? 0) + 1,
        maxAttempts: existing?.maxAttempts ?? 2,
        errorMessage
      });
    }
    return withUndo(project, {
      batchConfig: {
        folderName: batch.folderName,
        prompt: batch.prompt,
        modelId: batch.modelId,
        outputCount: batch.outputCount
      },
      batchQueue: Array.from(nextQueueByFile.values()),
      nodes: [
        ...project.nodes.map((node) => auditedById.get(node.id) ?? node),
        ...auditedOriginalNodes.filter((node) => !project.nodes.some((existing) => existing.id === node.id)),
        ...generatedNodes
      ],
      connections: [...project.connections, ...batchConnections],
      selectedNodeIds: (generatedNodes.length ? generatedNodes : auditedOriginalNodes).map((node) => node.id)
    });
  });
  return {
    ...updated,
    profile: serverState.profile ?? updated.profile,
    history: serverState.history ?? updated.history,
    modelRegistry: serverState.models ?? updated.modelRegistry,
    assets: [...generatedNodes.map((node) => assetFromNode(node, projectId)), ...updated.assets]
  };
}

export function applyImageOperation(
  workspace: Workspace,
  projectId: string,
  nodeId: string,
  operation: OperationType
): Workspace {
  return updateProject(workspace, projectId, (project) => {
    const source = findNode(project, nodeId);
    const type: NodeType =
      operation === "upscale" ? "upscale" : operation === "removeBackground" ? "removeBg" : operation === "edit" ? "edit" : "config";
    const position = placeNextTo(source, 1);
    const operationNode = createNode({
      type,
      kind: "operation",
      name: `${source.name} ${operation}`,
      operation,
      source: `${source.source}#${operation}`,
      parentId: source.id,
      references: [source.id],
      x: position.x,
      y: position.y,
      width: source.width,
      height: source.height,
      generation: {
        prompt: operation === "upscale" ? "高清放大，保留织物纹理和版型。" : "去除背景并保持主体边缘干净。",
        modelId: operation === "upscale" ? "upscale-pro" : "background-cleaner",
        entryPoint: "workflow"
      }
    });
    return withUndo(project, {
      nodes: [...project.nodes, operationNode],
      connections: [...project.connections, connect(source.id, operationNode.id)],
      selectedNodeIds: [operationNode.id]
    });
  });
}

export function commitShapeEdit(
  workspace: Workspace,
  projectId: string,
  nodeId: string,
  edit: { shape: "ellipse" | "rectangle" | "freehand"; prompt: string; mask?: MaskSelection }
): Workspace {
  return updateProject(workspace, projectId, (project) => {
    const source = findNode(project, nodeId);
    const position = placeNextTo(source, 2);
    const editNode = createNode({
      type: "edit",
      kind: "edit",
      name: `${source.name} mask edit`,
      source: `${source.source}#shape-edit`,
      parentId: source.id,
      references: [source.id],
      x: position.x,
      y: position.y,
      width: source.width,
      height: source.height,
      generation: { prompt: edit.prompt, modelId: source.generation.modelId, entryPoint: "workflow" },
      metadata: { editShape: edit.shape, mask: edit.mask }
    });
    editNode.editShape = edit.shape;
    return withUndo(project, {
      nodes: [...project.nodes, editNode],
      connections: [...project.connections, connect(source.id, editNode.id)],
      selectedNodeIds: [editNode.id]
    });
  });
}

export function importBatchFolder(workspace: Workspace, projectId: string, batch: BatchImport): Workspace {
  return updateProject(workspace, projectId, (project) => {
    const originalNodes = createBatchOriginalNodes(
      batch,
      project.nodes.filter((node) => node.metadata.batchOriginal).length
    );
    return withUndo(project, {
      batchConfig: {
        folderName: batch.folderName,
        prompt: batch.prompt,
        modelId: batch.modelId,
        outputCount: batch.outputCount
      },
      batchQueue: batch.files.map((file) => ({
        id: createId("batch"),
        name: file.name,
        source: file.source,
        width: file.width,
        height: file.height,
        status: "queued",
        attempts: 0,
        maxAttempts: 2
      })),
      nodes: [...project.nodes, ...originalNodes],
      selectedNodeIds: originalNodes.map((node) => node.id)
    });
  });
}

export function buildRetryBatchFromFailures(workspace: Workspace, projectId: string): BatchImport {
  const project = findProject(workspace, projectId);
  if (!project.batchConfig) throw new Error("Batch configuration is required");
  const retryItems = project.batchQueue.filter((item) => item.status === "error" || item.status === "cancelled");
  if (!retryItems.length) throw new Error("No failed batch items to retry");
  return {
    folderName: project.batchConfig.folderName,
    prompt: project.batchConfig.prompt,
    modelId: project.batchConfig.modelId,
    outputCount: project.batchConfig.outputCount,
    files: retryItems.map((item) => ({
      name: item.name,
      source: item.source,
      width: item.width,
      height: item.height
    }))
  };
}

export function cancelBatchQueue(workspace: Workspace, projectId: string): Workspace {
  return updateProject(workspace, projectId, (project) =>
    withUndo(project, {
      batchQueue: project.batchQueue.map((item) =>
        item.status === "queued" || item.status === "processing"
          ? { ...item, status: "cancelled" as const, errorMessage: "Cancelled by designer" }
          : item
      )
    })
  );
}

export function runBatchQueue(workspace: Workspace, projectId: string): Workspace {
  const project = findProject(workspace, projectId);
  if (!project.batchConfig) throw new Error("Batch configuration is required");
  if (!project.batchConfig.prompt.trim()) throw new Error("Prompt is required");
  const model = workspace.modelRegistry.find((item) => item.id === project.batchConfig!.modelId);
  if (!model) throw new Error("Model not found");
  const operation = defaultOperationForModel(model);
  if (!operation) throw new Error(`Model ${model.id} does not support batch operations`);
  const totalOutputs = project.batchQueue.length * project.batchConfig.outputCount;
  const creditCost = model.cost * totalOutputs;
  const charged = spendCredits(workspace, creditCost);
  const generatedNodes = project.batchQueue.map((item, index) => {
    const originalNode = project.nodes.find(
      (node) => node.metadata.batchOriginal && node.metadata.sourceFile === item.name && node.source === item.source
    );
    const x = (originalNode?.x ?? 220 + index * 148) + (originalNode?.width ?? item.width) + 112;
    const y = originalNode?.y ?? 520;
    return createNode({
      type: "batch",
      kind: "generated",
      name: `${item.name} batch result`,
      source: `${item.source}#batch-generated`,
      x,
      y,
      width: item.width,
      height: item.height,
      parentId: originalNode?.id,
      generation: {
        prompt: project.batchConfig!.prompt,
        modelId: project.batchConfig!.modelId,
        outputCount: project.batchConfig!.outputCount,
        entryPoint: "workflow"
      },
      references: originalNode ? [originalNode.id] : [item.name],
      metadata: {
        folderName: project.batchConfig!.folderName,
        sourceFile: item.name,
        operation
      }
    });
  });
  const batchConnections = generatedNodes.flatMap((node) => (node.parentId ? [connect(node.parentId, node.id, "out", "image")] : []));
  const updated = updateProject(charged, projectId, (item) =>
    withUndo(item, {
      batchQueue: item.batchQueue.map((queueItem) => ({
        ...queueItem,
        status: "done" as const,
        attempts: (queueItem.attempts ?? 0) + 1,
        maxAttempts: queueItem.maxAttempts ?? 1,
        errorMessage: undefined
      })),
      nodes: [...item.nodes, ...generatedNodes],
      connections: [...item.connections, ...batchConnections],
      selectedNodeIds: generatedNodes.map((node) => node.id)
    })
  );
  return {
    ...updated,
    history: [
      {
        id: createId("history"),
        projectId,
        nodeId: project.batchQueue[0]?.id ?? projectId,
        prompt: project.batchConfig.prompt,
        modelId: project.batchConfig.modelId,
        outputCount: totalOutputs,
        creditCost,
        operation,
        createdAt: now()
      },
      ...updated.history
    ]
  };
}

export function connectWorkflowNode(
  workspace: Workspace,
  projectId: string,
  from: string,
  to: string,
  fromPort = "out",
  toPort = "image"
): Workspace {
  return updateProject(workspace, projectId, (project) => {
    findNode(project, from);
    findNode(project, to);
    const exists = project.connections.some((connection) => connection.fromNodeId === from && connection.toNodeId === to);
    return exists ? project : withUndo(project, { connections: [...project.connections, connect(from, to, fromPort, toPort)] });
  });
}

export function mergeReferenceSelection(
  workspace: Workspace,
  projectId: string,
  nodeIds: string[],
  name: string
): Workspace {
  return updateProject(workspace, projectId, (project) => {
    const references = nodeIds.map((id) => findNode(project, id));
    const left = Math.min(...references.map((node) => node.x));
    const top = Math.min(...references.map((node) => node.y));
    const groupNode = createNode({
      type: "imageGroup",
      kind: "referenceGroup",
      name,
      source: references.map((node) => node.source).join("|"),
      x: left + 96,
      y: top + 220,
      width: 360,
      height: 220,
      references: nodeIds,
      metadata: { referenceCount: nodeIds.length }
    });
    return withUndo(project, {
      nodes: [...project.nodes, groupNode],
      connections: [...project.connections, ...nodeIds.map((id) => connect(id, groupNode.id))],
      selectedNodeIds: [groupNode.id]
    });
  });
}

export function createWorkflowModuleFromSelection(
  workspace: Workspace,
  projectId: string,
  sourceIds: string[],
  config: { moduleType: ModuleType; prompt: string; modelId: string }
): Workspace {
  return updateProject(workspace, projectId, (project) => {
    const sources = sourceIds.map((id) => findNode(project, id));
    const anchor = sources[sources.length - 1];
    const definition = getWorkflowModuleDefinition(config.moduleType);
    const references = sources.flatMap((node) => (node.type === "imageGroup" ? node.references : [node.id]));
    const moduleNode = createNode({
      type: definition.nodeType,
      kind: "workflow",
      name: `${config.moduleType} module`,
      source: "workflow-module",
      moduleType: config.moduleType,
      parentId: anchor.id,
      references,
      x: anchor.x + anchor.width + 180,
      y: anchor.y + 10,
      width: 260,
      height: 150,
      generation: {
        prompt: config.prompt,
        modelId: config.modelId,
        outputCount: 1,
        entryPoint: "workflow"
      }
    });
    return withUndo(project, {
      nodes: [...project.nodes, moduleNode],
      connections: [...project.connections, ...sourceIds.map((id) => connect(id, moduleNode.id))],
      selectedNodeIds: [moduleNode.id]
    });
  });
}

export function buildWorkflowExecutionPlan(workspace: Workspace, projectId: string, startNodeId: string): WorkflowExecutionPlan {
  const project = findProject(workspace, projectId);
  findNode(project, startNodeId);
  const steps: WorkflowPlanStep[] = [];
  const issues: WorkflowPlanIssue[] = [];
  const visited = new Set<string>([startNodeId]);
  let cursorId = startNodeId;

  while (true) {
    const outgoing = project.connections.filter((connection) => connection.fromNodeId === cursorId);
    if (!outgoing.length) break;
    if (outgoing.length > 1) {
      issues.push({
        nodeId: cursorId,
        severity: "warning",
        message: "Multiple downstream connections found; the first connection will run"
      });
    }

    const nextNode = findNode(project, outgoing[0].toNodeId);
    if (visited.has(nextNode.id)) {
      issues.push({ nodeId: nextNode.id, severity: "error", message: "Workflow cycle detected" });
      break;
    }
    visited.add(nextNode.id);

    if (!isExecutableWorkflowNode(nextNode)) {
      cursorId = nextNode.id;
      continue;
    }

    const referenceNodeIds = nextNode.references.length ? nextNode.references : [cursorId];
    const model = workspace.modelRegistry.find((item) => item.id === nextNode.generation.modelId);
    const operation = operationForModuleNode(nextNode);
    if (!model) {
      issues.push({ nodeId: nextNode.id, severity: "warning", message: "Model is not registered" });
    } else if (!model.capability.includes(operation as ModuleType)) {
      issues.push({ nodeId: nextNode.id, severity: "error", message: `Model ${model.id} does not support ${operation}` });
    }
    if (!nextNode.generation.prompt.trim()) {
      issues.push({ nodeId: nextNode.id, severity: "error", message: "Prompt is required" });
    }
    const unitCost = model?.cost ?? 1;
    steps.push({
      nodeId: nextNode.id,
      name: nextNode.name,
      moduleType: nextNode.moduleType,
      operation,
      modelId: nextNode.generation.modelId,
      prompt: nextNode.generation.prompt,
      outputCount: nextNode.generation.outputCount,
      referenceNodeIds,
      referenceCount: referenceNodeIds.length,
      estimatedCreditCost: unitCost * nextNode.generation.outputCount
    });
    cursorId = nextNode.id;
  }

  const hasErrors = issues.some((issue) => issue.severity === "error");
  const totalEstimatedCredits = steps.reduce((sum, step) => sum + step.estimatedCreditCost, 0);
  return {
    status: hasErrors ? "blocked" : steps.length ? "ready" : "empty",
    startNodeId,
    steps,
    issues,
    totalEstimatedCredits
  };
}

export function buildWorkflowGenerationRequests(workspace: Workspace, projectId: string, startNodeId: string): GenerationRequest[] {
  const plan = buildWorkflowExecutionPlan(workspace, projectId, startNodeId);
  const blockingIssue = plan.issues.find((issue) => issue.severity === "error");
  if (blockingIssue) {
    throw new Error(blockingIssue.message);
  }
  return plan.steps.map((step) => ({
    projectId,
    nodeId: step.nodeId,
    modelId: step.modelId,
    prompt: step.prompt,
    referenceNodeIds: step.referenceNodeIds,
    outputCount: step.outputCount,
    operation: step.operation
  }));
}

function executeModule(workspace: Workspace, projectId: string, moduleNode: CanvasNode): Workspace {
  if (!moduleNode.generation.prompt.trim()) throw new Error("Prompt is required");
  const historyId = createId("history");
  const operation = operationForModuleNode(moduleNode);
  const model = workspace.modelRegistry.find((item) => item.id === moduleNode.generation.modelId);
  if (!model) throw new Error("Model not found");
  if (!model.capability.includes(operation as ModuleType)) {
    throw new Error(`Model ${model.id} does not support ${operation}`);
  }
  const creditCost = model.cost * moduleNode.generation.outputCount;
  const charged = spendCredits(workspace, creditCost);
  let generatedOutput: AssetInput | undefined;
  const updated = updateProject(charged, projectId, (project) => {
    const generatedNode = createNode({
      type: "image",
      kind: "generated",
      name: `${moduleNode.name} output`,
      source: `${moduleNode.source || "workflow"}#${moduleNode.moduleType}-output`,
      parentId: moduleNode.id,
      references: moduleNode.references,
      x: moduleNode.x + moduleNode.width + 112,
      y: moduleNode.y,
      width: 420,
      height: 420,
      generation: moduleNode.generation,
      metadata: {
        historyId,
        moduleType: moduleNode.moduleType,
        operation,
        creditCost,
        prompt: moduleNode.generation.prompt,
        modelId: moduleNode.generation.modelId
      }
    });
    generatedOutput = {
      name: generatedNode.name,
      source: generatedNode.source,
      width: generatedNode.width,
      height: generatedNode.height
    };
    const inputNodeIds = moduleNode.references.length
      ? moduleNode.references
      : project.connections.filter((connection) => connection.toNodeId === moduleNode.id).map((connection) => connection.fromNodeId);
    return withUndo(project, {
      nodes: [
        ...project.nodes.map((node) =>
          node.id === moduleNode.id
            ? {
                ...node,
                status: "done" as NodeStatus,
                metadata: {
                  ...node.metadata,
                  runStatus: "done",
                  inputNodeIds,
                  outputNodeIds: [...(Array.isArray(node.metadata.outputNodeIds) ? node.metadata.outputNodeIds : []), generatedNode.id],
                  historyId,
                  creditCost,
                  operation,
                  modelId: moduleNode.generation.modelId,
                  prompt: moduleNode.generation.prompt
                }
              }
            : node
        ),
        generatedNode
      ],
      connections: [...project.connections, connect(moduleNode.id, generatedNode.id, "result", "in")],
      selectedNodeIds: [generatedNode.id]
    });
  });
  return {
    ...updated,
    history: [
      {
        id: historyId,
        projectId,
        nodeId: moduleNode.id,
        prompt: moduleNode.generation.prompt,
        modelId: moduleNode.generation.modelId,
        outputCount: moduleNode.generation.outputCount,
        creditCost,
        operation,
        moduleType: moduleNode.moduleType,
        referenceCount: moduleNode.references.length,
        outputs: generatedOutput ? [generatedOutput] : [],
        createdAt: now()
      },
      ...updated.history
    ]
  };
}

export function runWorkflowChain(workspace: Workspace, projectId: string, startNodeId: string): Workspace {
  let currentWorkspace = workspace;
  let cursorId = startNodeId;
  const visited = new Set<string>();
  while (!visited.has(cursorId)) {
    visited.add(cursorId);
    const project = findProject(currentWorkspace, projectId);
    const nextConnection = project.connections.find((connection) => connection.fromNodeId === cursorId);
    if (!nextConnection) break;
    const nextNode = findNode(project, nextConnection.toNodeId);
    if (nextNode.kind !== "workflow" && nextNode.type !== "config" && nextNode.type !== "edit" && nextNode.type !== "upscale") {
      cursorId = nextNode.id;
      continue;
    }
    currentWorkspace = executeModule(currentWorkspace, projectId, nextNode);
    cursorId = nextNode.id;
  }
  return currentWorkspace;
}

export function addGenerationTargetFrame(workspace: Workspace, projectId: string): Workspace {
  return updateProject(workspace, projectId, (project) => {
    const anchor = project.nodes.find((node) => project.selectedNodeIds.includes(node.id)) ?? project.nodes[project.nodes.length - 1];
    const targetNode = createNode({
      type: "config",
      kind: "workflow",
      name: "Generation target frame",
      source: "target-frame",
      x: anchor ? anchor.x + anchor.width + 180 : 760,
      y: anchor ? anchor.y : 360,
      width: 320,
      height: 320,
      generation: {
        prompt: "在这个目标框中生成新的图片结果。",
        modelId: "gpt-image-2-medium",
        outputCount: 1,
        entryPoint: "workflow"
      },
      metadata: { targetFrame: true, aspectRatio: "1:1" }
    });
    return withUndo(project, {
      nodes: [...project.nodes, targetNode],
      connections: anchor ? [...project.connections, connect(anchor.id, targetNode.id)] : project.connections,
      selectedNodeIds: [targetNode.id]
    });
  });
}

export function saveNodeAsAsset(workspace: Workspace, projectId: string, nodeId: string): Workspace {
  const node = findNode(findProject(workspace, projectId), nodeId);
  const asset: LibraryAsset = {
    id: createId("asset"),
    type: node.type === "text" ? "text" : "image",
    title: node.name,
    source: node.source,
    tags: node.type === "text" ? ["prompt"] : ["canvas"],
    createdAt: now(),
    metadata: { projectId, nodeId, width: node.width, height: node.height }
  };
  return { ...workspace, assets: [asset, ...workspace.assets] };
}

function promptTitleFrom(content: string) {
  const firstLine = content.trim().split(/\r?\n/)[0] ?? "Saved prompt";
  if (!firstLine) return "Saved prompt";
  if (firstLine.length <= 42) return firstLine;
  const truncated = firstLine.slice(0, 42).replace(/\s+\S*$/, "").trim();
  return `${truncated || firstLine.slice(0, 39).trim()}...`;
}

export function savePromptPreset(
  workspace: Workspace,
  input: { title?: string; prompt: string; tags?: string[]; source?: PromptPreset["source"] }
): Workspace {
  const prompt = input.prompt.trim();
  if (!prompt) throw new Error("Prompt is required");
  const title = input.title?.trim() || promptTitleFrom(prompt);
  const tags = (input.tags?.length ? input.tags : ["designer"])
    .map((tag) => tag.trim().toLowerCase())
    .filter(Boolean);
  const preset: PromptPreset = {
    id: createId("prompt"),
    title,
    prompt,
    tags: Array.from(new Set(tags)),
    source: input.source ?? "designer",
    userId: workspace.profile.userId,
    designerName: workspace.profile.designerName,
    createdAt: now()
  };
  return { ...workspace, prompts: [preset, ...workspace.prompts] };
}

export function deletePromptPreset(workspace: Workspace, promptId: string): Workspace {
  return { ...workspace, prompts: workspace.prompts.filter((prompt) => prompt.id !== promptId) };
}
