import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, LocateFixed, RefreshCw, Sparkles, X } from "lucide-react";
import { useCanvasGraphField } from "@/stores/canvas/canvas-graph-store";
import { useUserStore } from "@/stores/use-user-store";
import { createWorkspaceStorage } from "@/lib/workspace-storage";
import { resolveImageUrl, uploadImage } from "@/services/image-storage";
import { storeGeneratedVideo } from "@/services/api/video";
import { createApi, createTaskController } from "@/services/api/design-discussion.mjs";
import { createCanvasNode, imageMetadata, videoMetadata } from "@/pages/canvas/canvas-project-utils";
import { fitNodeSize } from "@/lib/canvas/canvas-node-size";
import { createClientUuid } from "@/lib/client-uuid";
import { CanvasNodeType } from "@/types/canvas";
import { StudioPanel, newStudioSession } from "./StudioPanel.jsx";
import { activeStatuses, designResultNodeId, designTaskMetadata, taskLabel } from "./task-model.mjs";
import { deploymentFeatures } from "@/lib/deployment-features";
import { readImageFiles } from "./studio-media.mjs";
import { continueDesignRecord } from "./design-record.mjs";
import { createDesignSessionPersistence } from "./session-persistence.mjs";
import { ConversationImagePreview } from "@/components/conversation-image-preview";
import { CanvasPersistedMediaPreview } from "@/components/canvas/canvas-persisted-media-preview";
import "./studio.css";
import "./canvas-discussion.css";

const brands = [
    "HM",
    "Quince",
    "32Degrees",
    "Sinsay",
    "Scalpers",
    "Zara",
    "Scout",
    "Bershka",
    "LcWaikiki",
    "Pepco",
    "Next",
    "Ipeykol",
    "Monsoon",
    "Oysho",
    "ASDA",
    "Primark",
    "Kappahl",
    "Mohito",
    "Massimo Dutti",
    "Intersport",
    "Zebra",
    "Mango",
    "Parfois",
    "Kmart",
    "RiverIsland",
    "Splash",
    "ChildrenSalon",
    "Stradivarius",
    "Ovs",
    "Liverpool",
    "Desigual",
    "Accessorize",
    "PullBear",
    "Target",
    "Farmers",
    "Boohoo",
    "Migros",
    "Asos",
    "Hunkemoller",
    "Shoulder",
    "Topshop",
    "Beeline",
    "Suburbia",
];

function partition(storage, prefix) {
    return {
        getItem: (key) => storage.getItem(prefix + key),
        setItem: (key, value) => storage.setItem(prefix + key, value),
        iterate: (callback) =>
            storage.iterate((value, key) => {
                if (key.startsWith(prefix)) return callback(value, key.slice(prefix.length));
            }),
    };
}
async function restoreReference(reference) {
    return { ...reference, image: await resolveImageUrl(reference.storageKey, reference.image) };
}
function nodeReferenceMetadata(node) {
    const serverAssetId = node.metadata?.serverAssetId;
    const image = typeof serverAssetId === "string" && serverAssetId.trim()
        ? `/api/assets/${encodeURIComponent(serverAssetId.trim())}/content`
        : node.metadata?.content || "";
    return {
        id: node.id,
        title: node.title || "画布图片",
        image,
        storageKey: node.metadata?.storageKey,
        width: node.metadata?.naturalWidth,
        height: node.metadata?.naturalHeight,
        bytes: node.metadata?.bytes,
        type: node.metadata?.mimeType,
        serverAssetId,
        kind: node.metadata?.sourceTaskId ? "result" : "reference",
        taskId: node.metadata?.sourceTaskId,
    };
}
async function nodeReference(node) {
    const reference = await restoreReference(nodeReferenceMetadata(node));
    return reference.image ? reference : null;
}
const workspaceIdentity = (state) => `${state.status}:${state.user?.id || ""}:${state.user?.status || ""}`;
const resultNodeId = (nodes, task, index) => {
    const version = task.resultVersions?.[index];
    return version
        ? nodes.find(
              (node) =>
                  node.metadata?.imageConversation?.conversationId === version.conversationId &&
                  node.metadata?.imageConversation?.versionId === version.id,
          )?.id || designResultNodeId(task, index)
        : designResultNodeId(task, index);
};
function appendReferences(current, incoming) {
    const identity = (reference) => reference.serverAssetId || reference.storageKey || reference.image || reference.id;
    const existing = new Set(current.map(identity));
    const added = Array.from(new Map(incoming.map((reference) => [identity(reference), reference])).values()).filter((reference) => !existing.has(identity(reference)));
    if (current.length + added.length > 4)
        throw new Error("本轮讨论最多 4 张参考图；请先移除不需要的图片，已有参考未改动。");
    return added.length ? [...current, ...added] : current;
}

