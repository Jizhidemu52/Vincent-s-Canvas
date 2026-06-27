import { act, createEvent, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { createInitialWorkspace, type GenerationRequest, type HistoryEntry, type Profile, type Workspace } from "./domain/workspace";

let backendProfile: Profile = {
  userId: "designer-lina",
  designerName: "Lina Zhou",
  role: "designer" as const,
  creditBalance: 180,
  creditUsed: 0,
  credits: 180
};
let backendHistory: HistoryEntry[] = [];
let backendWorkspace: Workspace = createInitialWorkspace();

function jsonResponse(payload: unknown, status = 200) {
  return Promise.resolve(
    new Response(JSON.stringify(payload), {
      status,
      headers: { "content-type": "application/json" }
    })
  );
}

beforeEach(() => {
  backendProfile = {
    userId: "designer-lina",
    designerName: "Lina Zhou",
    role: "designer",
    creditBalance: 180,
    creditUsed: 0,
    credits: 180
  };
  backendHistory = [];
  backendWorkspace = {
    ...createInitialWorkspace({ userId: "designer-lina", designerName: "Lina Zhou", creditBalance: 180, role: "designer" }),
    history: backendHistory
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.endsWith("/api/workspace")) {
        if (init?.method === "POST") {
          const snapshot = JSON.parse(String(init.body)) as Workspace;
          backendWorkspace = {
            ...backendWorkspace,
            ...snapshot,
            profile: snapshot.profile ?? backendWorkspace.profile,
            history: snapshot.history ?? backendHistory
          };
          backendProfile = backendWorkspace.profile;
          backendHistory = backendWorkspace.history;
        }
        return jsonResponse({
          profile: backendProfile,
          projects: backendWorkspace.projects,
          activeProjectId: backendWorkspace.activeProjectId,
          history: backendHistory,
          assets: backendWorkspace.assets,
          prompts: backendWorkspace.prompts,
          modelRegistry: backendWorkspace.modelRegistry
        });
      }
      if (url.endsWith("/api/admin/credits")) {
        const headers = init?.headers as Record<string, string> | undefined;
        const adminUserId = headers?.["x-user-id"] ?? "";
        if (!adminUserId.includes("admin")) {
          return jsonResponse({ status: "failed", errorMessage: "Admin role required" }, 400);
        }
        const request = JSON.parse(String(init?.body)) as { targetUserId: string; delta: number; reason?: string };
        const nextBalance = backendProfile.creditBalance + Number(request.delta);
        if (!Number.isInteger(Number(request.delta)) || Number(request.delta) === 0 || nextBalance < 0) {
          return jsonResponse({ status: "failed", errorMessage: "Credit balance cannot be negative" }, 400);
        }
        backendProfile = {
          ...backendProfile,
          userId: request.targetUserId,
          designerName: request.targetUserId.includes("admin") ? "Admin Ops" : request.targetUserId.split("@")[0],
          role: request.targetUserId.includes("admin") ? "admin" : "designer",
          creditBalance: nextBalance,
          credits: nextBalance
        };
        backendWorkspace = { ...backendWorkspace, profile: backendProfile };
        return jsonResponse(backendProfile);
      }
      if (url.endsWith("/api/profile")) return jsonResponse(backendProfile);
      if (url.endsWith("/api/history")) return jsonResponse(backendHistory);
      if (url.endsWith("/api/models")) {
        return jsonResponse([
          { id: "gpt-image-2-medium", name: "GPT Image 2 Medium", provider: "openai", group: "Trending models", capability: ["generate", "edit"], cost: 7 },
          { id: "nanobanana2", name: "Nano Banana 2", provider: "nanobanana", group: "Trending models", capability: ["generate", "edit"], cost: 11 },
          { id: "upscale-pro", name: "Creative Upscale", provider: "internal", group: "Operations", capability: ["upscale"], cost: 4 },
          { id: "background-cleaner", name: "Remove Background", provider: "internal", group: "Operations", capability: ["removeBackground"], cost: 2 }
        ]);
      }
      if (url.endsWith("/api/admin/providers")) {
        return jsonResponse([
          {
            provider: "openai",
            status: "healthy",
            modelCount: 1,
            keyLocation: "server",
            mode: "mock",
            secretConfigured: false,
            adapterId: "openai-image-adapter",
            requiredSecrets: ["OPENAI_API_KEY"],
            configuredSecrets: [],
            missingSecrets: ["OPENAI_API_KEY"],
            supportedOperations: ["generate", "edit"]
          },
          {
            provider: "internal",
            status: "healthy",
            modelCount: 2,
            keyLocation: "server",
            mode: "live-ready",
            secretConfigured: true,
            adapterId: "internal-operations-adapter",
            requiredSecrets: [],
            configuredSecrets: [],
            missingSecrets: [],
            supportedOperations: ["upscale", "removeBackground"]
          }
        ]);
      }
      if (url.endsWith("/api/generations") || url.endsWith("/api/edits") || url.endsWith("/api/upscale") || url.endsWith("/api/remove-bg")) {
        const request = JSON.parse(String(init?.body)) as GenerationRequest;
        const unitCost = request.modelId === "nanobanana2" ? 11 : request.modelId === "upscale-pro" ? 4 : request.modelId === "background-cleaner" ? 2 : 7;
        const creditCost = unitCost * request.outputCount;
        backendProfile = {
          ...backendProfile,
          creditBalance: backendProfile.creditBalance - creditCost,
          creditUsed: backendProfile.creditUsed + creditCost,
          credits: backendProfile.creditBalance - creditCost
        };
        const historyEntry: HistoryEntry = {
          id: `history-${backendHistory.length + 1}`,
          projectId: request.projectId,
          nodeId: request.nodeId,
          prompt: request.prompt,
          modelId: request.modelId,
          outputCount: request.outputCount,
          creditCost,
          operation: request.operation,
          referenceCount: request.referenceNodeIds.length,
          createdAt: new Date().toISOString()
        };
        backendHistory = [historyEntry, ...backendHistory];
        return jsonResponse({
          status: "succeeded",
          creditCost,
          historyId: historyEntry.id,
          outputs: Array.from({ length: request.outputCount }, (_, index) => ({
            name: `backend result ${index + 1}.jpg`,
            source: `mock://${request.operation}/${request.nodeId}/${index + 1}`,
            width: 1024,
            height: 1024
          }))
        });
      }
      return jsonResponse({ status: "failed", errorMessage: "Route not found" }, 404);
    })
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function login(user: ReturnType<typeof userEvent.setup>) {
  render(<App />);
  expect(screen.getByText("登录 Canvas Ops")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "登录" }));
}

