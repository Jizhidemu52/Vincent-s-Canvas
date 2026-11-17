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
import { CanvasNodeType } from "@/types/canvas";
import { StudioPanel, newStudioSession } from "./StudioPanel.jsx";
import { activeStatuses, taskLabel } from "./task-model.mjs";
import { readImageFiles } from "./studio-media.mjs";
import { continueDesignRecord } from "./design-record.mjs";
import "./studio.css";
import "./canvas-discussion.css";

const brands = ["HM", "Quince", "32Degrees", "Sinsay", "Scalpers", "Zara", "Scout", "Bershka", "LcWaikiki", "Pepco", "Next", "Ipeykol", "Monsoon", "Oysho", "ASDA", "Primark", "Kappahl", "Mohito", "Massimo Dutti", "Intersport", "Zebra", "Mango", "Parfois", "Kmart", "RiverIsland", "Splash", "ChildrenSalon", "Stradivarius", "Ovs", "Liverpool", "Desigual", "Accessorize", "PullBear", "Target", "Farmers", "Boohoo", "Migros", "Asos", "Hunkemoller", "Shoulder", "Topshop", "Beeline", "Suburbia"];

function partition(storage, prefix) {
    return { getItem: key => storage.getItem(prefix + key), setItem: (key, value) => storage.setItem(prefix + key, value), iterate: callback => storage.iterate((value, key) => { if (key.startsWith(prefix)) return callback(value, key.slice(prefix.length)); }) };
}
async function restoreReference(reference) {
    return { ...reference, image: await resolveImageUrl(reference.storageKey, reference.image) };
}
async function nodeReference(node) {
    const image = await resolveImageUrl(node.metadata?.storageKey, node.metadata?.content || "");
    if (!image) return null;
    return { id: node.id, title: node.title || "画布图片", image, storageKey: node.metadata?.storageKey, width: node.metadata?.naturalWidth, height: node.metadata?.naturalHeight, bytes: node.metadata?.bytes, type: node.metadata?.mimeType, kind: node.metadata?.sourceTaskId ? "result" : "reference", taskId: node.metadata?.sourceTaskId };
}
const workspaceIdentity = state => `${state.status}:${state.user?.id || ""}:${state.user?.status || ""}`;

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
    const controller = useRef(null);
    const store = useMemo(() => createWorkspaceStorage("design_discussion"), [identityKey]);
    const api = useMemo(() => createApi(globalThis.fetch.bind(globalThis), { projectId }), [projectId]);
    const scope = useMemo(() => ({ active: false, ownerId: "", adding: new Set(), installed: new Set(), failed: new Set() }), [projectId, identityKey, connection]);
    const scopeRef = useRef(scope);
    scopeRef.current = scope;
    const mountedOwner = useRef("");
    const sessionRef = useRef(session);
    const nodesRef = useRef(nodes);
    nodesRef.current = nodes;
    const visibleRef = useRef(visible);
    visibleRef.current = visible;
    const setPanelVisible = useCallback(value => {
        const next = typeof value === "function" ? value(visibleRef.current) : value;
        visibleRef.current = next;
        setVisible(next);
    }, []);
    const saveQueue = useRef(Promise.resolve());
    const sessionStore = useRef(null);
    const selectionSequence = useRef(0);
    const isCurrent = useCallback(() => {
        const user = useUserStore.getState();
        return scope.active && scopeRef.current === scope && workspaceIdentity(user) === identityKey && (!mountedOwner.current || !user.user?.id || user.user.id === mountedOwner.current) && store.isCurrent();
    }, [scope, identityKey, store]);
    const clearSession = useCallback(() => {
        const empty = newStudioSession();
        sessionRef.current = empty;
        controller.current = null; sessionStore.current = null;
        selectionSequence.current++;
        setReady(false); setOwnerId(""); setCatalog(null); setTasks([]); setItems([]); setSession(empty);
        setInstallationErrors({}); setTaskView("closed");
    }, []);
    useLayoutEffect(() => {
        scope.active = true;
        clearSession();
        const account = useUserStore.getState().user?.id;
        setNotice(mountedOwner.current && account && account !== mountedOwner.current ? "员工已切换，请重新进入画布后使用设计讨论。" : "");
        return () => { scope.active = false; controller.current = null; sessionStore.current = null; selectionSequence.current++; };
    }, [scope, clearSession]);
    const reportError = useCallback(error => {
        if (!isCurrent()) return;
        if (error.code === "SESSION_CHANGED" || error.status === 401) { scope.active = false; clearSession(); }
        setNotice(error.message);
    }, [scope, clearSession, isCurrent]);
    const updateSession = useCallback(change => {
        if (!isCurrent()) return;
        const next = typeof change === "function" ? change(sessionRef.current) : { ...sessionRef.current, ...change };
        sessionRef.current = next;
        setSession(next);
        if (sessionStore.current) {
            const snapshot = structuredClone(next);
            const target = sessionStore.current;
            saveQueue.current = saveQueue.current.catch(() => {}).then(() => target.setItem("session", snapshot));
            saveQueue.current.catch(error => { if (isCurrent()) setNotice("讨论保存失败：" + error.message); });
        }
    }, [isCurrent]);
    const assertWritable = () => {
        if (!isCurrent()) throw new Error("当前画布或员工会话已变化，未继续操作。");
        if (!writable.current) throw new Error("当前画布不可写，请恢复当前员工的编辑权限后再操作。");
    };
    const assertOwner = useCallback(async () => {
        if (!isCurrent()) throw new Error("当前画布或员工会话已变化，未继续操作。");
        const identity = await api.session();
        if (!isCurrent()) throw new Error("当前画布或员工会话已变化，未继续操作。");
        if (identity?.user?.id !== scope.ownerId || identity.user.status !== "active") throw Object.assign(new Error("登录身份已变化，请重新连接设计讨论。"), { code: "SESSION_CHANGED" });
        return identity;
    }, [api, isCurrent, scope]);
    const panelApi = useMemo(() => ({ ...api, session: async () => { try { return await assertOwner(); } catch (error) { reportError(error); throw error; } } }), [api, assertOwner, reportError]);

    useEffect(() => {
        let alive = true;
        let timer;
        const connect = async () => {
            const [identity, models] = await Promise.all([api.session(), api.catalog()]);
            if (!identity?.user?.id || identity.user.status !== "active") throw new Error("请重新登录后使用设计讨论。");
            const owner = identity.user.id;
            if (!alive || !isCurrent()) return;
            const currentUser = useUserStore.getState();
            if ((mountedOwner.current && mountedOwner.current !== owner) || (currentUser.status === "authenticated" && currentUser.user?.id !== owner)) throw Object.assign(new Error("登录身份已变化，请重新进入画布后使用设计讨论。"), { code: "SESSION_CHANGED" });
            mountedOwner.current = owner;
            scope.ownerId = owner;
            const partitioned = partition(store, `${owner}:${encodeURIComponent(projectId)}:`);
            const saved = await partitioned.getItem("session");
            if (saved) {
                saved.references = await Promise.all(saved.references.map(restoreReference));
                if (saved.proposalBatch) saved.proposalBatch.references = await Promise.all(saved.proposalBatch.references.map(restoreReference));
            }
            if (!alive || !isCurrent()) return;
            setOwnerId(owner); setCatalog(models);
            const restored = saved || newStudioSession();
            sessionRef.current = restored; setSession(restored); sessionStore.current = partitioned;
            const runtime = createTaskController({ api, ownerId: owner, projectId, storage: partition(store, `${owner}:${encodeURIComponent(projectId)}:task:`), onChange: value => { if (alive && isCurrent()) setTasks(value); } });
            await runtime.load();
            if (!alive || !isCurrent()) return;
            controller.current = runtime; setReady(true);
            timer = setInterval(() => { if (isCurrent()) runtime.refreshAll().catch(reportError); }, 3000);
            await runtime.refreshAll();
        };
        connect().catch(error => { if (alive) reportError(error); });
        return () => { alive = false; clearInterval(timer); controller.current = null; sessionStore.current = null; };
    }, [api, projectId, store, scope, isCurrent, reportError]);

    useEffect(() => {
        if (!ready || !isCurrent()) return;
        let alive = true;
        Promise.all(nodes.filter(node => node.type === CanvasNodeType.Image && (node.metadata?.content || node.metadata?.storageKey)).map(nodeReference))
            .then(value => { if (alive && isCurrent()) setItems(value.filter(Boolean)); }).catch(error => { if (alive) reportError(error); });
        return () => { alive = false; };
    }, [nodes, ready, isCurrent, reportError]);
    const selectionKey = [...selectedIds].sort().join("|");
    useEffect(() => {
        const sequence = ++selectionSequence.current;
        if (!ready) return;
        const selected = nodesRef.current.filter(node => selectedIds.has(node.id) && node.type === CanvasNodeType.Image && (node.metadata?.content || node.metadata?.storageKey));
        if (selected.length > 4) { setNotice(`画布已选 ${selected.length} 张；本轮讨论最多 4 张，未遗漏截取，请减少选择后再讨论。`); return; }
        if (!selected.length) return;
        Promise.all(selected.map(nodeReference)).then(value => {
            if (!isCurrent() || sequence !== selectionSequence.current) return;
            const references = value.filter(Boolean).map(reference => ({ ...reference, role: sessionRef.current.references.find(item => item.id === reference.id)?.role || "auto" }));
            updateSession({ references });
            setNotice("");
        }).catch(reportError);
        return () => { selectionSequence.current++; };
    }, [selectionKey, ready, updateSession, isCurrent, reportError]);

    useEffect(() => {
        const shortcut = event => {
            if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.code === "Space") { event.preventDefault(); setPanelVisible(value => !value); }
            if (event.key === "Escape") setTaskView("closed");
        };
        window.addEventListener("keydown", shortcut);
        return () => window.removeEventListener("keydown", shortcut);
    }, [setPanelVisible]);

    const addImages = async (references, choose = true) => {
        assertWritable();
        const images = [];
        const center = getCanvasCenter();
        for (const [index, reference] of references.entries()) {
            const stored = await uploadImage(reference.image);
            assertWritable();
            const node = createCanvasNode(CanvasNodeType.Image, { x: center.x + (index % 3) * 370, y: center.y + Math.floor(index / 3) * 500 }, imageMetadata(stored));
            node.title = reference.title;
            Object.assign(node, fitNodeSize(stored.width, stored.height));
            images.push(node);
        }
        onBeforeChange();
        setNodes(current => isCurrent() ? [...current, ...images] : current);
        if (choose) {
            setSelectedIds(new Set(images.map(node => node.id)));
            if (images.length <= 4) {
                const resolved = await Promise.all(images.map(nodeReference));
                assertWritable();
                updateSession({ references: resolved });
            }
            else setNotice(`已添加 ${images.length} 张图片，请框选最多 4 张进入同一段讨论。`);
        }
        return images;
    };

    useEffect(() => {
        if (!ready || !isCurrent()) return;
        const install = async task => {
            for (const [index, url] of task.resultUrls.entries()) {
                const id = `design-${task.id}-${index}`;
                if (!isCurrent() || !writable.current) return;
                if (nodesRef.current.some(node => node.id === id) || scope.installed.has(id) || scope.adding.has(id) || scope.failed.has(id)) continue;
                scope.adding.add(id);
                try {
                    const video = task.mediaKind === "video";
                    const stored = video ? await storeGeneratedVideo({ url, mimeType: "video/mp4" }) : await uploadImage(url);
                    await assertOwner();
                    assertWritable();
                    const right = nodesRef.current.reduce((maximum, node) => Math.max(maximum, node.position.x + node.width), getCanvasCenter().x);
                    const node = createCanvasNode(video ? CanvasNodeType.Video : CanvasNodeType.Image, { x: right + 230, y: getCanvasCenter().y }, video ? videoMetadata(stored) : imageMetadata(stored));
                    node.id = id; node.title = task.proposal?.title || (video ? "设计视频" : "设计方案");
                    Object.assign(node, fitNodeSize(stored.width || 1280, stored.height || 720));
                    node.metadata = { ...node.metadata, sourceTaskId: task.taskId, prompt: task.prompt, designProposal: { title: node.title, features: task.proposal?.features || [], rationale: task.proposal?.rationale || "", references: task.references.map(reference => ({ title: reference.title, image: reference.image })) } };
                    onBeforeChange();
                    setNodes(current => !isCurrent() || current.some(item => item.id === id) ? current : [...current, node]);
                    scope.installed.add(id);
                    setInstallationErrors(current => { const next = { ...current }; delete next[id]; return next; });
                } catch (error) {
                    if (error.code === "SESSION_CHANGED" || error.status === 401) { reportError(error); return; }
                    if (isCurrent()) {
                        scope.failed.add(id);
                        setInstallationErrors(current => ({ ...current, [id]: error.message }));
                        setNotice("结果已完成，放入画布失败：" + error.message + "。可重试放入原结果，不要重新生成。");
                    }
                } finally { scope.adding.delete(id); }
            }
        };
        for (const task of tasks) if (task.ownerId === ownerId && task.projectId === projectId && task.status === "success" && task.resultUrls.length && writable.current) void install(task);
    }, [tasks, ready, ownerId, projectId, scope, isCurrent, assertOwner, reportError, installationRetry, setNodes, getCanvasCenter, onBeforeChange, writable]);

    const retryInstallation = task => {
        assertWritable();
        for (const [index] of task.resultUrls.entries()) scope.failed.delete(`design-${task.id}-${index}`);
        setInstallationErrors(current => Object.fromEntries(Object.entries(current).filter(([id]) => !id.startsWith(`design-${task.id}-`))));
        setInstallationRetry(value => value + 1);
    };

    const scopedTasks = isCurrent() ? tasks : [];
    const active = scopedTasks.filter(task => activeStatuses.has(task.status));
    const needsAttention = scopedTasks.filter(task => ["failed", "paused", "uncertain"].includes(task.status) || task.queryError || task.resultUrls.some((_, index) => installationErrors[`design-${task.id}-${index}`]));
    const action = (task, kind) => { if (isCurrent()) return controller.current?.action(task.id, kind).catch(reportError); };
    const continueTask = task => {
        if (!isCurrent()) return;
        updateSession({ ...newStudioSession(task.references), history: task.conversation || [], prompt: task.userText || task.prompt, brief: task.brief || {}, designRecord: continueDesignRecord(task), outputKind: task.mediaKind || "image", modelId: task.modelId });
        setPanelVisible(true); setTaskView("closed");
    };
    return <div className="canvas-design-discussion" data-testid="canvas-design-discussion">
        <div className="dd-island" onMouseEnter={() => setTaskView(value => value === "pinned" ? value : "preview")} onMouseLeave={() => setTaskView(value => value === "pinned" ? value : "closed")}>
            <div className="dd-pill"><button className="dd-launch" aria-label="打开设计讨论" aria-expanded={visible} onClick={() => { setPanelVisible(value => !value); setTaskView("closed"); }}><Sparkles size={17} /><span>{active.length ? `${active.length} 个创作任务进行中` : "创作随时开始"}</span></button><button aria-label="查看设计生成任务" aria-expanded={expanded} aria-pressed={taskView === "pinned"} onClick={() => setTaskView(value => value === "pinned" ? "closed" : "pinned")}>{needsAttention.length ? <span>{needsAttention.length}</span> : <ChevronDown size={14} />}</button></div>
            {expanded && <section className="dd-tasks" aria-label="设计生成任务"><header><strong>创作任务</strong><small>每个结果单独记录</small></header>{!scopedTasks.length ? <p>选中画布图片，打开设计讨论。<br />原有左侧创建与对话保持独立。</p> : [...scopedTasks].reverse().map(task => {
                const resultIds = task.resultUrls.map((_, index) => `design-${task.id}-${index}`);
                const failed = resultIds.some(id => installationErrors[id]);
                const placed = resultIds.length > 0 && resultIds.every(id => nodes.some(node => node.id === id));
                const label = failed ? "结果已完成 · 放入画布失败，可重试" : task.status === "success" && !placed && resultIds.length ? "结果已完成 · 正在放入画布" : taskLabel(task);
                return <article key={task.id} data-design-task-id={task.id} data-status={task.status}><div><strong>{task.proposal?.title || task.userText}</strong><small>{label}</small></div>{failed ? <button aria-label="重试放入设计结果" onClick={() => { try { retryInstallation(task); } catch (error) { reportError(error); } }}><RefreshCw size={15} /></button> : task.status === "success" && placed ? <button aria-label="定位设计结果" onClick={() => { if (isCurrent()) onLocate(resultIds); setTaskView("closed"); }}><LocateFixed size={16} /></button> : <button aria-label="查询原设计任务" onClick={() => action(task, task.status === "paused" && task.upstreamTaskId ? "recover" : "refresh")}><RefreshCw size={15} /></button>}<details><summary>方案、参考与执行记录</summary><p>{task.proposal?.features?.join("；")}</p><div className="dd-task-refs">{task.references.map(reference => <img key={reference.id} src={reference.image} alt={reference.title} />)}</div><p>{task.mediaKind === "video" ? "视频" : "图片"} · {task.model} · 每任务 1 个结果</p><p>请求：{task.requestId}</p>{task.failureReason && <p role="alert">{task.failureReason}</p>}{task.queryError && <p role="alert">{task.queryError}</p>}{resultIds.filter(id => installationErrors[id]).map(id => <p role="alert" key={id}>{installationErrors[id]}</p>)}{task.status === "failed" && <button onClick={() => continueTask(task)}>修改需求后新建任务（可能计费）</button>}</details></article>;
            })}</section>}
        </div>
        {notice && <div className="dd-notice" role="status"><span>{notice}</span><button aria-label="关闭设计讨论提示" onClick={() => setNotice("")}><X size={14} /></button></div>}
        {visible && !ready && <div className="dd-connect"><span>设计讨论尚未连接。</span><button onClick={() => setConnection(value => value + 1)}>重新连接</button></div>}
        <StudioPanel key={`${projectId}:${identityKey}:${connection}`} visible={visible} session={isCurrent() ? session : newStudioSession()} onChange={updateSession} items={isCurrent() ? items : []} onChoose={async references => { assertWritable(); updateSession({ references: references.map(reference => ({ ...reference, role: sessionRef.current.references.find(item => item.id === reference.id)?.role || "auto" })) }); }} onImport={async files => addImages(await readImageFiles(files))} onFigures={async (figures, name) => { try { await addImages(figures.map(figure => ({ title: `${name} · ${figure.label}`, image: figure.dataUrl || figure.image || figure.url })), false); } catch (error) { reportError(error); } }} api={panelApi} ownerId={isCurrent() ? ownerId : ""} catalog={isCurrent() ? catalog : null} ready={isCurrent() && ready && writable.current} brands={brands} onSave={async () => { assertWritable(); await saveQueue.current; assertWritable(); }} onSubmit={async input => { try { assertWritable(); if (!visibleRef.current) throw new Error("设计讨论已关闭，没有提交新的生成任务。"); if (!controller.current) throw new Error("设计讨论尚未连接，没有提交生成任务。"); return await controller.current.start(input); } catch (error) { reportError(error); throw error; } }} onClose={() => setPanelVisible(false)} onNotice={message => { if (isCurrent()) setNotice(message); }} />
    </div>;
}
