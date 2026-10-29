import { uiText } from "@/lib/i18n";
import { setWorkbenchText } from "./ui-text.js";
import { createClientUuid } from "../../../lib/client-uuid";

// Project revisions are small integers. Image data is cloned only when actually saving.
export function createProjectSession({ services, key, snapshot, apply, fresh, onChange = () => {}, delay = 700 }) {
    let catalog = { projects: [], activeId: null };
    let activeId = null;
    let revision = 0;
    let savedRevision = 0;
    let timer;
    let saving = null;
    let disposed = false;
    let ready = false;
    let switching = false;
    let error = "";
    const storageKey = (id) => (id === "legacy" ? key : `${key}:project:${id}`);
    const view = () => ({ projects: catalog.projects, activeId, dirty: revision !== savedRevision, saving: Boolean(saving), switching, error, ready });
    const emit = () => {
        services.setDirty?.(revision !== savedRevision);
        if (!disposed) onChange(view());
    };
    const newEntry = (name) => ({ id: createClientUuid(), name, updatedAt: new Date().toISOString() });
    async function save() {
        clearTimeout(timer);
        if (disposed || !ready) return;
        if (saving) {
            await saving;
            if (revision !== savedRevision) return save();
            return;
        }
        if (activeId && revision === savedRevision) return;
        const version = revision;
        const entry = catalog.projects.find((item) => item.id === activeId) || newEntry("未命名工程");
        const data = snapshot();
        error = "";
        saving = (async () => {
            await services.saveProject(storageKey(entry.id), data);
            const updated = { ...entry, updatedAt: new Date().toISOString() };
            const projects = [...catalog.projects.filter((item) => item.id !== entry.id), updated];
            await services.saveProject(`${key}:catalog`, { projects, activeId: entry.id });
            catalog = { projects, activeId: entry.id };
            activeId = entry.id;
            savedRevision = version;
        })();
        emit();
        try {
            await saving;
        } catch (cause) {
            error = cause?.message || "本地保存失败，请导出工程备份";
            throw cause;
        } finally {
            saving = null;
            emit();
        }
    }
    function changed() {
        if (!ready || disposed) return;
        revision++;
        error = "";
        clearTimeout(timer);
        emit();
        timer = setTimeout(() => {
            void save().catch(() => {});
        }, delay);
    }
    async function open(id) {
        if (switching) return;
        switching = true;
        emit();
        try {
            await save(); // A failed save must never discard the current editor.
            const data = await services.loadProject(storageKey(id));
            if (!data) throw new Error("工程不存在，请重新选择");
            await apply(data);
            activeId = id;
            revision++;
            savedRevision = revision;
            catalog.activeId = id;
            await services.saveProject(`${key}:catalog`, catalog);
        } finally {
            switching = false;
            emit();
        }
    }
    async function create(name = "新工程", imported) {
        if (switching) return;
        switching = true;
        emit();
        try {
            if (activeId || revision !== savedRevision) await save();
            const data = imported || (await fresh());
            await apply(data);
            const entry = newEntry(name);
            catalog.projects.push(entry);
            activeId = entry.id;
            revision++;
            emit();
            await save();
        } finally {
            switching = false;
            emit();
        }
    }
    async function rename(name) {
        if (!name.trim()) return;
        await save();
        catalog = { ...catalog, projects: catalog.projects.map((item) => (item.id === activeId ? { ...item, name: name.trim().slice(0, 80) } : item)) };
        await services.saveProject(`${key}:catalog`, catalog);
        emit();
    }
    async function initialize() {
        const saved = await services.loadProject(`${key}:catalog`);
        if (saved?.projects) catalog = saved;
        else if (await services.loadProject(key)) catalog.projects = [{ id: "legacy", name: "原有本地工程", updatedAt: "" }];
        const candidate = catalog.activeId || catalog.projects[0]?.id;
        if (candidate) {
            const data = await services.loadProject(storageKey(candidate));
            if (data) {
                await apply(data);
                activeId = candidate;
            }
        }
        ready = true;
        emit();
    }
    function dispose() {
        disposed = true;
        clearTimeout(timer);
    }
    return { initialize, changed, save, open, create, rename, view, dispose };
}

export function mountProjectBar(root, session) {
    const bar = document.createElement("div");
    bar.className = "workbench-project-bar";
    bar.innerHTML =
        "<label><span data-ui-text=\"工程 \">工程 </span><select aria-label=\"本地工程\" data-ui-aria-label=\"本地工程\"></select></label><button class=\"btn\" type=\"button\" data-project-new><span data-ui-text=\"新建工程\">新建工程</span></button><button class=\"btn ghost\" type=\"button\" data-project-rename><span data-ui-text=\"重命名\">重命名</span></button><span role=\"status\" data-project-status></span>";
    root.prepend(bar);
    const select = bar.querySelector("select");
    const report = (error) => {
        setWorkbenchText(bar.querySelector("[data-project-status]"), () => uiText(error.message));
    };
    select.onchange = () => {
        void session.open(select.value).catch(report);
    };
    bar.querySelector("[data-project-new]").onclick = () => {
        const name = prompt(uiText("新工程名称"), "新工程");
        if (name?.trim()) void session.create(name.trim().slice(0, 80)).catch(report);
    };
    bar.querySelector("[data-project-rename]").onclick = () => {
        const name = prompt(uiText("工程名称"), session.view().projects.find((item) => item.id === session.view().activeId)?.name || "未命名工程");
        if (name?.trim()) void session.rename(name).catch(report);
    };
    return (view) => {
        select.replaceChildren();
        if (!view.activeId) {
            const option = new Option(uiText("未保存工程"), "");
            option.dataset.uiText = "未保存工程";
            select.add(option);
        }
        for (const project of view.projects) select.add(new Option(project.name, project.id));
        select.value = view.activeId || "";
        for (const control of bar.querySelectorAll("button, select")) control.disabled = !view.ready || view.saving || view.switching;
        const editor = root.querySelector(".workspace");
        if (editor) editor.inert = !view.ready || view.switching;
        setWorkbenchText(bar.querySelector("[data-project-status]"), () => view.error ? uiText("保存失败：{value1} · 有未保存更改", { value1: view.error }) : view.saving ? uiText("正在保存…") : view.dirty ? uiText("有未保存更改 · 即将自动保存") : view.activeId ? uiText("已自动保存到本机") : uiText("编辑后自动保存到本机"));
    };
}

export function sameProject(a, b) {
    if (a === b) return true;
    if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every((key) => Object.hasOwn(b, key) && sameProject(a[key], b[key]));
}