describe("Designer canvas app shell", () => {
  it("shows account, history, and project management before opening the canvas", async () => {
    const user = userEvent.setup();
    await login(user);

    expect(screen.getByText("Profile")).toBeInTheDocument();
    expect(screen.getAllByText("Projects").length).toBeGreaterThan(0);
    expect(screen.getAllByText("History").length).toBeGreaterThan(0);
    expect(screen.getByText("Designer credits")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New project" })).toBeInTheDocument();
    expect(screen.queryByText("IMAGE")).not.toBeInTheDocument();
    expect(screen.queryByText("Context panel")).not.toBeInTheDocument();
  });

  it("opens the Recraft-like infinite canvas only after a project is created", async () => {
    const user = userEvent.setup();
    await login(user);

    await user.click(screen.getByRole("button", { name: "New project" }));

    expect(screen.getByText("IMAGE")).toBeInTheDocument();
    expect(screen.getByText("Context panel")).toBeInTheDocument();
    expect(screen.getByText("Batch mode")).toBeInTheDocument();
    expect(screen.getByText("Workflow modules")).toBeInTheDocument();
    expect(screen.getByText("fashion-reference.jpg")).toBeInTheDocument();
  });

  it("autosaves created project workspaces to the backend snapshot", async () => {
    const user = userEvent.setup();
    await login(user);

    await user.click(screen.getByRole("button", { name: "New project" }));

    await waitFor(() => {
      const workspaceSaves = vi.mocked(fetch).mock.calls.filter(([url, init]) => url.toString().endsWith("/api/workspace") && init?.method === "POST");
      const latestSave = workspaceSaves[workspaceSaves.length - 1];
      expect(latestSave).toBeTruthy();
      expect(latestSave?.[1]?.headers).toMatchObject({ "x-user-id": "admin@company.local" });
      const body = JSON.parse(String(latestSave?.[1]?.body)) as Workspace;
      expect(body.projects.length).toBeGreaterThan(0);
      expect(body.activeProjectId).toBe(body.projects[0].id);
      expect(body.projects[0].nodes.some((node) => node.name === "fashion-reference.jpg")).toBe(true);
    });
  });

  it("supports reference uploads, model prompt controls, and right dock panels after entering canvas", async () => {
    const user = userEvent.setup();
    await login(user);

    await user.click(screen.getByRole("button", { name: "New project" }));
    await user.click(screen.getByRole("button", { name: /Upload images/i }));

    expect(screen.getByText("reference-front.jpg")).toBeInTheDocument();
    expect(screen.getByText("reference-texture.jpg")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Model GPT Image 2 Medium/i })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Prompts" }));
    const promptButtons = screen.getAllByRole("button", { name: /局部服装改款/i });
    await user.click(promptButtons[promptButtons.length - 1]);
    expect(screen.getByPlaceholderText(/\[TARGET\]/)).toHaveValue("只修改选区内的服装细节，保持模特姿势、背景、光线和版型不变。");

    await user.click(screen.getByRole("button", { name: "Context" }));
    expect(screen.getByText("Generate node")).toBeInTheDocument();
    expect(screen.getByText("Workflow modules")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Assistant" }));
    expect(screen.getByText("Two-reference concept")).toBeInTheDocument();
    await user.click(screen.getAllByRole("button", { name: "Use as prompt" })[0]);
    expect((screen.getByPlaceholderText(/\[TARGET\]/) as HTMLTextAreaElement).value).toContain("Use the selected references");
    const nodeCount = screen.getAllByTestId("canvas-node").length;
    await user.click(screen.getAllByRole("button", { name: "Add note node" })[0]);
    await waitFor(() => {
      expect(screen.getAllByTestId("canvas-node").length).toBeGreaterThan(nodeCount);
    });
  });

  it("opens grouped Recraft-style model menus from the prompt panel and inline image editor", async () => {
    const user = userEvent.setup();
    await login(user);

    await user.click(screen.getByRole("button", { name: "New project" }));
    await user.click(screen.getByText("fashion-reference.jpg"));
    await user.click(screen.getByRole("button", { name: /Model GPT Image 2 Medium/i }));

    expect(screen.getByRole("listbox", { name: "Model options" })).toBeInTheDocument();
    expect(screen.getByText("Trending models")).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /Nano Banana 2.*11 credits.*generate.*edit/i })).toBeInTheDocument();
    await user.click(screen.getByRole("option", { name: /Nano Banana 2.*11 credits/i }));
    expect(screen.getByRole("button", { name: /Model Nano Banana 2/i })).toBeInTheDocument();

    await user.dblClick(screen.getByText("fashion-reference.jpg"));
    await user.click(screen.getByRole("button", { name: /Inline model Nano Banana 2/i }));
    expect(screen.getByRole("listbox", { name: "Inline model options" })).toBeInTheDocument();
    await user.click(screen.getByRole("option", { name: /Flux Pro.*6 credits/i }));
    expect(screen.getByRole("button", { name: /Inline model Flux Pro/i })).toBeInTheDocument();
  });

  it("lets designers drag and resize image nodes on the infinite canvas", async () => {
    const user = userEvent.setup();
    await login(user);

    await user.click(screen.getByRole("button", { name: "New project" }));
    const imageNode = screen.getByRole("button", { name: /Image fashion-reference\.jpg/i });
    const dispatchPointer = (target: EventTarget, type: string, clientX: number, clientY: number) => {
      target.dispatchEvent(
        new MouseEvent(type, {
          bubbles: true,
          cancelable: true,
          clientX,
          clientY
        })
      );
    };
    const initialLeft = Number.parseInt(imageNode.style.left, 10);
    const initialTop = Number.parseInt(imageNode.style.top, 10);
    const initialWidth = Number.parseInt(imageNode.style.width, 10);

    await act(async () => {
      dispatchPointer(imageNode, "pointerdown", 700, 220);
      dispatchPointer(window, "pointermove", 748, 260);
      dispatchPointer(window, "pointerup", 748, 260);
    });
    await waitFor(() => {
      expect(imageNode).toHaveStyle({ left: `${initialLeft + 48}px`, top: `${initialTop + 40}px` });
    });

    const resizeHandle = screen.getByLabelText("Resize image");
    await act(async () => {
      dispatchPointer(resizeHandle, "pointerdown", 1000, 650);
      dispatchPointer(window, "pointermove", 1060, 710);
      dispatchPointer(window, "pointerup", 1060, 710);
    });
    await waitFor(() => {
      expect(imageNode).toHaveStyle({ width: `${initialWidth + 60}px` });
    });
  });

  it("imports externally dropped image files onto the canvas at the drop point", async () => {
    const user = userEvent.setup();
    await login(user);

    await user.click(screen.getByRole("button", { name: "New project" }));
    const stage = screen.getByRole("region", { name: "Infinite canvas" });
    const front = new File(["front reference"], "dropped-front.png", { type: "image/png" });
    const texture = new File(["texture reference"], "dropped-texture.png", { type: "image/png" });

    fireEvent.dragOver(stage, {
      dataTransfer: { files: [front, texture], dropEffect: "move" }
    });
    const dropEvent = createEvent.drop(stage, {
      dataTransfer: { files: [front, texture], dropEffect: "copy" }
    });
    Object.defineProperties(dropEvent, {
      clientX: { value: 320 },
      clientY: { value: 280 }
    });
    fireEvent(stage, dropEvent);

    expect(await screen.findByText("dropped-front.png")).toBeInTheDocument();
    expect(await screen.findByText("dropped-texture.png")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Image dropped-front.png" })).toHaveStyle({ left: "320px", top: "280px" });
    expect(screen.getByRole("button", { name: "Image dropped-texture.png" })).toHaveStyle({ left: "356px", top: "316px" });
    expect(document.querySelector(".stage-node.selected")).toHaveTextContent("dropped-texture.png");
  });

  it("pastes image files into the active canvas as new selectable image nodes", async () => {
    const user = userEvent.setup();
    await login(user);

    await user.click(screen.getByRole("button", { name: "New project" }));
    const stage = screen.getByRole("region", { name: "Infinite canvas" });
    const pasted = new File(["pasted reference"], "pasted-look.png", { type: "image/png" });

    stage.focus();
    fireEvent.paste(stage, {
      clipboardData: { files: [pasted] }
    });

    expect(await screen.findByText("pasted-look.png")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Image pasted-look.png" })).toHaveStyle({ left: "640px", top: "360px" });
    expect(document.querySelector(".stage-node.selected")).toHaveTextContent("pasted-look.png");
  });

  it("lets designers save, search, insert, and delete prompt presets from the canvas dock", async () => {
    const user = userEvent.setup();
    await login(user);

    await user.click(screen.getByRole("button", { name: "New project" }));
    const promptBox = screen.getByPlaceholderText(/\[TARGET\]/);
    await user.clear(promptBox);
    await user.type(promptBox, "Create a pleated silk vest with tiny tonal embroidery and clean studio lighting.");

    await user.click(screen.getByRole("button", { name: "Prompts" }));
    await user.click(screen.getByRole("button", { name: "Save current prompt" }));

    expect(screen.getByText("Prompt saved to library")).toBeInTheDocument();
    await user.type(screen.getByRole("textbox", { name: "Search prompts" }), "pleated silk");
    expect(screen.getByRole("button", { name: /Prompt note prompt.*pleated silk/i })).toBeInTheDocument();

    await user.clear(promptBox);
    await user.click(screen.getByRole("button", { name: /Prompt note prompt.*pleated silk/i }));
    expect(promptBox).toHaveValue("Create a pleated silk vest with tiny tonal embroidery and clean studio lighting.");

    await user.click(screen.getByRole("button", { name: "Delete prompt Prompt note prompt" }));
    expect(screen.queryByRole("button", { name: /Prompt note prompt.*pleated silk/i })).not.toBeInTheDocument();
  });

  it("runs batch mode and writes visible generation history", async () => {
    const user = userEvent.setup();
    await login(user);

    await user.click(screen.getByRole("button", { name: "New project" }));
    await user.type(screen.getByPlaceholderText(/\[TARGET\]/), "统一去背并保持服装边缘清晰");
    await user.click(screen.getByRole("button", { name: "Batch mode" }));
    expect((await screen.findAllByText("backend result 1.jpg")).length).toBeGreaterThan(0);
    await user.click(screen.getByRole("button", { name: "History" }));

    expect(screen.getAllByText(/background-cleaner/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/credits/i).length).toBeGreaterThan(0);
    const calls = vi.mocked(fetch).mock.calls.filter(([url]) => url.toString().endsWith("/api/remove-bg"));
    expect(calls).toHaveLength(3);

    await user.click(screen.getByRole("button", { name: "Assets" }));
    expect(screen.getByText("My assets")).toBeInTheDocument();
    const existingCanvasNodes = screen.getAllByTestId("canvas-node").length;
    await user.click(screen.getAllByRole("button", { name: /backend result 1\.jpg.*Use in canvas/i })[0]);
    await waitFor(() => {
      expect(screen.getAllByTestId("canvas-node").length).toBeGreaterThan(existingCanvasNodes);
    });
  });

  it("imports a batch folder and processes every selected image with the same prompt", async () => {
    const user = userEvent.setup();
    await login(user);

    await user.click(screen.getByRole("button", { name: "New project" }));
    const promptBox = screen.getByPlaceholderText(/\[TARGET\]/);
    await user.clear(promptBox);
    await user.type(promptBox, "Apply one consistent showroom cleanup to every imported garment image.");
    const folderInput = screen.getByLabelText("Batch folder input");
    const first = new File(["front look"], "folder-front.png", { type: "image/png" });
    const second = new File(["back look"], "folder-back.png", { type: "image/png" });

    await user.upload(folderInput, [first, second]);

    expect(await screen.findByText("Backend batch completed for 2 images")).toBeInTheDocument();
    expect((await screen.findAllByText("backend result 1.jpg")).length).toBeGreaterThanOrEqual(2);
    const calls = vi.mocked(fetch).mock.calls.filter(([url]) => url.toString().endsWith("/api/generations"));
    expect(calls).toHaveLength(2);
    const requests = calls.map(([, init]) => JSON.parse(String(init?.body)) as GenerationRequest);
    expect(requests.map((request) => request.referenceNodeIds[0])).toEqual(["folder-front.png", "folder-back.png"]);
    expect(requests.every((request) => request.prompt === "Apply one consistent showroom cleanup to every imported garment image.")).toBe(true);

    await user.click(screen.getByRole("button", { name: "History" }));
    expect(screen.getAllByText(/Apply one consistent showroom cleanup/i).length).toBeGreaterThanOrEqual(2);
    await user.click(screen.getByRole("button", { name: "Assets" }));
    expect(screen.getAllByRole("button", { name: /backend result 1\.jpg.*Use in canvas/i }).length).toBeGreaterThanOrEqual(2);
  });

  it("opens admin monitoring for an admin session", async () => {
    const user = userEvent.setup();
    await login(user);

    await user.click(screen.getByRole("button", { name: /Admin monitoring/i }));

    expect(screen.getByRole("heading", { name: "Admin monitoring" })).toBeInTheDocument();
    expect(screen.getByText("Model providers")).toBeInTheDocument();
    expect(await screen.findByText(/openai-image-adapter/i)).toBeInTheDocument();
    expect(screen.getByText(/missing: OPENAI_API_KEY/i)).toBeInTheDocument();
    expect(screen.getByText("Access policy")).toBeInTheDocument();
    expect(screen.getByText("Server only")).toBeInTheDocument();
    expect(screen.getByText("Credit management")).toBeInTheDocument();

    await user.clear(screen.getByRole("spinbutton", { name: "Credit delta" }));
    await user.type(screen.getByRole("spinbutton", { name: "Credit delta" }), "20");
    await user.click(screen.getByRole("button", { name: "Update credits" }));

    expect(await screen.findByText("Admin Ops now has 200 credits")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Back to projects" }));
    await user.click(screen.getByRole("button", { name: "Profile" }));
    expect(screen.getByRole("region", { name: "Profile credit management" })).toHaveTextContent("200");
  });

  it("supports the image node inline model/prompt entry and generation loop", async () => {
    const user = userEvent.setup();
    await login(user);

    await user.click(screen.getByRole("button", { name: "New project" }));
    await user.dblClick(screen.getByText("fashion-reference.jpg"));
    await user.click(screen.getByRole("button", { name: /Inline model GPT Image 2 Medium/i }));
    await user.click(screen.getByRole("option", { name: /Nano Banana 2.*11 credits/i }));
    await user.type(screen.getByRole("textbox", { name: "Inline prompt" }), "参考这张图做一件新的刺绣背心");
    const generateButtons = screen.getAllByRole("button", { name: "Generate" });
    await user.click(generateButtons[generateButtons.length - 1]);

    expect(await screen.findByText("backend result 1.jpg")).toBeInTheDocument();
    expect(screen.getByText("Done")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "History" }));
    expect(screen.getByText(/nanobanana2/i)).toBeInTheDocument();
    expect(screen.getAllByText(/参考这张图做一件新的刺绣背心/).length).toBeGreaterThan(0);
    expect(fetch).toHaveBeenCalledWith(expect.stringMatching(/\/api\/generations$/), expect.objectContaining({ method: "POST" }));
  });

  it("keeps a failed backend generation visible on the source canvas node", async () => {
    const originalFetch = vi.mocked(fetch).getMockImplementation();
    vi.mocked(fetch).mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.endsWith("/api/generations")) {
        return jsonResponse({ status: "failed", errorMessage: "Provider unavailable" }, 500);
      }
      return originalFetch?.(input, init) ?? jsonResponse({ status: "failed", errorMessage: "Route not found" }, 404);
    });
    const user = userEvent.setup();
    await login(user);

    await user.click(screen.getByRole("button", { name: "New project" }));
    await user.dblClick(screen.getByText("fashion-reference.jpg"));
    await user.type(screen.getByRole("textbox", { name: "Inline prompt" }), "Make a new embroidered vest");
    const generateButtons = screen.getAllByRole("button", { name: "Generate" });
    await user.click(generateButtons[generateButtons.length - 1]);

    expect(await screen.findByText("Error")).toBeInTheDocument();
    expect(screen.getAllByText("Provider unavailable").length).toBeGreaterThan(0);
    expect(screen.queryByText("backend result 1.jpg")).not.toBeInTheDocument();
  });

  it("confirms mask edits, creates target frames, and keeps them visible on canvas", async () => {
    const user = userEvent.setup();
    await login(user);

    await user.click(screen.getByRole("button", { name: "New project" }));
    await user.click(screen.getByText("fashion-reference.jpg"));
    await user.click(screen.getByRole("button", { name: /Edit area/i }));
    expect(screen.getByRole("dialog", { name: "Mask edit confirmation" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "rectangle" }));
    expect(screen.getByRole("application", { name: "Mask placement preview" })).toBeInTheDocument();
    fireEvent.change(screen.getByRole("slider", { name: "Mask size" }), { target: { value: "60" } });
    expect(screen.getByLabelText("Mask coordinates")).toHaveTextContent("w 60");
    await user.click(screen.getByRole("button", { name: "Confirm edit" }));
    expect(screen.getByText("fashion-reference.jpg mask edit")).toBeInTheDocument();
    expect(await screen.findByText("backend result 1.jpg")).toBeInTheDocument();
    expect(screen.getByText("Backend mask edit succeeded, 7 credits used")).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledWith(expect.stringMatching(/\/api\/edits$/), expect.objectContaining({ method: "POST" }));
    const editCall = vi.mocked(fetch).mock.calls.find(([url]) => url.toString().endsWith("/api/edits"));
    const editRequest = JSON.parse(String(editCall?.[1]?.body)) as GenerationRequest;
    expect(editRequest.mask).toMatchObject({ width: 60, height: 52 });

    await user.click(screen.getByRole("button", { name: /Target frame/i }));
    expect(screen.getByText("Generation target frame")).toBeInTheDocument();
    expect(screen.getAllByText("gpt-image-2-medium").length).toBeGreaterThan(0);
  });

  it("runs toolbar upscale through the backend operation API", async () => {
    const user = userEvent.setup();
    await login(user);

    await user.click(screen.getByRole("button", { name: "New project" }));
    await user.click(screen.getByText("fashion-reference.jpg"));
    await user.click(screen.getByRole("button", { name: "Upscale" }));

    expect(await screen.findByText("backend result 1.jpg")).toBeInTheDocument();
    expect(screen.getByText("Backend upscale succeeded, 4 credits used")).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledWith(expect.stringMatching(/\/api\/upscale$/), expect.objectContaining({ method: "POST" }));
  });

  it("wires toolbar download, magic edit, and top remove background actions", async () => {
    const user = userEvent.setup();
    await login(user);

    await user.click(screen.getByRole("button", { name: "New project" }));
    await user.click(screen.getByText("fashion-reference.jpg"));

    let downloadAnchor: HTMLAnchorElement | undefined;
    const createElement = document.createElement.bind(document);
    const createElementSpy = vi.spyOn(document, "createElement").mockImplementation((tagName: string, options?: ElementCreationOptions) => {
      const element = createElement(tagName, options);
      if (tagName === "a") {
        downloadAnchor = element as HTMLAnchorElement;
        vi.spyOn(downloadAnchor, "click").mockImplementation(() => undefined);
      }
      return element;
    });
    try {
      await user.click(screen.getByRole("button", { name: "Download" }));
      expect(downloadAnchor?.download).toBe("fashion-reference.jpg");
      expect(downloadAnchor?.href).toContain("/fixtures/fashion-reference.jpg");
    } finally {
      createElementSpy.mockRestore();
    }

    await user.click(screen.getByRole("button", { name: "Magic edit" }));
    expect(screen.getByRole("dialog", { name: "Mask edit confirmation" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    await user.click(screen.getByRole("button", { name: /Remove bg/i }));
    expect(await screen.findByText("backend result 1.jpg")).toBeInTheDocument();
    expect(screen.getByText("Backend removeBackground succeeded, 2 credits used")).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledWith(expect.stringMatching(/\/api\/remove-bg$/), expect.objectContaining({ method: "POST" }));
  });

  it("runs workflow modules through backend APIs", async () => {
    const user = userEvent.setup();
    await login(user);

    await user.click(screen.getByRole("button", { name: "New project" }));
    await user.click(screen.getByText("fashion-reference.jpg"));
    await user.click(screen.getByRole("button", { name: "Edit node" }));
    await user.click(screen.getByText("fashion-reference.jpg"));
    await user.click(screen.getByRole("button", { name: /Run workflow/i }));

    expect(await screen.findByText("Backend workflow completed 1 module")).toBeInTheDocument();
    expect((await screen.findAllByText("backend result 1.jpg")).length).toBeGreaterThan(0);
    expect(fetch).toHaveBeenCalledWith(expect.stringMatching(/\/api\/edits$/), expect.objectContaining({ method: "POST" }));
  });

  it("opens a workflow module picker from an image output port", async () => {
    const user = userEvent.setup();
    await login(user);

    await user.click(screen.getByRole("button", { name: "New project" }));
    const initialNodeCount = screen.getAllByTestId("canvas-node").length;
    fireEvent.pointerDown(screen.getByLabelText("Create workflow from fashion-reference.jpg"));
    fireEvent.pointerUp(window);

    expect(screen.getByText("Choose module")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Upscale clean high-res output/i }));
    await waitFor(() => {
      expect(screen.getAllByTestId("canvas-node").length).toBeGreaterThan(initialNodeCount);
    });
    expect(screen.getByText("upscale-pro")).toBeInTheDocument();

    await user.click(screen.getByText("fashion-reference.jpg"));
    await user.click(screen.getByRole("button", { name: /Run workflow/i }));
    expect(await screen.findByText("Backend workflow completed 1 module")).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledWith(expect.stringMatching(/\/api\/upscale$/), expect.objectContaining({ method: "POST" }));
  });

  it("chains workflow modules from module output ports and runs them in order", async () => {
    const user = userEvent.setup();
    await login(user);

    await user.click(screen.getByRole("button", { name: "New project" }));
    fireEvent.pointerDown(screen.getByLabelText("Create workflow from fashion-reference.jpg"));
    fireEvent.pointerUp(window);
    await user.click(screen.getByRole("button", { name: /Edit controlled image edit/i }));
    const editModule = await screen.findByRole("button", { name: /Workflow edit module/i });

    fireEvent.pointerDown(screen.getByLabelText("Create workflow from edit module"));
    fireEvent.pointerUp(window);
    await user.click(screen.getByRole("button", { name: /Upscale clean high-res output/i }));
    expect(await screen.findByRole("button", { name: /Workflow upscale module/i })).toBeInTheDocument();

    await user.click(screen.getByText("fashion-reference.jpg"));
    await user.click(screen.getByRole("button", { name: /Run workflow/i }));

    expect(await screen.findByText("Backend workflow completed 2 modules")).toBeInTheDocument();
    const editCalls = vi.mocked(fetch).mock.calls.filter(([url]) => url.toString().endsWith("/api/edits"));
    const upscaleCalls = vi.mocked(fetch).mock.calls.filter(([url]) => url.toString().endsWith("/api/upscale"));
    expect(editCalls).toHaveLength(1);
    expect(upscaleCalls).toHaveLength(1);
    expect(editModule).toHaveTextContent("Done");
  });

  it("keeps multi-selected images as shared references when dragging a workflow port", async () => {
    const user = userEvent.setup();
    await login(user);

    await user.click(screen.getByRole("button", { name: "New project" }));
    await user.click(screen.getByRole("button", { name: /Upload images/i }));
    await user.click(screen.getByText("fashion-reference.jpg"));
    await user.keyboard("{Shift>}");
    await user.click(screen.getByText("reference-front.jpg"));
    await user.keyboard("{/Shift}");
    await waitFor(() => {
      expect(document.querySelectorAll(".stage-node.selected")).toHaveLength(2);
    });

    fireEvent.pointerDown(screen.getByLabelText("Create workflow from fashion-reference.jpg"));
    fireEvent.pointerUp(window);

    expect(screen.getByText("2 references selected")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Generate new design from references/i }));
    expect(screen.getByText("2 refs")).toBeInTheDocument();

    await user.click(screen.getByText("fashion-reference.jpg"));
    await user.click(screen.getByRole("button", { name: /Run workflow/i }));
    await screen.findByText("Backend workflow completed 1 module");

    const generationCall = vi.mocked(fetch).mock.calls.find(([url]) => url.toString().endsWith("/api/generations"));
    const request = JSON.parse(String(generationCall?.[1]?.body)) as GenerationRequest;
    expect(request.referenceNodeIds).toHaveLength(2);
  });

  it("shows generation records and credit usage in the home history and profile views", async () => {
    const user = userEvent.setup();
    await login(user);

    await user.click(screen.getByRole("button", { name: "New project" }));
    await user.dblClick(screen.getByText("fashion-reference.jpg"));
    await user.type(screen.getByRole("textbox", { name: "Inline prompt" }), "生成一款带盘扣的黑色马甲");
    const generateButtons = screen.getAllByRole("button", { name: "Generate" });
    await user.click(generateButtons[generateButtons.length - 1]);
    await user.click(screen.getByRole("button", { name: "Projects" }));

    await user.click(screen.getByRole("button", { name: "History" }));
    expect(screen.getByRole("region", { name: "History management" })).toBeInTheDocument();
    expect(screen.getByText(/生成一款带盘扣的黑色马甲/)).toBeInTheDocument();
    expect(await screen.findByText("backend result 1.jpg")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Profile" }));
    expect(screen.getByRole("region", { name: "Profile credit management" })).toBeInTheDocument();
    expect(screen.getByText("Credit balance")).toBeInTheDocument();
    expect(screen.getAllByText("173").length).toBeGreaterThan(0);
  });
});
