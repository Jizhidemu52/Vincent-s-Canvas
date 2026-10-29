import { uiText } from "@/lib/i18n";
import { setWorkbenchText, watchWorkbenchUi } from "../ui-text.js";
import { PROJECT_VERSION, MAX_LAYERS, clone, clamp, canvasPoint, pointInLayer, checkDimensions, validateProject, resizeBase } from "./model.js";
import { createProjectSession, mountProjectBar, sameProject } from "../project-session.js";

const STORAGE_KEY = "garment-pattern-placement-v1";
const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
const id = () => `layer-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
const same = sameProject;
const format = (value) => Math.round(value * 10) / 10;

export async function mountPlacement(root, services) {
    const { loadImage, readImageFile, downloadBlob, notify, signal } = services;
    const refreshUi = watchWorkbenchUi(root, signal);
    root.innerHTML = "<div class=\"placement-demo\"><div class=\"empty\"><span data-ui-text=\"正在准备服装定位工作台…\">正在准备服装定位工作台…</span></div></div>";
    refreshUi();
    const images = new Map();
    let live = true;
    let sequence = 0;
    let state;
    let selectedId;
    let undo = [];
    let redo = [];
    let drag = null;
    let editSnapshot = null;
    let projects;
    let exporting = false;
    const signalController = new AbortController();
    let observer;
    const cleanup = () => {
        if (!live) return;
        const capturedCanvas = root.querySelector("canvas");
        if (drag && capturedCanvas?.hasPointerCapture(drag.pointerId)) capturedCanvas.releasePointerCapture(drag.pointerId);
        live = false;
        sequence++;
        signalController.abort();
        projects?.dispose();
        observer?.disconnect();
        images.clear();
        undo = [];
        redo = [];
        drag = null;
        state = undefined;
        root.querySelectorAll("canvas").forEach((canvas) => {
            canvas.width = 1;
            canvas.height = 1;
        });
    };
    signal.addEventListener("abort", cleanup, { once: true });

    async function getImage(src) {
        if (!images.has(src)) images.set(src, loadImage(src));
        try {
            return await images.get(src);
        } catch (error) {
            images.delete(src);
            throw error;
        }
    }

    async function preparedProject(input) {
        const project = validateProject(input);
        const base = await getImage(project.base.src);
        checkDimensions(base.naturalWidth, base.naturalHeight);
        if (base.naturalWidth !== project.base.width || base.naturalHeight !== project.base.height) throw new Error("工程底图尺寸与图片实际尺寸不一致。");
        await Promise.all(
            project.layers.map(async (layer) => {
                const img = await getImage(layer.src);
                checkDimensions(img.naturalWidth, img.naturalHeight);
                const aspect = img.naturalWidth / img.naturalHeight;
                if (Math.abs(layer.aspect / aspect - 1) > 0.001) throw new Error("工程图案比例与图片实际比例不一致。");
            }),
        );
        return project;
    }

    async function demoProject() {
        const base = await getImage("/design-workbench/assets/garment.png");
        const flower = await getImage("/design-workbench/assets/flower.svg");
        return {
            type: "garment-pattern-placement",
            version: PROJECT_VERSION,
            base: { src: "/design-workbench/assets/garment.png", width: base.naturalWidth, height: base.naturalHeight, name: "蓝色短袖 · 示例底图" },
            layers: [
                {
                    id: id(),
                    name: "胸前花朵",
                    src: "/design-workbench/assets/flower.svg",
                    x: base.naturalWidth * 0.65,
                    y: base.naturalHeight * 0.43,
                    width: base.naturalWidth * 0.16,
                    aspect: flower.naturalWidth / flower.naturalHeight,
                    rotation: -6,
                    opacity: 0.95,
                    blend: "multiply",
                    visible: true,
                },
            ],
        };
    }

    try {
        state = await demoProject();
        if (!live || signal.aborted) return cleanup;
        for (const [src, imagePromise] of images) images.set(src, await imagePromise);
    } catch (error) {
        if (!live || signal.aborted) return cleanup;
        root.innerHTML = `<div class="placement-error">示例素材未能加载：${escapeHtml(error.message)}。请刷新重试。</div>`;
        return cleanup;
    }
    if (!live || signal.aborted) return cleanup;
    selectedId = state.layers[0].id;
    root.innerHTML = `<section class="placement-demo" aria-label="服装图案定位工作台" data-ui-aria-label="服装图案定位工作台">
    <div class="workspace">
      <aside class="panel placement-assets">
        <div class="panel-head"><span><span data-ui-text="素材与图层">素材与图层</span></span><span class="placement-subhead"><span data-ui-text="01 / 构图">01 / 构图</span></span></div>
        <div class="panel-body">
          <p class="placement-intro"><span data-ui-text="先选服装，再放图案。拖动胸前花朵，试试新的位置与比例。">先选服装，再放图案。拖动胸前花朵，试试新的位置与比例。</span></p>
          <button class="btn placement-upload" data-action="upload-base"><span data-ui-text="替换服装底图">替换服装底图</span></button>
          ${services.pickImage ? "<button class=\"btn ghost placement-upload\" data-action=\"asset-base\"><span data-ui-text=\"从素材库选择底图\">从素材库选择底图</span></button>" : ""}
          <p class="hint"><span data-ui-text="PNG / JPG / WebP，单张 ≤ 15 MB">PNG / JPG / WebP，单张 ≤ 15 MB</span><br><span data-ui-text="原图保持不变，仅在工作台中合成。">原图保持不变，仅在工作台中合成。</span></p>
          <div class="placement-divider"></div>
          <div class="section-title"><span data-ui-text="添加图案">添加图案</span></div>
          <div class="placement-materials">
            <button class="placement-material" data-asset="flower" aria-label="添加花朵图案" data-ui-aria-label="添加花朵图案"><img src="/design-workbench/assets/flower.svg" alt="" /><span data-ui-text="花朵">花朵</span></button>
            <button class="placement-material" data-asset="leaf" aria-label="添加枝叶图案" data-ui-aria-label="添加枝叶图案"><img src="/design-workbench/assets/leaf.svg" alt="" /><span data-ui-text="枝叶">枝叶</span></button>
            <button class="placement-material" data-asset="brand" aria-label="添加字标图案" data-ui-aria-label="添加字标图案"><img src="/design-workbench/assets/brand.svg" alt="" /><span data-ui-text="字标">字标</span></button>
          </div>
          <button class="btn ghost placement-upload" data-action="upload-art"><span data-ui-text="＋ 上传自己的图案">＋ 上传自己的图案</span></button>
          <p class="hint"><span data-ui-text="建议使用透明背景 PNG。最多 30 层。">建议使用透明背景 PNG。最多 30 层。</span></p>
          <div class="placement-divider"></div>
          <div class="section-title"><span data-ui-text="图层 ">图层 </span><span class="hint" data-layer-count></span></div>
          <ul class="placement-layers" aria-label="图案图层列表" data-ui-aria-label="图案图层列表"></ul>
          <div class="placement-layer-actions">
            <button class="btn" data-action="duplicate" title="复制选中图层" data-ui-title="复制选中图层"><span data-ui-text="复制">复制</span></button>
            <button class="btn" data-action="up" title="图层向上移一层" data-ui-title="图层向上移一层"><span data-ui-text="上移">上移</span></button>
            <button class="btn" data-action="down" title="图层向下移一层" data-ui-title="图层向下移一层"><span data-ui-text="下移">下移</span></button>
            <button class="btn" data-action="delete" title="删除选中图层" data-ui-title="删除选中图层"><span data-ui-text="删除">删除</span></button>
          </div>
          <div class="placement-base-row"><img data-base-thumb alt="" /><span class="placement-base-name"></span><span class="placement-locked"><span data-ui-text="已锁定">已锁定</span></span></div>
        </div>
      </aside>
      <div class="panel placement-center">
        <div class="stage-toolbar"><span class="placement-stage-label"><span data-ui-text="服装定位画布 ">服装定位画布 </span><span class="badge"><span data-ui-text="可拖动图案">可拖动图案</span></span></span><div class="toolbar"><button class="btn ghost" data-action="undo" title="Ctrl / ⌘ + Z"><span data-ui-text="撤销">撤销</span></button><button class="btn ghost" data-action="redo" title="Ctrl / ⌘ + Shift + Z"><span data-ui-text="重做">重做</span></button></div></div>
        <div class="placement-canvas-wrap"><canvas aria-label="服装图案定位画布，点击图案后拖动或使用方向键微调" data-ui-aria-label="服装图案定位画布，点击图案后拖动或使用方向键微调" tabindex="0"></canvas></div>
        <div class="placement-stage-footer"><span data-dimensions></span><span><span data-ui-text="方向键微调 1 像素 · 按住换挡键加速 10 像素">方向键微调 1 像素 · 按住换挡键加速 10 像素</span></span></div>
        <div class="placement-stage-footer"><span class="placement-status"><span data-ui-text="二维定位合成 · 不包含人工智能褶皱融合">二维定位合成 · 不包含人工智能褶皱融合</span></span><span data-selection-status></span></div>
      </div>
      <aside class="panel placement-inspector">
        <div class="panel-head"><span><span data-ui-text="定位参数">定位参数</span></span><span class="placement-subhead"><span data-ui-text="02 / 精调">02 / 精调</span></span></div>
        <div class="panel-body">
          <div><div data-controls></div><div class="placement-note"><span data-ui-text="坐标以服装底图左上角为原点，表示图案中心位置。底图始终锁定，图案等比缩放。正片叠底可保留部分底色明暗，但不产生真实褶皱变形。">坐标以服装底图左上角为原点，表示图案中心位置。底图始终锁定，图案等比缩放。正片叠底可保留部分底色明暗，但不产生真实褶皱变形。</span></div></div>
          <div class="placement-divider"></div>
          <div class="placement-delivery"><div class="section-title"><span data-ui-text="保存与交付">保存与交付</span></div>
            <button class="btn primary placement-export" data-action="export-png"><span data-ui-text="导出合成 PNG">导出合成 PNG</span></button>
            ${services.saveAsset ? "<button class=\"btn placement-export\" data-action=\"save-asset\"><span data-ui-text=\"保存合成图到素材库\">保存合成图到素材库</span></button>" : ""}
            <div class="placement-save-actions"><button class="btn" data-action="save"><span data-ui-text="本地保存">本地保存</span></button><button class="btn" data-action="open"><span data-ui-text="打开本地工程">打开本地工程</span></button><button class="btn ghost" data-action="export-json"><span data-ui-text="导出工程 JSON">导出工程 JSON</span></button><button class="btn ghost" data-action="import-json"><span data-ui-text="导入工程 JSON">导入工程 JSON</span></button></div>
            <p class="placement-save-state" aria-live="polite"></p>
            <button class="btn ghost placement-upload" data-action="reset"><span data-ui-text="恢复示例构图">恢复示例构图</span></button>
            <p class="hint"><span data-ui-text="PNG 为平面合成图；JSON 保留可编辑图层和上传图片。恢复示例可撤销并自动保存；要保留当前构图，请先新建工程。">PNG 为平面合成图；JSON 保留可编辑图层和上传图片。恢复示例可撤销并自动保存；要保留当前构图，请先新建工程。</span></p>
          </div>
        </div>
      </aside>
    </div>
    <input type="file" accept="image/png,image/jpeg,image/webp" data-input="base" hidden />
    <input type="file" accept="image/png,image/jpeg,image/webp" data-input="art" hidden />
    <input type="file" accept="application/json,.json" data-input="project" hidden />
  </section>`;
    const canvas = root.querySelector("canvas");
    const context = canvas.getContext("2d");
    const selected = () => state.layers.find((layer) => layer.id === selectedId);
    const query = (selector) => root.querySelector(selector);
    const eventOptions = { signal: signalController.signal };
    let updateProjects = () => {};
    projects = createProjectSession({
        services,
        key: STORAGE_KEY,
        snapshot: () => clone(state),
        fresh: demoProject,
        apply: async (data) => {
            const project = await preparedProject(data);
            await materializeImages();
            if (!live) return;
            sequence++;
            state = project;
            selectedId = state.layers.at(-1)?.id;
            undo = [];
            redo = [];
            editSnapshot = null;
            render();
        },
        onChange: (view) => {
            updateProjects(view);
            updateToolbar();
        },
    });
    updateProjects = mountProjectBar(root, projects);
    refreshUi();

    async function materializeImages() {
        const entries = [...images.entries()];
        await Promise.all(entries.map(async ([src, imagePromise]) => images.set(src, await imagePromise)));
    }

    function pushHistory(before) {
        if (same(before, state)) return;
        undo.push(before);
        if (undo.length > 60) undo.shift();
        redo = [];
        projects.changed();
    }

    function flushEdit() {
        if (editSnapshot) {
            pushHistory(editSnapshot);
            editSnapshot = null;
        }
    }

    function mutate(fn) {
        flushEdit();
        const before = clone(state);
        fn();
        pushHistory(before);
        render();
    }

    function draw(target = context, withSelection = true, project = state) {
        const targetCanvas = target.canvas;
        if (targetCanvas.width !== project.base.width) targetCanvas.width = project.base.width;
        if (targetCanvas.height !== project.base.height) targetCanvas.height = project.base.height;
        target.clearRect(0, 0, targetCanvas.width, targetCanvas.height);
        const base = images.get(project.base.src);
        if (base instanceof HTMLImageElement) target.drawImage(base, 0, 0, project.base.width, project.base.height);
        for (const layer of project.layers) {
            if (!layer.visible) continue;
            const image = images.get(layer.src);
            if (!(image instanceof HTMLImageElement)) continue;
            target.save();
            target.translate(layer.x, layer.y);
            target.rotate((layer.rotation * Math.PI) / 180);
            target.globalAlpha = layer.opacity;
            target.globalCompositeOperation = layer.blend;
            target.drawImage(image, -layer.width / 2, -layer.width / layer.aspect / 2, layer.width, layer.width / layer.aspect);
            target.restore();
        }
        const active = project.layers.find((layer) => layer.id === selectedId);
        if (withSelection && active?.visible) {
            const scale = project.base.width / Math.max(1, canvas.getBoundingClientRect().width);
            const w = active.width;
            const h = active.width / active.aspect;
            target.save();
            target.translate(active.x, active.y);
            target.rotate((active.rotation * Math.PI) / 180);
            target.strokeStyle = "#4b6f4d";
            target.lineWidth = 1.3 * scale;
            target.setLineDash([5 * scale, 3 * scale]);
            target.strokeRect(-w / 2, -h / 2, w, h);
            target.setLineDash([]);
            target.fillStyle = "#ffffff";
            for (const [x, y] of [
                [-w / 2, -h / 2],
                [w / 2, -h / 2],
                [-w / 2, h / 2],
                [w / 2, h / 2],
            ]) {
                target.fillRect(x - 3 * scale, y - 3 * scale, 6 * scale, 6 * scale);
                target.strokeRect(x - 3 * scale, y - 3 * scale, 6 * scale, 6 * scale);
            }
            target.restore();
        }
    }

    function updateToolbar() {
        query("[data-action=undo]").disabled = !undo.length;
        query("[data-action=redo]").disabled = !redo.length;
        const layer = selected();
        const index = state.layers.findIndex((item) => item.id === selectedId);
        for (const action of ["duplicate", "delete", "up", "down"]) query(`[data-action=${action}]`).disabled = !layer;
        query("[data-action=duplicate]").disabled = !layer || state.layers.length >= MAX_LAYERS;
        query("[data-action=up]").disabled = !layer || index >= state.layers.length - 1;
        query("[data-action=down]").disabled = !layer || index <= 0;
        query("[data-action=export-png]").disabled = exporting;
        if (query("[data-action=save-asset]")) query("[data-action=save-asset]").disabled = exporting;
        setWorkbenchText(query(".placement-save-state"), () => uiText("工程自动保存在当前账号的本机浏览器；可导出 JSON 备份。"));
        setWorkbenchText(query("[data-selection-status]"), () => layer ? uiText("选中：{value1}{value2}", { value1: layer.name, value2: layer.visible ? "" : uiText("（已隐藏）") }) : uiText("未选中图案"));
    }

    function numberControl(name, label, value, min, max, unit = "像素", step = 1, slider = false) {
        return `<label class="field"><span data-ui-text="${escapeHtml(label)}">${escapeHtml(uiText(label))}</span><div class="placement-number"><input aria-label="${escapeHtml(uiText(label))}" data-ui-aria-label="${escapeHtml(label)}" data-prop="${name}" type="number" min="${min}" max="${max}" step="${step}" value="${format(value)}" /><span data-ui-text="${escapeHtml(unit)}" style="white-space:nowrap;flex-shrink:0">${escapeHtml(uiText(unit))}</span></div>${slider ? `<input aria-label="${escapeHtml(uiText(label + "滑块"))}" data-ui-aria-label="${escapeHtml(label + "滑块")}" data-prop="${name}" type="range" min="${min}" max="${max}" step="${step}" value="${format(value)}" />` : ""}</label>`;
    }

    function renderControls() {
        const layer = selected();
        if (!layer) {
            query("[data-controls]").innerHTML = "<div class=\"placement-unselected\"><span data-ui-text=\"点击画布中的图案或左侧图层，开始调整位置。\">点击画布中的图案或左侧图层，开始调整位置。</span></div>";
            return;
        }
        query("[data-controls]").innerHTML =
            `<p class="section-title">${escapeHtml(layer.name)}</p><div class="placement-coordinate">${numberControl("x", "横向 X", layer.x, -state.base.width, state.base.width * 2)}${numberControl("y", "纵向 Y", layer.y, -state.base.height, state.base.height * 2)}</div>${numberControl("width", "图案宽度", layer.width, 1, state.base.width * 2, "像素", 1, true)}${numberControl("rotation", "旋转角度", layer.rotation, -180, 180, "°", 1, true)}${numberControl("opacity", "不透明度", layer.opacity * 100, 0, 100, "%", 1, true)}<label class="field"><span data-ui-text="混合模式">混合模式</span><select aria-label="混合模式" data-ui-aria-label="混合模式" data-blend><option value="source-over" data-ui-text="正常" ${layer.blend === "source-over" ? "selected" : ""}>正常</option><option value="multiply" data-ui-text="正片叠底" ${layer.blend === "multiply" ? "selected" : ""}>正片叠底</option></select></label>`;
    }

    function syncControls() {
        const layer = selected();
        if (!layer) return;
        for (const control of root.querySelectorAll("[data-prop]")) {
            if (document.activeElement !== control) control.value = format(control.dataset.prop === "opacity" ? layer.opacity * 100 : layer[control.dataset.prop]);
        }
        updateToolbar();
    }

    function render() {
        if (!live) return;
        query(".placement-layers").innerHTML = [...state.layers]
            .reverse()
            .map(
                (layer) =>
                    `<li class="placement-layer ${layer.id === selectedId ? "selected" : ""} ${layer.visible ? "" : "hidden-layer"}"><img src="${layer.src}" alt="" /><button class="placement-layer-select" data-select="${layer.id}" aria-pressed="${layer.id === selectedId}">${escapeHtml(layer.name)}</button><button class="placement-eye" data-toggle="${layer.id}" data-ui-label-action="${layer.visible ? "隐藏" : "显示"}" data-ui-label-name="${escapeHtml(layer.name)}" aria-label="${uiText(layer.visible ? "隐藏" : "显示")} ${escapeHtml(layer.name)}" data-ui-title="${layer.visible ? "隐藏图层" : "显示图层"}" title="${uiText(layer.visible ? "隐藏图层" : "显示图层")}" data-ui-text="${layer.visible ? "显" : "隐"}">${uiText(layer.visible ? "显" : "隐")}</button></li>`,
            )
            .join("");
        query("[data-layer-count]").textContent = `${state.layers.length} / 30`;
        query("[data-base-thumb]").src = state.base.src;
        query(".placement-base-name").textContent = state.base.name;
        setWorkbenchText(query("[data-dimensions]"), () => uiText("{value1} × {value2} 像素 · 原尺寸导出", { value1: state.base.width, value2: state.base.height }));
        renderControls();
        updateToolbar();
        refreshUi();
        draw();
    }

    function errorMessage(error) {
        if (live) notify(error?.message || "操作未成功，请重试。", "error");
    }

    async function addArtwork(src, name, operation = sequence) {
        if (state.layers.length >= MAX_LAYERS) throw new Error("最多支持 30 个图案图层，请先删除不需要的图层。");
        const image = await getImage(src);
        checkDimensions(image.naturalWidth, image.naturalHeight);
        await materializeImages();
        if (!live || sequence !== operation) return;
        if (state.layers.length >= MAX_LAYERS) throw new Error("最多支持 30 个图案图层。");
        mutate(() => {
            const layer = {
                id: id(),
                name,
                src,
                x: state.base.width * 0.5,
                y: state.base.height * 0.48,
                width: Math.max(1, state.base.width * 0.22),
                aspect: image.naturalWidth / image.naturalHeight,
                rotation: 0,
                opacity: 1,
                blend: "source-over",
                visible: true,
            };
            state.layers.push(layer);
            selectedId = layer.id;
        });
        notify("图案已添加，可直接拖动定位。");
    }

    async function importProject(input, operation, name = "导入工程") {
        const project = await preparedProject(input);
        await materializeImages();
        if (!live || operation !== sequence) return;
        await projects.create(name, project);
        notify("已导入为新工程，原有工程保留。");
    }

    async function action(name) {
        flushEdit();
        const layer = selected();
        if (name === "upload-base") return query("[data-input=base]").click();
        if (name === "upload-art") return query("[data-input=art]").click();
        if (name === "asset-base") {
            const operation = ++sequence;
            const asset = await services.pickImage();
            if (!asset || !live || sequence !== operation) return;
            const image = await getImage(asset.src);
            await materializeImages();
            if (!live || sequence !== operation) return;
            mutate(() => {
                state = resizeBase(state, { src: asset.src, name: asset.name, width: image.naturalWidth, height: image.naturalHeight });
            });
            notify("素材库底图已加入；工程保留图片副本，原素材不变。");
            return;
        }
        if (name === "import-json") return query("[data-input=project]").click();
        if (name === "undo" || name === "redo") {
            const source = name === "undo" ? undo : redo;
            const destination = name === "undo" ? redo : undo;
            if (!source.length) return;
            sequence++;
            destination.push(clone(state));
            state = source.pop();
            projects.changed();
            if (!selected()) selectedId = state.layers.at(-1)?.id;
            render();
            return;
        }
        if (["duplicate", "delete", "up", "down"].includes(name) && layer) {
            mutate(() => {
                const index = state.layers.indexOf(layer);
                if (name === "duplicate" && state.layers.length < MAX_LAYERS) {
                    const copy = { ...clone(layer), id: id(), name: `${layer.name.slice(0, 74)} 副本`, x: clamp(layer.x + 25, -state.base.width, state.base.width * 2), y: clamp(layer.y + 25, -state.base.height, state.base.height * 2) };
                    state.layers.splice(index + 1, 0, copy);
                    selectedId = copy.id;
                }
                if (name === "delete") {
                    state.layers.splice(index, 1);
                    selectedId = state.layers[Math.min(index, state.layers.length - 1)]?.id;
                }
                if (name === "up" && index < state.layers.length - 1) [state.layers[index], state.layers[index + 1]] = [state.layers[index + 1], state.layers[index]];
                if (name === "down" && index > 0) [state.layers[index], state.layers[index - 1]] = [state.layers[index - 1], state.layers[index]];
            });
            return;
        }
        if (name === "reset") {
            const operation = ++sequence;
            const project = await demoProject();
            await materializeImages();
            if (!live || operation !== sequence) return;
            mutate(() => {
                state = project;
                selectedId = state.layers[0].id;
            });
            notify("已恢复示例构图；可撤销，当前工程将自动保存。");
            return;
        }
        if (name === "save") {
            await projects.save();
            notify("可编辑工程已保存到当前账号的浏览器分区。");
            return;
        }
        if (name === "open") {
            root.querySelector(".workbench-project-bar select").focus();
            notify("使用顶部工程列表切换；当前更改会先保存。");
            return;
        }
        if (name === "export-json") {
            const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
            if (blob.size > 40 * 1024 * 1024) throw new Error("工程超过 40 MB 导入上限。请减少图层或使用更小的图片后导出。");
            downloadBlob(blob, "服装定位-可编辑工程.json");
            notify("工程 JSON 已导出，包含上传的图片数据。");
            return;
        }
        if (name === "export-png" || name === "save-asset") {
            if (exporting) return;
            exporting = true;
            updateToolbar();
            try {
                const snapshot = clone(state);
                const output = document.createElement("canvas");
                draw(output.getContext("2d"), false, snapshot);
                const blob = await new Promise((resolve) => output.toBlob(resolve, "image/png"));
                output.width = 1;
                output.height = 1;
                if (!blob) throw new Error("图片导出失败，请尝试使用较小的底图。");
                if (!live) return;
                const filename = `服装定位-${snapshot.base.width}x${snapshot.base.height}.png`;
                if (name === "save-asset") await services.saveAsset(blob, filename);
                else {
                    downloadBlob(blob, filename);
                    notify("PNG 已导出，不包含选择框，原始图片未修改。");
                }
            } finally {
                exporting = false;
                if (live) updateToolbar();
            }
        }
    }

    root.addEventListener(
        "click",
        (event) => {
            const target = event.target.closest("button");
            if (!target || !root.contains(target)) return;
            if (target.dataset.action) action(target.dataset.action).catch(errorMessage);
            if (target.dataset.select) {
                flushEdit();
                selectedId = target.dataset.select;
                render();
            }
            if (target.dataset.toggle)
                mutate(() => {
                    const layer = state.layers.find((item) => item.id === target.dataset.toggle);
                    if (layer) layer.visible = !layer.visible;
                });
            if (target.dataset.asset) {
                const names = { flower: "花朵图案", leaf: "枝叶图案", brand: "字标图案" };
                addArtwork(`/design-workbench/assets/${target.dataset.asset}.svg`, names[target.dataset.asset]).catch(errorMessage);
            }
        },
        eventOptions,
    );

    root.addEventListener(
        "focusin",
        (event) => {
            if (event.target.matches("[data-prop]") && !editSnapshot) editSnapshot = clone(state);
        },
        eventOptions,
    );

    root.addEventListener(
        "input",
        (event) => {
            const control = event.target;
            if (!control.matches("[data-prop]") || !selected()) return;
            if (!editSnapshot) editSnapshot = clone(state);
            const value = control.valueAsNumber;
            if (!Number.isFinite(value)) return;
            const clamped = clamp(value, Number(control.min), Number(control.max));
            selected()[control.dataset.prop] = control.dataset.prop === "opacity" ? clamped / 100 : clamped;
            projects.changed();
            draw();
            syncControls();
        },
        eventOptions,
    );

    root.addEventListener(
        "change",
        async (event) => {
            const input = event.target;
            if (input.matches("[data-prop]")) {
                flushEdit();
                syncControls();
                input.value = format(input.dataset.prop === "opacity" ? selected().opacity * 100 : selected()[input.dataset.prop]);
                return;
            }
            if (input.matches("[data-blend]")) {
                mutate(() => {
                    if (selected()) selected().blend = input.value;
                });
                return;
            }
            if (!input.matches("[data-input]")) return;
            const file = input.files?.[0];
            input.value = "";
            if (!file) return;
            const kind = input.dataset.input;
            const operation = kind === "art" ? sequence : ++sequence;
            try {
                if (kind === "project") {
                    if (file.size > 40 * 1024 * 1024) throw new Error("工程文件不能超过 40 MB。");
                    const text = await file.text();
                    let project;
                    try {
                        project = JSON.parse(text);
                    } catch {
                        throw new Error("无法读取该 JSON，请使用从服装定位工作台导出的工程文件。");
                    }
                    await importProject(project, operation, file.name.replace(/\.json$/i, "").slice(0, 80));
                } else {
                    const src = await readImageFile(file);
                    if (!live || sequence !== operation) return;
                    if (kind === "art") await addArtwork(src, file.name.slice(0, 80), operation);
                    else {
                        const image = await getImage(src);
                        checkDimensions(image.naturalWidth, image.naturalHeight);
                        await materializeImages();
                        if (!live || sequence !== operation) return;
                        mutate(() => {
                            state = resizeBase(state, { src, name: file.name.slice(0, 80), width: image.naturalWidth, height: image.naturalHeight });
                        });
                        notify("服装底图已替换；图案按新底图尺寸调整位置。原文件未修改。");
                    }
                }
            } catch (error) {
                errorMessage(error);
            }
        },
        eventOptions,
    );

    canvas.addEventListener(
        "pointerdown",
        (event) => {
            if (event.button !== 0) return;
            flushEdit();
            canvas.focus();
            const point = canvasPoint(event.clientX, event.clientY, canvas.getBoundingClientRect(), state.base.width, state.base.height);
            const layer = [...state.layers].reverse().find((item) => item.visible && item.opacity > 0 && pointInLayer(point, item));
            selectedId = layer?.id;
            if (layer) {
                drag = { pointerId: event.pointerId, before: clone(state), id: layer.id, offsetX: point.x - layer.x, offsetY: point.y - layer.y };
                canvas.setPointerCapture(event.pointerId);
                canvas.style.cursor = "grabbing";
            }
            render();
        },
        eventOptions,
    );

    canvas.addEventListener(
        "pointermove",
        (event) => {
            const point = canvasPoint(event.clientX, event.clientY, canvas.getBoundingClientRect(), state.base.width, state.base.height);
            if (!drag || event.pointerId !== drag.pointerId) {
                canvas.style.cursor = state.layers.some((item) => item.visible && item.opacity > 0 && pointInLayer(point, item)) ? "grab" : "default";
                return;
            }
            const layer = state.layers.find((item) => item.id === drag.id);
            if (!layer) return;
            layer.x = clamp(point.x - drag.offsetX, -state.base.width, state.base.width * 2);
            layer.y = clamp(point.y - drag.offsetY, -state.base.height, state.base.height * 2);
            projects.changed();
            draw();
            syncControls();
        },
        eventOptions,
    );

    const endDrag = (event) => {
        if (!drag || event.pointerId !== drag.pointerId) return;
        const finished = drag;
        drag = null;
        if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
        pushHistory(finished.before);
        canvas.style.cursor = "grab";
        render();
    };
    canvas.addEventListener("pointerup", endDrag, eventOptions);
    canvas.addEventListener("pointercancel", endDrag, eventOptions);

    root.addEventListener(
        "keydown",
        (event) => {
            if (event.target.matches("input, select, textarea") || event.target.isContentEditable) return;
            if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
                event.preventDefault();
                action(event.shiftKey ? "redo" : "undo").catch(errorMessage);
                return;
            }
            if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "y") {
                event.preventDefault();
                action("redo").catch(errorMessage);
                return;
            }
            if (event.key === "Delete" && selected()) {
                event.preventDefault();
                action("delete").catch(errorMessage);
                return;
            }
            const move = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
            if (move && selected()) {
                event.preventDefault();
                const step = event.shiftKey ? 10 : 1;
                mutate(() => {
                    selected().x = clamp(selected().x + move[0] * step, -state.base.width, state.base.width * 2);
                    selected().y = clamp(selected().y + move[1] * step, -state.base.height, state.base.height * 2);
                });
            }
        },
        eventOptions,
    );
    observer = new ResizeObserver(() => {
        if (live) draw();
    });
    observer.observe(canvas);
    render();
    root.querySelector(".placement-demo").inert = true;
    try {
        await projects.initialize();
    } catch (error) {
        errorMessage(error);
    } finally {
        if (live) root.querySelector(".placement-demo").inert = !projects.view().ready;
    }
    return cleanup;
}