export function CanvasDesignDiscussion({ projectId, writable, getCanvasCenter, onBeforeChange, onLocate }) {
    const identityKey = useUserStore(workspaceIdentity);
    const [nodes, setNodes] = useCanvasGraphField("nodes");
    const [selectedIds, setSelectedIds] = useCanvasGraphField("selectedNodeIds");
    const [visible, setVisible] = useState(false);
    const [taskView, setTaskView] = useState("closed");
    const expanded = taskView === "preview" || taskView === "pinned";
    const [session, setSession] = useState(newStudioSession);
    const [ownerId, setOwnerId] = useState("");
    const [catalog, setCatalog] = useState(null);
    const [tasks, setTasks] = useState([]);
    const [items, setItems] = useState([]);
    const [ready, setReady] = useState(false);
    const [notice, setNotice] = useState("");
    const [connection, setConnection] = useState(0);
    const [installationErrors, setInstallationErrors] = useState({});
    const [installationRetry, setInstallationRetry] = useState(0);
    const [preview, setPreview] = useState(null);
    const controller = useRef(null);
    const store = useMemo(() => createWorkspaceStorage("design_discussion"), [identityKey]);
    const mediaStore = useMemo(() => createWorkspaceStorage("design_discussion_media"), [identityKey]);
    const api = useMemo(() => createApi(globalThis.fetch.bind(globalThis), { projectId }), [projectId]);
    const scope = useMemo(
        () => ({
            active: false,
            ownerId: "",
            adding: new Set(),
            installed: new Set(),
            failed: new Set(),
            historyImports: new Set(),
            pending: new Map(),
            locate: [],
            initialSelectionKey: null,
            ignoredSelectionKey: null,
        }),
        [projectId, identityKey, connection],
    );
    const scopeRef = useRef(scope);
    scopeRef.current = scope;
    const mountedOwner = useRef("");
    const sessionRef = useRef(session);
    const nodesRef = useRef(nodes);
    nodesRef.current = nodes;
    const visibleRef = useRef(visible);
    visibleRef.current = visible;
    const sessionPersistence = useRef(null);
    const setPanelVisible = useCallback((value) => {
        const next = typeof value === "function" ? value(visibleRef.current) : value;
        visibleRef.current = next;
        setVisible(next);
        if (!next)
            void sessionPersistence.current?.flush().catch((error) => setNotice("讨论保存失败：" + error.message));
    }, []);
    const selectionSequence = useRef(0);
    const isCurrent = useCallback(() => {
        const user = useUserStore.getState();
        return (
            scope.active &&
            scopeRef.current === scope &&
            workspaceIdentity(user) === identityKey &&
            (!mountedOwner.current || !user.user?.id || user.user.id === mountedOwner.current) &&
            store.isCurrent()
        );
    }, [scope, identityKey, store]);
    const clearSession = useCallback(() => {
        const empty = newStudioSession();
        sessionRef.current = empty;
        controller.current = null;
        void sessionPersistence.current?.dispose().catch(() => {});
        sessionPersistence.current = null;
        selectionSequence.current++;
        setReady(false);
        setOwnerId("");
        setCatalog(null);
        setTasks([]);
        setItems([]);
        setSession(empty);
        setInstallationErrors({});
        setTaskView("closed");
        setPreview(null);
    }, []);
    useLayoutEffect(() => {
        scope.active = true;
        clearSession();
        const account = useUserStore.getState().user?.id;
        setNotice(
            mountedOwner.current && account && account !== mountedOwner.current
                ? "员工已切换，请重新进入画布后使用设计讨论。"
                : "",
        );
        return () => {
            scope.active = false;
            controller.current = null;
            void sessionPersistence.current?.dispose().catch(() => {});
            sessionPersistence.current = null;
            selectionSequence.current++;
        };
    }, [scope, clearSession]);
    const reportError = useCallback(
        (error) => {
            if (!isCurrent()) return;
            if (error.code === "SESSION_CHANGED" || error.status === 401) {
                scope.active = false;
                clearSession();
            }
            setNotice(error.message);
        },
        [scope, clearSession, isCurrent],
    );
    const updateSession = useCallback(
        (change) => {
            if (!isCurrent()) return;
            const next =
                typeof change === "function" ? change(sessionRef.current) : { ...sessionRef.current, ...change };
            if (next.references !== sessionRef.current.references) selectionSequence.current++;
            sessionRef.current = next;
            setSession(next);
            sessionPersistence.current?.schedule(next);
        },
        [isCurrent],
    );
    const assertWritable = () => {
        if (!isCurrent()) throw new Error("当前画布或员工会话已变化，未继续操作。");
        if (!writable.current) throw new Error("当前画布不可写，请恢复当前员工的编辑权限后再操作。");
    };
    const assertOwner = useCallback(async () => {
        if (!isCurrent()) throw new Error("当前画布或员工会话已变化，未继续操作。");
        const identity = await api.session();
        if (!isCurrent()) throw new Error("当前画布或员工会话已变化，未继续操作。");
        if (identity?.user?.id !== scope.ownerId || identity.user.status !== "active")
            throw Object.assign(new Error("登录身份已变化，请重新连接设计讨论。"), { code: "SESSION_CHANGED" });
        return identity;
    }, [api, isCurrent, scope]);
    const panelApi = useMemo(
        () => ({
            ...api,
            session: async () => {
                try {
                    return await assertOwner();
                } catch (error) {
                    reportError(error);
                    throw error;
                }
            },
        }),
        [api, assertOwner, reportError],
    );
    const locateResults = useCallback(
        (ids) => {
            if (!isCurrent()) return;
            selectionSequence.current++;
            scope.ignoredSelectionKey = [...ids].sort().join("|");
            onLocate(ids);
        },
        [scope, isCurrent, onLocate],
    );

    useEffect(() => {
        let alive = true;
        let activeRuntime;
        let persistence;
        const connect = async () => {
            const [identity, models] = await Promise.all([api.session(), api.catalog()]);
            if (!identity?.user?.id || identity.user.status !== "active") throw new Error("请重新登录后使用设计讨论。");
            const owner = identity.user.id;
            if (!alive || !isCurrent()) return;
            const currentUser = useUserStore.getState();
            if (
                (mountedOwner.current && mountedOwner.current !== owner) ||
                (currentUser.status === "authenticated" && currentUser.user?.id !== owner)
            )
                throw Object.assign(new Error("登录身份已变化，请重新进入画布后使用设计讨论。"), {
                    code: "SESSION_CHANGED",
                });
            mountedOwner.current = owner;
            scope.ownerId = owner;
            const partitioned = partition(store, `${owner}:${encodeURIComponent(projectId)}:`);
            persistence = createDesignSessionPersistence(
                partitioned,
                partition(mediaStore, `${owner}:${encodeURIComponent(projectId)}:`),
                (error) => {
                    if (alive && isCurrent()) setNotice("讨论保存失败：" + error.message);
                },
            );
            const saved = await persistence.load();
            if (saved) {
                saved.references = await Promise.all(saved.references.map(restoreReference));
                if (saved.proposalBatch)
                    saved.proposalBatch.references = await Promise.all(
                        saved.proposalBatch.references.map(restoreReference),
                    );
                scope.ignoredSelectionKey = scope.initialSelectionKey;
            }
            if (!alive || !isCurrent()) return;
            setOwnerId(owner);
            setCatalog(models);
            const restored = saved || newStudioSession();
            sessionRef.current = restored;
            setSession(restored);
            sessionPersistence.current = persistence;
            const runtime = createTaskController({
                api,
                ownerId: owner,
                projectId,
                assertWritable,
                imageConversationsEnabled: deploymentFeatures.imageConversationsEnabled,
                storage: partition(store, `${owner}:${encodeURIComponent(projectId)}:task:`),
                onChange: (value) => {
                    if (alive && isCurrent()) setTasks(value);
                },
            });
            activeRuntime = runtime;
            await runtime.load();
            if (!alive || !isCurrent()) return;
            controller.current = runtime;
            setReady(true);
            await runtime.refreshAll();
        };
        connect().catch((error) => {
            if (alive) reportError(error);
        });
        const flush = () => {
            void persistence?.flush().catch((error) => {
                if (alive && isCurrent()) setNotice("讨论保存失败：" + error.message);
            });
        };
        window.addEventListener("pagehide", flush);
        window.addEventListener("beforeunload", flush);
        return () => {
            alive = false;
            window.removeEventListener("pagehide", flush);
            window.removeEventListener("beforeunload", flush);
            void persistence?.dispose().catch(() => {});
            activeRuntime?.dispose?.();
            controller.current = null;
        };
    }, [api, projectId, store, mediaStore, scope, isCurrent, reportError]);

    useEffect(() => {
        const runtime = controller.current;
        if (!ready || !isCurrent() || !runtime?.needsRefresh()) return;
        const timer = setInterval(() => {
            if (isCurrent()) runtime.refreshAll().catch(reportError);
        }, 3000);
        return () => clearInterval(timer);
    }, [tasks, ready, isCurrent, reportError]);

    useEffect(() => {
        if (expanded && ready && isCurrent()) void controller.current?.refreshAnnotations().catch(reportError);
    }, [expanded, ready, isCurrent, reportError]);

    useEffect(() => {
        if (!expanded || !ready) return;
        const refresh = () => {
            if (isCurrent() && document.visibilityState === "visible" && navigator.onLine)
                void controller.current?.refreshHistory?.().catch(reportError);
        };
        window.addEventListener("focus", refresh);
        window.addEventListener("online", refresh);
        document.addEventListener("visibilitychange", refresh);
        return () => {
            window.removeEventListener("focus", refresh);
            window.removeEventListener("online", refresh);
            document.removeEventListener("visibilitychange", refresh);
        };
    }, [expanded, ready, isCurrent, reportError]);

    useEffect(() => {
        if (!ready || !isCurrent()) return;
        setItems(
            nodes
                .filter(
                    (node) =>
                        node.type === CanvasNodeType.Image &&
                        (node.metadata?.content || node.metadata?.storageKey || node.metadata?.serverAssetId),
                )
                .map(nodeReferenceMetadata),
        );
    }, [nodes, ready, isCurrent]);
    const selectionKey = [...selectedIds].sort().join("|");
    scope.initialSelectionKey ??= selectionKey;
    useEffect(() => {
        const sequence = ++selectionSequence.current;
        if (!ready) return;
        if (selectionKey === scope.ignoredSelectionKey) return;
        scope.ignoredSelectionKey = null;
        const selected = nodesRef.current.filter(
            (node) =>
                selectedIds.has(node.id) &&
                node.type === CanvasNodeType.Image &&
                (node.metadata?.content || node.metadata?.storageKey || node.metadata?.serverAssetId),
        );
        if (selected.length > 4) {
            setNotice(`画布已选 ${selected.length} 张；本轮讨论最多 4 张，未遗漏截取，请减少选择后再讨论。`);
            return;
        }
        if (!selected.length) return;
        Promise.all(selected.map(nodeReference))
            .then((value) => {
                if (!isCurrent() || sequence !== selectionSequence.current) return;
                const references = appendReferences(
                    sessionRef.current.references,
                    value.filter(Boolean).map((reference) => ({ ...reference, role: "auto" })),
                );
                if (references !== sessionRef.current.references) updateSession({ references });
                setNotice("");
            })
            .catch(reportError);
        return () => {
            selectionSequence.current++;
        };
    }, [selectionKey, ready, updateSession, isCurrent, reportError, scope]);

    useEffect(() => {
        const shortcut = (event) => {
            if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.code === "Space") {
                event.preventDefault();
                setPanelVisible((value) => !value);
            }
            if (event.key === "Escape") setTaskView("closed");
        };
        window.addEventListener("keydown", shortcut);
        return () => window.removeEventListener("keydown", shortcut);
    }, [setPanelVisible]);

    const addImages = async (references, choose = true) => {
        assertWritable();
        if (choose && sessionRef.current.references.length + references.length > 4)
            throw new Error("本轮讨论最多 4 张参考图；请先移除不需要的图片，已有参考未改动。");
        const images = [];
        const center = getCanvasCenter();
        for (const [index, reference] of references.entries()) {
            const stored = await uploadImage(reference.image);
            assertWritable();
            const node = createCanvasNode(
                CanvasNodeType.Image,
                { x: center.x + (index % 3) * 370, y: center.y + Math.floor(index / 3) * 500 },
                imageMetadata(stored),
            );
            node.title = reference.title;
            Object.assign(node, fitNodeSize(stored.width, stored.height));
            images.push(node);
        }
        const resolved = choose ? await Promise.all(images.map(nodeReference)) : [];
        assertWritable();
        const nextReferences = choose
            ? appendReferences(sessionRef.current.references, resolved.filter(Boolean))
            : null;
        onBeforeChange();
        setNodes((current) => (isCurrent() ? [...current, ...images] : current));
        if (choose) {
            scope.ignoredSelectionKey = images
                .map((node) => node.id)
                .sort()
                .join("|");
            setSelectedIds(new Set(images.map((node) => node.id)));
            updateSession({ references: nextReferences });
        }
        return images;
    };
    const chooseReferences = async (references) => {
        assertWritable();
        const current = sessionRef.current.references;
        const added = appendReferences(
            current,
            references.map((reference) => ({ ...reference, role: "auto" })),
        ).slice(current.length);
        if (!added.length) return;
        const sequence = selectionSequence.current;
        const resolved = await Promise.all(
            added.map(async (reference) => {
                const node = nodesRef.current.find(
                    (item) => item.id === reference.id && item.type === CanvasNodeType.Image,
                );
                const selected = node ? await nodeReference(node) : await restoreReference(reference);
                if (!selected?.image) throw new Error("所选图片原件暂时无法读取，请重新选择；已有参考未改动。");
                return { ...selected, role: "auto" };
            }),
        );
        assertWritable();
        if (sequence !== selectionSequence.current) throw new Error("讨论参考已变化，请重新选择；已有参考未改动。");
        updateSession({ references: appendReferences(sessionRef.current.references, resolved) });
    };
    const editReference = (reference) => {
        assertWritable();
        if (!ready) throw new Error("设计讨论尚未就绪，请稍后再选择修改对象。");
        const current = sessionRef.current.references;
        const existing =
            current.find((item) => item.id === reference.id) || current.find((item) => item.image === reference.image);
        const target = existing || reference;
        const references = appendReferences(current, [target]).map((item) => ({
            ...item,
            role: item.id === target.id ? "base" : item.role === "base" ? "auto" : item.role || "auto",
        }));
        updateSession({
            references,
            discussionFocus:
                reference.kind === "result"
                    ? { kind: "result", title: reference.title, taskId: reference.taskId }
                    : null,
            mode: "discuss",
        });
    };

    const submitBatch = async (inputs, onRecorded) => {
        assertWritable();
        if (!visibleRef.current) throw new Error("设计讨论已关闭，没有提交新的生成任务。");
        if (!controller.current || scope.pending.size) throw new Error("正在连接或提交，请勿重复操作。");
        if (!inputs.length || inputs.length > 15 || inputs.some((input) => input.generationAllowed !== true))
            throw new Error("生成操作无效，没有提交任务。");
        const runtime = controller.current;
        const prepared = inputs.map((input) => ({ ...input, requestId: createClientUuid() }));
        const center = getCanvasCenter();
        const right = nodesRef.current.reduce(
            (maximum, node) => Math.max(maximum, node.position.x + node.width),
            center.x,
        );
        const columns = Math.ceil(Math.sqrt(prepared.length));
        const placeholders = prepared.map((input, index) => {
            const node = createCanvasNode(
                input.mediaKind === "video" ? CanvasNodeType.Video : CanvasNodeType.Image,
                { x: right + 100 + (index % columns) * 460, y: center.y + Math.floor(index / columns) * 500 },
                designTaskMetadata({ ...input, status: "preparing" }),
            );
            node.id = `design-${input.requestId}-0`;
            node.title = input.proposal?.title || "设计方案";
            Object.assign(node, { width: 420, height: input.mediaKind === "video" ? 236 : 420 });
            return node;
        });
        onBeforeChange();
        prepared.forEach((input) => scope.pending.set(input.requestId, input));
        scope.locate = placeholders.map((node) => node.id);
        setNodes((current) => (isCurrent() ? [...current, ...placeholders] : current));
        setTaskView("closed");
        setNotice(`正在准备 ${prepared.length} 个独立请求，确认受理后可在这里查询。`);
        let interrupted = "剩余任务未提交，本次已停止。";
        try {
            for (const [index, input] of prepared.entries()) {
                assertWritable();
                const task = await runtime.start(input);
                assertWritable();
                scope.pending.delete(input.requestId);
                const placeholderId = `design-${input.requestId}-0`;
                const taskNodeId = resultNodeId(nodesRef.current, task, 0);
                if (placeholderId !== taskNodeId) {
                    setNodes((current) => {
                        if (!isCurrent()) return current;
                        const existing = current.some((node) => node.id === taskNodeId);
                        return current.flatMap((node) =>
                            node.id !== placeholderId
                                ? [node]
                                : existing
                                  ? []
                                  : [
                                        {
                                            ...node,
                                            id: taskNodeId,
                                            metadata: { ...node.metadata, ...designTaskMetadata(task) },
                                        },
                                    ],
                        );
                    });
                    scope.locate = scope.locate.map((id) => (id === placeholderId ? taskNodeId : id));
                }
                onRecorded(task, index);
            }
        } catch (error) {
            interrupted = error.message;
            reportError(error);
            throw error;
        } finally {
            const unsent = new Set(scope.pending.keys());
            scope.pending.clear();
            if (isCurrent() && writable.current && unsent.size)
                setNodes((current) =>
                    current.map((node) =>
                        unsent.has(node.metadata?.designTask?.requestId)
                            ? {
                                  ...node,
                                  metadata: {
                                      ...node.metadata,
                                      ...designTaskMetadata({
                                          requestId: node.metadata.designTask.requestId,
                                          status: "failed",
                                          failureReason: `未继续提交：${interrupted}`,
                                      }),
                                  },
                              }
                            : node,
                    ),
                );
        }
    };

    useEffect(() => {
        if (!ready || !isCurrent() || !writable.current) return;
        const byRequest = new Map(
            tasks
                .filter((task) => task.ownerId === ownerId && task.projectId === projectId)
                .map((task) => [task.requestId, task]),
        );
        setNodes((current) => {
            let changed = false;
            const next = current.map((node) => {
                const binding = node.metadata?.designTask;
                if (!binding || node.metadata.content || node.metadata.storageKey || node.metadata.serverAssetId) return node;
                const task = byRequest.get(binding.requestId);
                if (!task && (scope.pending.has(binding.requestId) || binding.status !== "preparing")) return node;
                const patch = designTaskMetadata(
                    task || {
                        requestId: binding.requestId,
                        status: "failed",
                        failureReason: "提交准备已中断，请查看原任务记录；不会自动重新提交。",
                    },
                );
                if (installationErrors[node.id]) {
                    patch.status = "error";
                    patch.errorDetails = `结果已完成，放入画布失败：${installationErrors[node.id]}。请在创作任务中重试放入原结果。`;
                }
                if (
                    node.metadata.status === patch.status &&
                    node.metadata.errorDetails === patch.errorDetails &&
                    node.metadata.sourceTaskId === patch.sourceTaskId &&
                    binding.status === patch.designTask.status &&
                    binding.label === patch.designTask.label
                )
                    return node;
                changed = true;
                return { ...node, metadata: { ...node.metadata, ...patch } };
            });
            return changed ? next : current;
        });
        if (scope.locate.length && scope.locate.every((id) => nodes.some((node) => node.id === id))) {
            const ids = scope.locate;
            scope.locate = [];
            locateResults(ids);
        }
    }, [
        nodes,
        tasks,
        ready,
        ownerId,
        projectId,
        scope,
        isCurrent,
        installationErrors,
        setNodes,
        locateResults,
        writable,
    ]);

    useEffect(() => {
        if (!ready || !isCurrent()) return;
        const install = async (task) => {
            for (const [index, url] of task.resultUrls.entries()) {
                const id = resultNodeId(nodesRef.current, task, index);
                const version = task.resultVersions?.[index];
                if (!isCurrent() || !writable.current) return;
                if (
                    nodesRef.current.some(
                        (node) =>
                            node.id === id &&
                            (node.metadata?.content || node.metadata?.storageKey || node.metadata?.serverAssetId),
                    ) ||
                    scope.installed.has(id) ||
                    scope.adding.has(id) ||
                    scope.failed.has(id)
                )
                    continue;
                const allowNewNode = !task.serverHistory || scope.historyImports.has(task.id);
                const pendingId = nodesRef.current.find(
                    (node) =>
                        (node.id === id || (version && node.metadata?.designTask?.requestId === task.requestId)) &&
                        !node.metadata?.content &&
                        !node.metadata?.storageKey &&
                        !node.metadata?.serverAssetId,
                )?.id;
                if (!allowNewNode && !pendingId) continue;
                scope.adding.add(id);
                try {
                    const video = task.mediaKind === "video";
                    const stored = video
                        ? await storeGeneratedVideo({ url, mimeType: "video/mp4" })
                        : await uploadImage(url);
                    await assertOwner();
                    assertWritable();
                    const placeholder = nodesRef.current.find(
                        (node) =>
                            node.id === id ||
                            (version &&
                                node.metadata?.designTask?.requestId === task.requestId &&
                                !node.metadata?.content &&
                                !node.metadata?.storageKey &&
                                !node.metadata?.serverAssetId),
                    );
                    if (!allowNewNode && !nodesRef.current.some((node) => node.id === pendingId)) continue;
                    const right = nodesRef.current.reduce(
                        (maximum, node) => Math.max(maximum, node.position.x + node.width),
                        getCanvasCenter().x,
                    );
                    const node = createCanvasNode(
                        video ? CanvasNodeType.Video : CanvasNodeType.Image,
                        placeholder?.position || { x: right + 230, y: getCanvasCenter().y },
                        video ? videoMetadata(stored) : imageMetadata(stored),
                    );
                    node.id = id;
                    node.title = task.proposal?.title || (video ? "设计视频" : "设计方案");
                    Object.assign(
                        node,
                        fitNodeSize(
                            stored.width || 1280,
                            stored.height || 720,
                            placeholder?.width || 640,
                            placeholder?.height || 640,
                        ),
                    );
                    node.metadata = {
                        ...node.metadata,
                        sourceTaskId: task.taskId,
                        ...(version
                            ? {
                                  imageConversation: {
                                      conversationId: version.conversationId,
                                      versionId: version.id,
                                      assetId: version.assetId,
                                      turnId: version.turnId,
                                  },
                                  designExecutionId: task.id,
                              }
                            : {}),
                        prompt: task.prompt,
                        designProposal: {
                            title: node.title,
                            features: task.proposal?.features || [],
                            rationale: task.proposal?.rationale || "",
                            references: task.references.map((reference) => ({
                                title: reference.title,
                                image: reference.image,
                            })),
                        },
                    };
                    onBeforeChange();
                    setNodes((current) => {
                        if (
                            !isCurrent() ||
                            !writable.current ||
                            (!allowNewNode && !current.some((item) => item.id === pendingId))
                        )
                            return current;
                        const existing = current.find(
                            (item) =>
                                item.id === id ||
                                (version &&
                                    item.metadata?.imageConversation?.conversationId === version.conversationId &&
                                    item.metadata?.imageConversation?.versionId === version.id),
                        );
                        if (
                            existing?.metadata?.content ||
                            existing?.metadata?.storageKey ||
                            existing?.metadata?.serverAssetId
                        )
                            return current;
                        const targetId = existing?.id || placeholder?.id;
                        scope.installed.add(id);
                        scope.historyImports.delete(task.id);
                        return targetId && current.some((item) => item.id === targetId)
                            ? current.map((item) =>
                                  item.id === targetId ? { ...item, ...node, position: item.position } : item,
                              )
                            : [...current, node];
                    });
                    setInstallationErrors((current) => {
                        const next = { ...current };
                        delete next[id];
                        return next;
                    });
                } catch (error) {
                    if (error.code === "SESSION_CHANGED" || error.status === 401) {
                        reportError(error);
                        return;
                    }
                    if (isCurrent()) {
                        scope.failed.add(id);
                        setInstallationErrors((current) => ({ ...current, [id]: error.message }));
                        setNotice("结果已完成，放入画布失败：" + error.message + "。可重试放入原结果，不要重新生成。");
                    }
                } finally {
                    scope.adding.delete(id);
                }
            }
        };
        for (const task of tasks)
            if (
                task.ownerId === ownerId &&
                task.projectId === projectId &&
                task.status === "success" &&
                task.resultUrls.length &&
                writable.current &&
                (!task.serverHistory ||
                    scope.historyImports.has(task.id) ||
                    nodesRef.current.some(
                        (node) =>
                            node.metadata?.designTask?.requestId === task.requestId &&
                            !node.metadata?.content &&
                            !node.metadata?.storageKey &&
                            !node.metadata?.serverAssetId,
                    ))
            )
                void install(task);
    }, [
        tasks,
        ready,
        ownerId,
        projectId,
        scope,
        isCurrent,
        assertOwner,
        reportError,
        installationRetry,
        setNodes,
        getCanvasCenter,
        onBeforeChange,
        writable,
    ]);

    const retryInstallation = (task) => {
        assertWritable();
        scope.historyImports.add(task.id);
        const resultIds = task.resultUrls.map((_, index) => resultNodeId(nodesRef.current, task, index));
        for (const id of resultIds) scope.failed.delete(id);
        setInstallationErrors((current) =>
            Object.fromEntries(Object.entries(current).filter(([id]) => !resultIds.includes(id))),
        );
        setInstallationRetry((value) => value + 1);
    };

    const scopedTasks = isCurrent() ? tasks : [];
    const active = scopedTasks.filter((task) => activeStatuses.has(task.status));
    const needsAttention = scopedTasks.filter(
        (task) =>
            ["failed", "paused", "uncertain", "needs_input"].includes(task.status) ||
            task.queryError ||
            task.resultUrls.some((_, index) => installationErrors[resultNodeId(nodes, task, index)]),
    );
    const action = (task, kind) => {
        if (isCurrent()) return controller.current?.action(task.id, kind).catch(reportError);
    };
    const continueTask = (task) => {
        if (!isCurrent()) return;
        updateSession({
            ...newStudioSession(task.references),
            history: task.conversation || [],
            prompt: task.userText || task.prompt,
            brief: task.brief || {},
            designRecord: continueDesignRecord(task),
            outputKind: task.mediaKind || "image",
            modelId: task.modelId,
        });
        setPanelVisible(true);
        setTaskView("closed");
    };
    return (
        <div className="canvas-design-discussion" data-testid="canvas-design-discussion">
            <div
                className="dd-island"
                onMouseEnter={() => setTaskView((value) => (value === "pinned" ? value : "preview"))}
                onMouseLeave={() => setTaskView((value) => (value === "pinned" ? value : "closed"))}
            >
                <div className="dd-pill">
                    <button
                        className="dd-launch"
                        aria-label="打开设计讨论"
                        aria-expanded={visible}
                        onClick={() => {
                            setPanelVisible((value) => !value);
                            setTaskView("closed");
                        }}
                    >
                        <Sparkles size={17} />
                        <span>{active.length ? `${active.length} 个创作任务进行中` : "创作随时开始"}</span>
                    </button>
                    <button
                        aria-label="查看设计生成任务"
                        aria-expanded={expanded}
                        aria-pressed={taskView === "pinned"}
                        onClick={() => setTaskView((value) => (value === "pinned" ? "closed" : "pinned"))}
                    >
                        {needsAttention.length ? <span>{needsAttention.length}</span> : <ChevronDown size={14} />}
                    </button>
                </div>
                {expanded && (
                    <section className="dd-tasks" aria-label="设计生成任务">
                        <header>
                            <strong>创作任务</strong>
                            <small>每个结果单独记录</small>
                        </header>
                        {controller.current?.historyError?.() && (
                            <p role="alert">
                                {controller.current.historyError()}
                                <button onClick={() => controller.current?.refreshHistory?.().catch(reportError)}>
                                    重新读取历史
                                </button>
                            </p>
                        )}
                        {!scopedTasks.length ? (
                            <p>
                                选中画布图片，打开设计讨论。
                                <br />
                                原有左侧创建与对话保持独立。
                            </p>
                        ) : (
                            [...scopedTasks].reverse().map((task) => {
                                const resultIds = task.resultUrls.map((_, index) => resultNodeId(nodes, task, index));
                                const canContinue =
                                    task.conversationExecution &&
                                    !task.conversationExecution.turnDispatchStartedAt &&
                                    ["preparing", "ready_to_submit"].includes(task.conversationExecution.phase);
                                const failed = resultIds.some((id) => installationErrors[id]);
                                const placed =
                                    resultIds.length > 0 &&
                                    resultIds.every((id) =>
                                        nodes.some(
                                            (node) =>
                                                node.id === id &&
                                                    (node.metadata?.content ||
                                                        node.metadata?.storageKey ||
                                                        node.metadata?.serverAssetId),
                                        ),
                                    );
                                const unplacedHistory =
                                    task.serverHistory &&
                                    task.status === "success" &&
                                    !placed &&
                                    !scope.historyImports.has(task.id);
                                const label = failed
                                    ? "结果已完成 · 放入画布失败，可重试"
                                    : unplacedHistory
                                      ? "结果已保存到服务器"
                                      : task.status === "success" && !placed && resultIds.length
                                        ? "结果已完成 · 正在放入画布"
                                        : taskLabel(task);
                                return (
                                    <article key={task.id} data-design-task-id={task.id} data-status={task.status}>
                                        <div>
                                            <strong>{task.proposal?.title || task.userText}</strong>
                                            <small>{label}</small>
                                        </div>
                                        {failed || unplacedHistory ? (
                                            <button
                                                aria-label={
                                                    unplacedHistory ? "将历史设计结果放入画布" : "重试放入设计结果"
                                                }
                                                onClick={() => {
                                                    try {
                                                        retryInstallation(task);
                                                    } catch (error) {
                                                        reportError(error);
                                                    }
                                                }}
                                            >
                                                <RefreshCw size={15} />
                                            </button>
                                        ) : task.status === "success" && placed ? (
                                            <button
                                                aria-label="定位设计结果"
                                                onClick={() => {
                                                    if (isCurrent()) onLocate(resultIds);
                                                    setTaskView("closed");
                                                }}
                                            >
                                                <LocateFixed size={16} />
                                            </button>
                                        ) : canContinue ? (
                                            <button
                                                aria-label="继续已记录的生成操作"
                                                onClick={() => action(task, "continue")}
                                            >
                                                <Sparkles size={15} />
                                            </button>
                                        ) : (
                                            <button
                                                aria-label="查询原设计任务"
                                                onClick={() =>
                                                    action(
                                                        task,
                                                        task.status === "paused" && task.upstreamTaskId
                                                            ? "recover"
                                                            : "refresh",
                                                    )
                                                }
                                            >
                                                <RefreshCw size={15} />
                                            </button>
                                        )}
                                        <details>
                                            <summary>方案、参考与执行记录</summary>
                                            <p>{task.proposal?.features?.join("；")}</p>
                                            {task.serverHistory && <p>服务端原执行记录；未恢复原设备的讨论草稿。</p>}
                                            <div className="dd-task-refs">
                                                {task.references.map((reference, index) => (
                                                    <button
                                                        key={reference.id}
                                                        aria-label={`查看任务参考图 ${index + 1}`}
                                                        onClick={() => {
                                                            if (isCurrent())
                                                                setPreview({
                                                                    scope,
                                                                    image: {
                                                                        id: reference.id,
                                                                        label: `图${index + 1}`,
                                                                        name: reference.title,
                                                                        dataUrl: reference.image,
                                                                        storageKey: reference.storageKey,
                                                                    },
                                                                });
                                                        }}
                                                    >
                                                        <CanvasPersistedMediaPreview
                                                            kind="image"
                                                            url={reference.image}
                                                            storageKey={reference.storageKey}
                                                            width={reference.width}
                                                            height={reference.height}
                                                            alt={reference.title}
                                                            className=""
                                                        />
                                                    </button>
                                                ))}
                                            </div>
                                            <details>
                                                <summary>原执行要求</summary>
                                                <p>{task.prompt}</p>
                                            </details>
                                            <div className="dd-task-refs">
                                                {task.resultUrls.map((url, index) =>
                                                    task.mediaKind === "video" ? (
                                                        <a
                                                            key={url}
                                                            href={url}
                                                            target="_blank"
                                                            rel="noopener noreferrer"
                                                            aria-label={`查看原设计结果 ${index + 1}`}
                                                        >
                                                            查看视频结果
                                                        </a>
                                                    ) : (
                                                        <button
                                                            key={url}
                                                            aria-label={`查看原设计结果 ${index + 1}`}
                                                            onClick={() => {
                                                                if (isCurrent())
                                                                    setPreview({
                                                                        scope,
                                                                        image: {
                                                                            id: `${task.id}:${index}`,
                                                                            label: `图${index + 1}`,
                                                                            name: task.proposal?.title || "设计结果",
                                                                            dataUrl: url,
                                                                        },
                                                                    });
                                                            }}
                                                        >
                                                            <CanvasPersistedMediaPreview
                                                                kind="image"
                                                                url={url}
                                                                alt={`已保存结果 ${index + 1}`}
                                                                className=""
                                                            />
                                                        </button>
                                                    ),
                                                )}
                                            </div>
                                            <p>
                                                {task.mediaKind === "video" ? "视频" : "图片"} · {task.model} · 每任务 1
                                                个结果
                                            </p>
                                            <p>请求：{task.requestId}</p>
                                            {task.failureReason && <p role="alert">{task.failureReason}</p>}
                                            {task.queryError && <p role="alert">{task.queryError}</p>}
                                            {resultIds
                                                .filter((id) => installationErrors[id])
                                                .map((id) => (
                                                    <p role="alert" key={id}>
                                                        {installationErrors[id]}
                                                    </p>
                                                ))}
                                            {["failed", "needs_input"].includes(task.status) && (
                                                <button onClick={() => continueTask(task)}>
                                                    修改需求后新建任务（可能计费）
                                                </button>
                                            )}
                                        </details>
                                    </article>
                                );
                            })
                        )}
                        {controller.current?.hasMoreHistory?.() && (
                            <button onClick={() => controller.current?.loadMoreHistory?.().catch(reportError)}>
                                加载更早的服务端记录
                            </button>
                        )}
                    </section>
                )}
            </div>
            {notice && (
                <div className="dd-notice" role="status">
                    <span>{notice}</span>
                    <button aria-label="关闭设计讨论提示" onClick={() => setNotice("")}>
                        <X size={14} />
                    </button>
                </div>
            )}
            {visible && !ready && (
                <div className="dd-connect">
                    <span>设计讨论尚未连接。</span>
                    <button onClick={() => setConnection((value) => value + 1)}>重新连接</button>
                </div>
            )}
            <StudioPanel
                key={`${projectId}:${identityKey}:${connection}`}
                visible={visible}
                session={isCurrent() ? session : newStudioSession()}
                onChange={updateSession}
                items={isCurrent() ? items : []}
                onChoose={chooseReferences}
                onEditReference={editReference}
                onImport={async (files) => {
                    assertWritable();
                    if (sessionRef.current.references.length + files.length > 4)
                        throw new Error("本轮讨论最多 4 张参考图；请先移除不需要的图片，已有参考未改动。");
                    return addImages(await readImageFiles(files));
                }}
                onFigures={async (figures, name) => {
                    try {
                        await addImages(
                            figures.map((figure) => ({
                                title: `${name} · ${figure.label}`,
                                image: figure.dataUrl || figure.image || figure.url,
                            })),
                            false,
                        );
                    } catch (error) {
                        reportError(error);
                    }
                }}
                api={panelApi}
                ownerId={isCurrent() ? ownerId : ""}
                catalog={isCurrent() ? catalog : null}
                ready={isCurrent() && ready && writable.current}
                brands={brands}
                onSave={async () => {
                    assertWritable();
                    await sessionPersistence.current?.flush();
                    assertWritable();
                }}
                onSubmitBatch={submitBatch}
                onClose={() => setPanelVisible(false)}
                onNotice={(message) => {
                    if (isCurrent()) setNotice(message);
                }}
                tasks={scopedTasks}
                onLocateResult={(task, index) => {
                    if (isCurrent()) onLocate([resultNodeId(nodesRef.current, task, index)]);
                }}
            />
            {preview?.scope === scope && isCurrent() && (
                <ConversationImagePreview image={preview.image} onClose={() => setPreview(null)} />
            )}
        </div>
    );
}
