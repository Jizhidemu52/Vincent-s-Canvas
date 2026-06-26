import {
  Archive,
  BadgeDollarSign,
  BookOpenText,
  BoxSelect,
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
  Play,
  Plus,
  RotateCcw,
  Scissors,
  Search,
  Shirt,
  Sparkles,
  SquareDashedMousePointer,
  Trash2,
  Undo2,
  Upload,
  UserRound,
  Wand2,
  ZoomIn,
  ZoomOut
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type PointerEvent, type WheelEvent } from "react";
import {
  addAssetToProjectAt,
  addAssetToProject,
  addTextNode,
  addGenerationTargetFrame,
  applyBatchGenerationResultsToCanvas,
  applyGenerationResultToCanvas,
  commitShapeEdit,
  configureNodeGeneration,
  copyPasteSelectedNodes,
  createInitialWorkspace,
  createProject,
  createWorkflowModuleFromSelection,
  deleteSelectedNodes,
  importBatchFolder,
  mergeReferenceSelection,
  redoProject,
  runBatchQueue,
  saveNodeAsAsset,
  selectNodes,
  undoProject,
  updateNodeTransform,
  updateViewport,
  type BatchImport,
  type CanvasNode,
  type GenerationResult,
  type LibraryAsset,
  type OperationType,
  type ModuleType,
  type NodeTransform,
  type Project,
  type Workspace
} from "./domain/workspace";
import { fetchBackendSnapshot, fetchWorkspaceSnapshot, saveWorkspaceSnapshot, submitGenerationRequest } from "./services/modelApi";

const TEST_IMAGE = "/fixtures/fashion-reference.jpg";
const SECOND_TEST_IMAGE = "/fixtures/fashion-reference.jpg";

type ViewMode = "login" | "home" | "canvas" | "admin";
type DragMode = "move" | "resize";
type ShapeEditDraft = { nodeId: string; shape: "ellipse" | "rectangle" | "freehand"; prompt: string } | null;
type HomeSection = "Projects" | "History" | "Profile";
type RightPanel = "context" | "history" | "assets" | "prompts" | "assistant";

function readFileAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function createWorkspace() {
  return createInitialWorkspace({ userId: "designer-lina", designerName: "Lina Zhou", creditBalance: 180, role: "designer" });
}

function operationForNode(node: CanvasNode): OperationType {
  if (node.operation) return node.operation;
  if (node.moduleType === "upscale") return "upscale";
  if (node.moduleType === "removeBackground") return "removeBackground";
  if (node.moduleType === "edit") return "edit";
  if (node.type === "upscale") return "upscale";
  if (node.type === "removeBg") return "removeBackground";
  if (node.type === "edit") return "edit";
  return "generate";
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
  function openProject(projectId: string) {
    setWorkspace((current) => ({ ...current, activeProjectId: projectId }));
    setView("canvas");
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
      const result = await submitGenerationRequest(request, activeUserId);
      const serverState = await fetchBackendSnapshot(activeUserId);
      setWorkspace((current) => applyGenerationResultToCanvas(current, projectId, source.id, request, result, serverState));
      setRightPanel("history");
      setApiNotice(`Backend ${operation} succeeded, ${result.creditCost} credits used`);
    } catch (error) {
      setApiNotice(error instanceof Error ? error.message : "Backend request failed");
    }
  }

  function runSelectedGeneration() {
    void generateNodeThroughApi();
  }

  function runImageOperation(operation: "upscale" | "removeBackground") {
    if (!selectedNode) return;
    void generateNodeThroughApi(selectedNode.id, {
      operation,
      modelId: operation === "upscale" ? "upscale-pro" : "background-cleaner",
      prompt:
        operation === "upscale"
          ? "Upscale this image while preserving garment construction, embroidery, fabric texture and clean product lighting."
          : "",
      outputCount: 1
    });
  }

  function addWorkflowModule(moduleType: ModuleType) {
    if (!activeProject || !selectedNode) return;
    const prompt =
      moduleType === "upscale"
        ? "高清放大，保留服装纤维、刺绣和边缘细节。"
        : moduleType === "edit"
          ? "在保持模特姿势和版型不变的前提下，做局部款式编辑。"
          : "参考上游图片和文本，生成新的服装设计方案。";
    const modelId = moduleType === "upscale" ? "upscale-pro" : selectedNode.generation.modelId || "gpt-image-2-medium";
    setWorkspace((current) =>
      createWorkflowModuleFromSelection(current, activeProject.id, activeProject.selectedNodeIds.length ? activeProject.selectedNodeIds : [selectedNode.id], {
        moduleType,
        prompt,
        modelId
      })
    );
  }
  function connectSelectionToNewModule(moduleType: ModuleType) {
    addWorkflowModule(moduleType);
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
    let cursorId = selectedNode.id;
    const visited = new Set<string>();
    let executed = 0;
    try {
      setApiNotice("Running backend workflow chain...");
      while (!visited.has(cursorId)) {
        visited.add(cursorId);
        const connection = activeProject.connections.find((item) => item.fromNodeId === cursorId);
        if (!connection) break;
        const nextNode = activeProject.nodes.find((node) => node.id === connection.toNodeId);
        if (!nextNode) break;
        const isExecutable =
          nextNode.kind === "workflow" ||
          nextNode.type === "config" ||
          nextNode.type === "edit" ||
          nextNode.type === "upscale" ||
          nextNode.type === "removeBg";
        if (!isExecutable) {
          cursorId = nextNode.id;
          continue;
        }
        const operation = operationForNode(nextNode);
        const request = {
          projectId,
          nodeId: nextNode.id,
          modelId: nextNode.generation.modelId,
          prompt: nextNode.generation.prompt,
          referenceNodeIds: nextNode.references.length ? nextNode.references : [cursorId],
          outputCount: nextNode.generation.outputCount,
          operation
        };
        const result = await submitGenerationRequest(request, activeUserId);
        const serverState = await fetchBackendSnapshot(activeUserId);
        setWorkspace((current) => applyGenerationResultToCanvas(current, projectId, nextNode.id, request, result, serverState));
        executed += 1;
        cursorId = nextNode.id;
      }
      setRightPanel("history");
      setApiNotice(executed ? `Backend workflow completed ${executed} module${executed > 1 ? "s" : ""}` : "No downstream workflow modules");
    } catch (error) {
      setApiNotice(error instanceof Error ? error.message : "Backend workflow failed");
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
    try {
      setApiNotice(`Running backend batch for ${batch.files.length} images...`);
      const results: GenerationResult[] = [];
      for (const [index, file] of batch.files.entries()) {
        const result = await submitGenerationRequest({
          projectId,
          nodeId: `batch-${file.name}-${index + 1}`,
          modelId: batch.modelId,
          prompt: batch.prompt,
          referenceNodeIds: [file.name],
          outputCount: batch.outputCount,
          operation: batch.modelId === "background-cleaner" ? "removeBackground" : "generate"
        }, activeUserId);
        results.push(result);
      }
      const serverState = await fetchBackendSnapshot(activeUserId);
      setWorkspace((current) => applyBatchGenerationResultsToCanvas(current, projectId, batch, results, serverState));
      setRightPanel("history");
      setApiNotice(`Backend batch completed for ${batch.files.length} images`);
    } catch (error) {
      setApiNotice(error instanceof Error ? error.message : "Backend batch failed");
    }
  }
  function shapeEdit() {
    if (!activeProject || !selectedNode) return;
    setShapeEditDraft({
      nodeId: selectedNode.id,
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
        prompt: editDraft.prompt
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
      operation: "edit" as OperationType
    };
    try {
      setApiNotice("Running backend mask edit...");
      const result = await submitGenerationRequest(request, activeUserId);
      const serverState = await fetchBackendSnapshot(activeUserId);
      setWorkspace((current) => applyGenerationResultToCanvas(current, projectId, source.id, request, result, serverState));
      setRightPanel("history");
      setApiNotice(`Backend mask edit succeeded, ${result.creditCost} credits used`);
    } catch (error) {
      setApiNotice(error instanceof Error ? error.message : "Backend mask edit failed");
    }
  }
  function saveAsset() {
    if (!activeProject || !selectedNode) return;
    setWorkspace((current) => saveNodeAsAsset(current, activeProject.id, selectedNode.id));
    setRightPanel("assets");
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
        onImportImages={importImagePair}
        onGenerate={runSelectedGeneration}
        onGenerateNode={(nodeId) => void generateNodeThroughApi(nodeId)}
        onBatch={runBackendBatch}
        onWorkflow={runWorkflow}
        onAddModule={addWorkflowModule}
        onConnectModule={connectSelectionToNewModule}
        onGroupReferences={groupReferences}
        onAssistantNote={insertAssistantNote}
        onUpscale={() => runImageOperation("upscale")}
        onRemoveBg={() => runImageOperation("removeBackground")}
        onShapeEdit={shapeEdit}
        onSaveAsset={saveAsset}
        onInsertAsset={insertAssetIntoCanvas}
        onAddTargetFrame={() => setWorkspace((current) => addGenerationTargetFrame(current, activeProject.id))}
      />
    );
  }

  if (view === "admin") {
    return <AdminView workspace={workspace} onBack={() => setView("home")} />;
  }

  if (view === "login") {
    return <LoginView onLogin={login} />;
  }

  return <HomeView workspace={workspace} onCreateProject={openNewProject} onOpenProject={openProject} onAdmin={() => setView("admin")} />;
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
  onAdmin
}: {
  workspace: Workspace;
  onCreateProject: () => void;
  onOpenProject: (projectId: string) => void;
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
        {activeSection === "Projects" && <ProjectsPanel projects={projectCards} onCreateProject={onCreateProject} onOpenProject={onOpenProject} />}
        {activeSection === "History" && <HistoryPanel workspace={workspace} onOpenProject={onOpenProject} />}
        {activeSection === "Profile" && <ProfilePanel workspace={workspace} />}
      </section>
    </main>
  );
}

function ProjectsPanel({
  projects,
  onCreateProject,
  onOpenProject
}: {
  projects: Project[];
  onCreateProject: () => void;
  onOpenProject: (projectId: string) => void;
}) {
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
          <button type="button" className="project-card" key={project.id} onClick={() => onOpenProject(project.id)}>
            <div className="project-thumb">
              {project.nodes[0]?.source ? <img src={project.nodes[0].source} alt="" /> : <span>No images</span>}
            </div>
            <strong>{project.name}</strong>
            <small>{project.nodes.length} nodes · modified just now</small>
          </button>
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

function HistoryPanel({ workspace, onOpenProject }: { workspace: Workspace; onOpenProject: (projectId: string) => void }) {
  const generatedNodes = workspace.projects.flatMap((project) =>
    project.nodes
      .filter((node) => node.kind === "generated" || node.kind === "edit" || node.kind === "operation")
      .map((node) => ({ project, node }))
  );
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
                  <button type="button" onClick={() => project && onOpenProject(project.id)} disabled={!project}>
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
              <button type="button" key={node.id} className="history-thumb" onClick={() => onOpenProject(project.id)}>
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
  const usagePercent = Math.min(100, Math.round((workspace.profile.creditUsed / Math.max(1, workspace.profile.creditUsed + workspace.profile.creditBalance)) * 100));
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
          <small>{workspace.profile.creditUsed} credits used</small>
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

function AdminView({ workspace, onBack }: { workspace: Workspace; onBack: () => void }) {
  const totalNodes = workspace.projects.reduce((sum, project) => sum + project.nodes.length, 0);
  const totalConnections = workspace.projects.reduce((sum, project) => sum + project.connections.length, 0);
  const runningJobs = workspace.projects.reduce((sum, project) => sum + project.nodes.filter((node) => node.status === "running").length, 0);
  const providers = workspace.modelRegistry.reduce<Record<string, number>>((memo, model) => {
    memo[model.provider] = (memo[model.provider] ?? 0) + 1;
    return memo;
  }, {});

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
          <MetricCard label="Credits used" value={workspace.profile.creditUsed} detail={`${workspace.profile.creditBalance} remaining`} />
          <MetricCard label="Running jobs" value={runningJobs} detail={`${workspace.history.length} history entries`} />
        </section>
        <section className="admin-grid">
          <article className="admin-card">
            <h2>Model providers</h2>
            {Object.entries(providers).map(([provider, count]) => (
              <div className="admin-row" key={provider}>
                <span>{provider}</span>
                <strong>{count} models</strong>
                <small>healthy · backend hosted</small>
              </div>
            ))}
          </article>
          <article className="admin-card">
            <h2>Recent audit</h2>
            {workspace.history.length ? (
              workspace.history.slice(0, 6).map((entry) => (
                <div className="admin-row" key={entry.id}>
                  <span>{entry.modelId}</span>
                  <strong>{entry.creditCost} credits</strong>
                  <small>{entry.prompt}</small>
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
              <small>{workspace.profile.userId}</small>
            </div>
          </article>
        </section>
      </section>
    </main>
  );
}

function MetricCard({ label, value, detail }: { label: string; value: number; detail: string }) {
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
  onImportImages,
  onGenerate,
  onGenerateNode,
  onBatch,
  onWorkflow,
  onAddModule,
  onConnectModule,
  onGroupReferences,
  onAssistantNote,
  onUpscale,
  onRemoveBg,
  onShapeEdit,
  onSaveAsset,
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
  onImportImages: () => void;
  onGenerate: () => void;
  onGenerateNode: (nodeId: string) => void;
  onBatch: () => void;
  onWorkflow: () => void;
  onAddModule: (moduleType: ModuleType) => void;
  onConnectModule: (moduleType: ModuleType) => void;
  onGroupReferences: () => void;
  onAssistantNote: (content: string) => void;
  onUpscale: () => void;
  onRemoveBg: () => void;
  onShapeEdit: () => void;
  onSaveAsset: () => void;
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
      />
      <section className="recraft-canvas">
        <PromptCard
          workspace={workspace}
          selectedNode={selectedNode}
          apiNotice={apiNotice}
          onUpdateConfig={onUpdateConfig}
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
          selectedNode={selectedNode}
          onUpscale={onUpscale}
          onRemoveBg={onRemoveBg}
          onShapeEdit={onShapeEdit}
          onSaveAsset={onSaveAsset}
          onGroupReferences={onGroupReferences}
        />
        <RightDock
          workspace={workspace}
          project={project}
          panel={rightPanel}
          stats={stats}
          onPanel={onRightPanel}
          onAddModule={onAddModule}
          onPromptInsert={(prompt) => onUpdateConfig({ prompt })}
          onAssetInsert={onInsertAsset}
          onAssistantNote={onAssistantNote}
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
  onShapeEdit
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
        <button type="button"><Scissors size={14} /> Remove bg</button>
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

function PromptCard({
  workspace,
  selectedNode,
  apiNotice,
  onUpdateConfig,
  onGenerate,
  onBatch,
  onBatchFiles,
  onPromptInsert
}: {
  workspace: Workspace;
  selectedNode?: CanvasNode;
  apiNotice: string;
  onUpdateConfig: (patch: Partial<CanvasNode["generation"]>) => void;
  onGenerate: () => void;
  onBatch: () => void;
  onBatchFiles: (files: FileList | null) => void;
  onPromptInsert: (prompt: string) => void;
}) {
  const batchInputRef = useRef<HTMLInputElement | null>(null);
  const groups = Array.from(new Set(workspace.modelRegistry.map((model) => model.group)));
  return (
    <aside className="prompt-card">
      <div className="prompt-title">
        <span>IMAGE</span>
        <small>W {selectedNode?.width ?? 0}</small>
        <small>H {selectedNode?.height ?? 0}</small>
        <small>r {selectedNode?.transform.rotation ?? 0}</small>
      </div>
      <label className="model-row">
        <Sparkles size={18} />
        <span>
          <small>Model</small>
          <select
            aria-label="Model"
            value={selectedNode?.generation.modelId ?? "gpt-image-2-medium"}
            onChange={(event) => onUpdateConfig({ modelId: event.target.value })}
          >
            {groups.map((group) => (
              <optgroup key={group} label={group}>
                {workspace.modelRegistry.filter((model) => model.group === group).map((model) => (
                  <option key={model.id} value={model.id}>{model.name}</option>
                ))}
              </optgroup>
            ))}
          </select>
        </span>
      </label>
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
          max={4}
          value={selectedNode?.generation.outputCount ?? 1}
          onChange={(event) => onUpdateConfig({ outputCount: Number(event.target.value) })}
        />
      </div>
      <button type="button" className="generate-button" onClick={onGenerate}>Generate</button>
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
  onConnectModule: (moduleType: ModuleType) => void;
  onGenerateNode: (nodeId: string) => void;
}) {
  const stageRef = useRef<HTMLElement | null>(null);
  const [lasso, setLasso] = useState<{ x: number; y: number; width: number; height: number } | null>(null);
  const selectedIds = project.selectedNodeIds;
  const selectedSet = new Set(selectedIds);

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

  function panCanvas(event: PointerEvent<HTMLElement>) {
    if (event.target !== event.currentTarget) return;
    event.preventDefault();
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
            onSelect={selectNode}
            onWorkspaceChange={onWorkspaceChange}
            onConnectModule={onConnectModule}
            onGenerateNode={onGenerateNode}
            workspace={workspace}
          />
        ))}
      </div>
      {lasso && <div className="lasso" style={lasso} />}
      <ZoomControls workspace={workspace} project={project} onWorkspaceChange={onWorkspaceChange} />
      {project.viewport.minimapOpen && <MiniMap project={project} />}
    </section>
  );
}

function CanvasNodeView({
  projectId,
  node,
  selected,
  highlighted,
  onSelect,
  onWorkspaceChange,
  onConnectModule,
  onGenerateNode,
  workspace
}: {
  projectId: string;
  node: CanvasNode;
  selected: boolean;
  highlighted: boolean;
  onSelect: (id: string, append: boolean) => void;
  onWorkspaceChange: (updater: (workspace: Workspace) => Workspace) => void;
  onConnectModule: (moduleType: ModuleType) => void;
  onGenerateNode: (nodeId: string) => void;
  workspace: Workspace;
}) {
  const isImageLike =
    node.type === "image" ||
    node.type === "batch" ||
    node.type === "imageGroup" ||
    node.kind === "generated" ||
    node.kind === "operation" ||
    node.kind === "edit";
  const isText = node.type === "text";
  const isModule = !isImageLike && !isText;
  const [inlineEditorOpen, setInlineEditorOpen] = useState(false);
  const modelGroups = Array.from(new Set(workspace.modelRegistry.map((model) => model.group)));

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

  function startWire(event: PointerEvent<HTMLSpanElement>) {
    event.stopPropagation();
    event.preventDefault();
    onSelect(node.id, false);
    const handleUp = () => {
      onConnectModule("generate");
      window.removeEventListener("pointerup", handleUp);
    };
    window.addEventListener("pointerup", handleUp);
  }

  return (
    <div
      role="button"
      data-testid="canvas-node"
      tabIndex={0}
      className={`stage-node ${node.type} ${selected ? "selected" : ""} ${highlighted ? "highlighted" : ""}`}
      style={{ left: node.x, top: node.y, width: node.width, minHeight: node.height }}
      onPointerDown={(event) => startPointer(event)}
      onClick={(event) => onSelect(node.id, event.shiftKey || event.ctrlKey || event.metaKey)}
      onDoubleClick={(event) => {
        event.stopPropagation();
        onSelect(node.id, false);
        if (isImageLike) setInlineEditorOpen((current) => !current);
      }}
    >
      <span className="node-label">{isImageLike ? "Image" : isText ? "Text" : node.moduleType ?? node.type}</span>
      {isImageLike && node.type !== "imageGroup" && (
        <>
          <img src={node.source} alt={node.name} style={{ width: node.width, height: node.height }} />
          <strong className="stage-node-name">{node.name}</strong>
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
          <span>{node.references.length} refs</span>
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
          modelGroups={modelGroups}
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
      <span className="node-port input" />
      <span className="node-port output" onPointerDown={startWire} title="Drag to create workflow node" />
    </div>
  );
}

function InlineNodeEditor({
  node,
  modelGroups,
  models,
  onUpdate,
  onGenerate
}: {
  node: CanvasNode;
  modelGroups: string[];
  models: Workspace["modelRegistry"];
  onUpdate: (patch: Partial<CanvasNode["generation"]>) => void;
  onGenerate: () => void;
}) {
  return (
    <div className="inline-node-editor" onPointerDown={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()}>
      <label>
        <span>Model</span>
        <select aria-label="Inline model" value={node.generation.modelId} onChange={(event) => onUpdate({ modelId: event.target.value })}>
          {modelGroups.map((group) => (
            <optgroup key={group} label={group}>
              {models.filter((model) => model.group === group).map((model) => (
                <option key={model.id} value={model.id}>{model.name}</option>
              ))}
            </optgroup>
          ))}
        </select>
      </label>
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
  onGroupReferences
}: {
  selectedNode?: CanvasNode;
  onUpscale: () => void;
  onRemoveBg: () => void;
  onShapeEdit: () => void;
  onSaveAsset: () => void;
  onGroupReferences: () => void;
}) {
  if (!selectedNode) return null;
  return (
    <div className="node-toolbar" aria-label="selected image toolbar">
      <button type="button" title="Upscale" onClick={onUpscale}><Maximize2 size={15} /></button>
      <button type="button" title="Remove background" onClick={onRemoveBg}><Scissors size={15} /></button>
      <button type="button" title="Mask edit" onClick={onShapeEdit}><CircleDashed size={15} /></button>
      <button type="button" title="Group references" onClick={onGroupReferences}><SquareDashedMousePointer size={15} /></button>
      <button type="button" title="Save asset" onClick={onSaveAsset}><Database size={15} /></button>
      <button type="button" title="Download"><Download size={15} /></button>
      <button type="button" title="Magic edit"><Wand2 size={15} /></button>
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
  return (
    <div className="shape-dialog" role="dialog" aria-label="Mask edit confirmation">
      <div className="shape-preview">
        <img src={node.source} alt={node.name} />
        <span className={`shape-overlay ${draft.shape}`} />
      </div>
      <div className="shape-panel">
        <strong>Confirm mask edit</strong>
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
  panel,
  stats,
  onPanel,
  onAddModule,
  onPromptInsert,
  onAssetInsert,
  onAssistantNote
}: {
  workspace: Workspace;
  project: Project;
  panel: RightPanel;
  stats: { images: number; texts: number; modules: number };
  onPanel: (panel: RightPanel) => void;
  onAddModule: (moduleType: ModuleType) => void;
  onPromptInsert: (prompt: string) => void;
  onAssetInsert: (asset: LibraryAsset) => void;
  onAssistantNote: (content: string) => void;
}) {
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
            <button type="button" onClick={() => onAddModule("generate")}><Plus size={13} /> Generate node</button>
            <button type="button" onClick={() => onAddModule("edit")}><Wand2 size={13} /> Edit node</button>
            <button type="button" onClick={() => onAddModule("upscale")}><Maximize2 size={13} /> Upscale node</button>
          </div>
          <small>Workflow modules</small>
        </>
      )}
      {panel === "history" && (
        <div className="dock-list">
          <strong>History</strong>
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
          {workspace.prompts.map((prompt) => (
            <button type="button" key={prompt.id} onClick={() => onPromptInsert(prompt.prompt)}>
              <b>{prompt.title}</b>
              <span>{prompt.tags.join(", ")}</span>
            </button>
          ))}
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
