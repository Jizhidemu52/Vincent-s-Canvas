import { uiText } from "@/lib/i18n";
import { setWorkbenchText, watchWorkbenchUi } from "../ui-text.js";
import { MODES, cmToPx, periodSize, validateExport, wrapPosition, latticeCopies, mirrorCellTransform, hitElement, previewSize } from "./geometry.mjs";
import { createProjectSession, mountProjectBar } from "../project-session.js";
import { bindLocalImageDrop } from "../image-drop";

const STORE_KEY = "design-workbench.repeat.v1";
const BUILTINS = { flower: "/design-workbench/assets/flower.svg", leaf: "/design-workbench/assets/leaf.svg" };
const makeId = () => globalThis.crypto?.randomUUID?.() || `element-${Date.now()}-${Math.random()}`;

function defaultState() {
    return {
        version: 1,
        widthCm: 10,
        heightCm: 10,
        dpi: 150,
        mode: "half",
        background: "#f6f0df",
        transparent: false,
        elements: [
            { src: BUILTINS.leaf, name: "叶枝", x: 0.42, y: 0.08, size: 0.27, angle: 28 },
            { src: BUILTINS.leaf, name: "叶枝", x: 0.09, y: 0.66, size: 0.26, angle: -48 },
            { src: BUILTINS.leaf, name: "叶枝", x: 0.69, y: 0.46, size: 0.23, angle: 145 },
            { src: BUILTINS.leaf, name: "叶枝", x: 0.94, y: 0.9, size: 0.23, angle: 15 },
            { src: BUILTINS.flower, name: "花朵", x: 0.15, y: 0.17, size: 0.29, angle: -12 },
            { src: BUILTINS.flower, name: "花朵", x: 0.6, y: 0.76, size: 0.32, angle: 18 },
            { src: BUILTINS.flower, name: "花朵", x: 0.89, y: 0.26, size: 0.2, angle: 35 },
        ].map((item) => ({ ...item, id: makeId(), ratio: 1 })),
    };
}

export function sanitizeProject(input) {
    if (!input || input.version !== 1 || !Array.isArray(input.elements) || input.elements.length > 32) throw new Error("不是有效的花型项目，或元素超过 32 个");
    const bounded = (value, min, max, label) => {
        if (!Number.isFinite(value) || value < min || value > max) throw new Error(`${label}超出范围`);
        return value;
    };
    if (!Object.hasOwn(MODES, input.mode)) throw new Error("不支持的重复方式");
    if (!/^#[0-9a-f]{6}$/i.test(input.background)) throw new Error("背景颜色格式无效");
    const sources = new Set();
    const elements = input.elements.map((item, index) => {
        if (!item || typeof item.src !== "string" || !(Object.values(BUILTINS).includes(item.src) || /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(item.src))) throw new Error("项目中包含不支持的图片来源");
        if (item.src.length > 22_000_000) throw new Error("项目图片过大");
        sources.add(item.src);
        return {
            id: makeId(),
            src: item.src,
            name: typeof item.name === "string" ? item.name.slice(0, 30) : `元素 ${index + 1}`,
            x: bounded(item.x, 0, 1, "X"),
            y: bounded(item.y, 0, 1, "Y"),
            size: bounded(item.size, 0.05, 1.2, "元素尺寸"),
            angle: bounded(item.angle, -360, 360, "角度"),
            ratio: 1,
        };
    });
    if ([...sources].reduce((n, src) => n + src.length, 0) > 40_000_000) throw new Error("项目图片总量超过工作台的 40MB 限制");
    return {
        version: 1,
        widthCm: bounded(input.widthCm, 1, 60, "单元宽"),
        heightCm: bounded(input.heightCm, 1, 60, "单元高"),
        dpi: bounded(input.dpi, 72, 600, "DPI"),
        mode: input.mode,
        background: input.background,
        transparent: Boolean(input.transparent),
        elements,
    };
}

export async function mountRepeat(root, services) {
    const { loadImage, readImageFile, downloadBlob, notify, signal } = services;
    const refreshUi = watchWorkbenchUi(root, signal);
    let state = defaultState();
    let selectedId = null;
    let guides = true;
    let disposed = false;
    let drawing = false;
    let drag = null;
    let renderRequest = 0;
    let operationSequence = 0;
    let exporting = false;
    const images = new Map();
    root.innerHTML = `
    <div class="workspace repeat-workspace" data-testid="repeat-workspace">
      <aside class="panel repeat-left"><div class="panel-body">
        <div class="repeat-intro"><div class="repeat-kicker"><span data-ui-text="花型设计 / 02">花型设计 / 02</span></div><h2><span data-ui-text="让灵感">让灵感</span><br><span data-ui-text="自然重复。">自然重复。</span></h2><p class="hint"><span data-ui-text="拖动花叶，跨边自动衔接。">拖动花叶，跨边自动衔接。</span><br><span data-ui-text="本地几何计算，不使用人工智能。">本地几何计算，不使用人工智能。</span></p></div>
        <div class="repeat-mode" aria-label="重复方式" data-ui-aria-label="重复方式">${Object.entries(MODES)
            .map(([key, label]) => `<button type="button" data-mode="${key}" data-testid="repeat-mode-${key}" aria-pressed="${key === state.mode}" data-ui-text="${label}">${uiText(label)}</button>`)
            .join("")}</div>
        <section><div class="section-title"><span data-ui-text="设计单元">设计单元</span></div>
          <div class="repeat-grid2"><label class="field"><span><span data-ui-text="宽度 / 厘米">宽度 / 厘米</span></span><input data-setting="widthCm" data-testid="repeat-width" type="number" min="1" max="60" step=".1" value="10"></label><label class="field"><span><span data-ui-text="高度 / 厘米">高度 / 厘米</span></span><input data-setting="heightCm" data-testid="repeat-height" type="number" min="1" max="60" step=".1" value="10"></label></div>
          <label class="field"><span><span data-ui-text="输出分辨率 / DPI">输出分辨率 / DPI</span></span><select data-setting="dpi" data-testid="repeat-dpi"><option>72</option><option selected>150</option><option>300</option><option>600</option></select></label>
          <div class="hint mono" data-role="unit-pixels"></div>
          <div class="repeat-color"><input data-setting="background" type="color" value="#f6f0df" aria-label="背景颜色" data-ui-aria-label="背景颜色"><span><span data-ui-text="底布颜色">底布颜色</span></span></div>
          <label class="repeat-check"><input data-setting="transparent" data-testid="repeat-transparent" type="checkbox"><span data-ui-text="透明底色">透明底色</span></label>
        </section>
        <section><div class="section-title"><span data-ui-text="添加图案元素">添加图案元素</span></div><div class="repeat-assets"><button class="repeat-asset" data-add="flower" data-testid="repeat-add-flower"><img src="/design-workbench/assets/flower.svg" alt=""><span data-ui-text="花朵 +">花朵 +</span></button><button class="repeat-asset" data-add="leaf"><img src="/design-workbench/assets/leaf.svg" alt=""><span data-ui-text="叶枝 +">叶枝 +</span></button></div>
          <button class="btn ghost repeat-upload" data-action="upload" data-testid="repeat-upload"><span data-ui-text="＋ 上传自己的元素">＋ 上传自己的元素</span></button><input class="repeat-file" data-role="image-file" type="file" accept="image/png,image/jpeg,image/webp">
          ${services.pickImage ? "<button class=\"btn ghost repeat-upload\" data-action=\"asset-element\"><span data-ui-text=\"从素材库添加元素\">从素材库添加元素</span></button>" : ""}
          <p class="hint">PNG / JPG / WebP，≤ 15MB。<br><span data-ui-text="建议使用透明 PNG；不会自动抠图。">建议使用透明 PNG；不会自动抠图。</span></p>
          <div class="repeat-item-count" data-role="item-count"></div><div class="repeat-layer-list" data-role="layers" aria-label="图案元素" data-ui-aria-label="图案元素"></div>
        </section>
      </div></aside>
      <section class="repeat-stage" aria-label="花型编辑器" data-ui-aria-label="花型编辑器">
        <div class="stage-toolbar"><div><div class="repeat-stage-title"><span data-ui-text="设计单元 · ">设计单元 · </span><span data-role="mode-label"><span data-ui-text="半落">半落</span></span></div><div class="repeat-stage-sub"><span data-ui-text="拖动任意副本，编辑同一个元素">拖动任意副本，编辑同一个元素</span></div></div><label class="repeat-check repeat-guide-legend"><input data-role="guides" type="checkbox" checked><span data-ui-text="参考线">参考线</span></label></div>
        <div class="repeat-editor-wrap"><canvas class="repeat-editor-canvas" data-testid="repeat-canvas" tabindex="0" aria-label="可拖动的花型设计单元。方向键微移，Delete 删除所选图案。" data-ui-aria-label="可拖动的花型设计单元。方向键微移，Delete 删除所选图案。"></canvas></div>
        <div class="repeat-stage-footer"><span data-role="unit-label"><span data-ui-text="10 × 10 厘米">10 × 10 厘米</span></span><span><span data-ui-text="虚线为参考线，不进入导出">虚线为参考线，不进入导出</span></span></div>
        <div class="repeat-selection"><div class="repeat-selection-head"><span data-role="selection-name"><span data-ui-text="点击花叶开始编辑">点击花叶开始编辑</span></span><div class="repeat-inline-actions"><button class="btn ghost" data-action="duplicate" data-testid="repeat-duplicate" disabled><span data-ui-text="复制">复制</span></button><button class="btn ghost" data-action="delete" data-testid="repeat-delete" disabled><span data-ui-text="删除">删除</span></button></div></div>
          <div class="repeat-grid2"><label class="field"><span><span data-ui-text="元素宽度 ">元素宽度 </span><b data-role="size-label">—</b></span><input data-role="size" data-testid="repeat-size" type="range" min=".05" max="1.2" step=".01" value=".3" disabled></label><label class="field"><span><span data-ui-text="旋转 ">旋转 </span><b data-role="angle-label">—</b></span><input data-role="angle" data-testid="repeat-angle" type="range" min="-180" max="180" step="1" value="0" disabled></label></div>
          <div class="hint"><span data-ui-text="方向键微移 · 换挡键加速 · 删除键删除 · 退出键取消选择">方向键微移 · 换挡键加速 · 删除键删除 · 退出键取消选择</span></div>
        </div>
      </section>
      <aside class="panel repeat-right"><div class="panel-body">
        <section class="repeat-preview-group"><div class="repeat-kicker"><span data-ui-text="实时铺排">实时铺排</span></div><h2><span data-ui-text="连续效果">连续效果</span></h2><div class="hint"><span data-ui-text="3 × 3 设计单元 · 实时预览">3 × 3 设计单元 · 实时预览</span></div><div class="repeat-preview-box"><canvas class="repeat-preview-canvas" data-testid="repeat-preview" aria-label="3乘3花型重复预览" data-ui-aria-label="3乘3花型重复预览"></canvas></div><p class="repeat-period-note" data-role="period-note"></p></section>
        <section class="repeat-export-group"><div class="section-title"><span data-ui-text="导出可用文件">导出可用文件</span></div><div class="repeat-export-summary"><span><span data-ui-text="真实无缝周期 / PNG">真实无缝周期 / PNG</span></span><strong class="mono" data-role="export-pixels"></strong><span data-role="export-cm"></span></div>
          <button class="btn primary" data-action="export-unit" data-testid="repeat-export-unit"><span data-ui-text="↓ 导出无缝周期 PNG">↓ 导出无缝周期 PNG</span></button><button class="btn ghost" data-action="export-preview" data-testid="repeat-export-preview"><span data-ui-text="↓ 导出 3 × 3 预览 PNG">↓ 导出 3 × 3 预览 PNG</span></button>
          ${services.saveAsset ? "<button class=\"btn\" data-action=\"save-asset\"><span data-ui-text=\"保存无缝周期到素材库\">保存无缝周期到素材库</span></button>" : ""}
          <div class="repeat-warning" data-role="limit-warning"></div><div class="hint" data-role="preview-size"></div><p class="hint"><span data-ui-text="PNG 不嵌入 DPI 元数据。物理尺寸、DPI 与重复方式记录在项目 JSON 中。">PNG 不嵌入 DPI 元数据。物理尺寸、DPI 与重复方式记录在项目 JSON 中。</span></p>
        </section>
        <section class="repeat-save-group"><hr class="repeat-separator"><div class="section-title"><span data-ui-text="保留这次灵感">保留这次灵感</span></div><button class="btn ghost" data-action="save" data-testid="repeat-save"><span data-ui-text="保存到当前账号">保存到当前账号</span></button><button class="btn ghost" data-action="restore" data-testid="repeat-restore"><span data-ui-text="打开本地存档">打开本地存档</span></button><div class="repeat-grid2"><button class="btn ghost" data-action="export-json" data-testid="repeat-export-json"><span data-ui-text="导出 JSON">导出 JSON</span></button><button class="btn ghost" data-action="import-json"><span data-ui-text="打开 JSON">打开 JSON</span></button></div><input class="repeat-file" data-role="json-file" type="file" accept="application/json,.json"><div class="repeat-status" data-role="status" role="status" aria-live="polite"><span data-ui-text="当前账号的浏览器分区保存，不上传服务器。">当前账号的浏览器分区保存，不上传服务器。</span></div></section>
      </div></aside>
    </div>`;

    const $ = (selector) => root.querySelector(selector);
    const $$ = (selector) => [...root.querySelectorAll(selector)];
    const editorCanvas = $(".repeat-editor-canvas");
    const previewCanvas = $(".repeat-preview-canvas");
    const editorWrap = $(".repeat-editor-wrap");
    const currentItem = () => state.elements.find((item) => item.id === selectedId);
    let updateProjects = () => {};
    const projects = createProjectSession({
        services,
        key: STORE_KEY,
        snapshot: () => structuredClone(state),
        fresh: defaultState,
        apply: async (data) => {
            const project = sanitizeProject(data);
            await prepareImages(project);
            if (disposed) return;
            operationSequence++;
            state = project;
            selectedId = null;
            syncSettings();
        },
        onChange: (view) => updateProjects(view),
    });
    updateProjects = mountProjectBar(root, projects);
    refreshUi();
    function status(message, error = false) {
        if (disposed) return;
        setWorkbenchText($('[data-role="status"]'), message);
        $('[data-role="status"]').dataset.error = String(error);
    }
    function fail(error) {
        const raw = error?.message || String(error);
        const message = error instanceof SyntaxError ? "工程文件格式不正确，请选择有效的 JSON 文件。" : /[\u3400-\u9fff]/.test(raw) ? raw : "操作未完成，请检查输入文件或刷新后重试。";
        status(message, true);
        notify(message, "error");
    }
    async function prepareImages(project) {
        await Promise.all(
            [...new Set(project.elements.map((item) => item.src))].map(async (src) => {
                if (!images.has(src)) images.set(src, await loadImage(src));
            }),
        );
        for (const item of project.elements) {
            const image = images.get(item.src);
            item.ratio = image.naturalWidth / image.naturalHeight || 1;
            latticeCopies(item, 100, 100, 300, 300);
        }
    }
    function dimensions() {
        const width = cmToPx(state.widthCm, state.dpi),
            height = cmToPx(state.heightCm, state.dpi);
        return { width, height, period: validateExport(width, height, state.mode), preview: previewSize(width, height) };
    }
    function paintArtwork(ctx, width, height, fieldWidth, fieldHeight, mode) {
        for (const item of state.elements) {
            const image = images.get(item.src);
            if (!image) continue;
            for (const copy of latticeCopies(item, width, height, fieldWidth, fieldHeight, mode)) {
                ctx.save();
                ctx.translate(copy.x, copy.y);
                ctx.rotate((item.angle * Math.PI) / 180);
                ctx.drawImage(image, -copy.width / 2, -copy.height / 2, copy.width, copy.height);
                ctx.restore();
            }
        }
    }
    function paintField(canvas, width, height, cols, rows, mode, outputWidth, outputHeight) {
        const w = outputWidth || Math.max(1, Math.round(width * cols));
        const h = outputHeight || Math.max(1, Math.round(height * rows));
        if (canvas.width !== w) canvas.width = w;
        if (canvas.height !== h) canvas.height = h;
        const ctx = canvas.getContext("2d");
        ctx.clearRect(0, 0, w, h);
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";
        if (!state.transparent) {
            ctx.fillStyle = state.background;
            ctx.fillRect(0, 0, w, h);
        }
        if (mode !== "mirror") {
            paintArtwork(ctx, width, height, w, h, mode);
            return;
        }
        const base = document.createElement("canvas");
        base.width = Math.max(1, Math.ceil(width));
        base.height = Math.max(1, Math.ceil(height));
        paintArtwork(base.getContext("2d"), base.width, base.height, base.width, base.height, "straight");
        for (let row = 0; row < Math.ceil(rows); row++) {
            for (let col = 0; col < Math.ceil(cols); col++) {
                const transform = mirrorCellTransform(col, row, width, height);
                ctx.save();
                ctx.translate(transform.x, transform.y);
                ctx.scale(transform.scaleX, transform.scaleY);
                ctx.drawImage(base, 0, 0, width, height);
                ctx.restore();
            }
        }
        base.width = 1;
        base.height = 1;
    }
    function drawEditor() {
        const wrapRect = editorWrap.getBoundingClientRect();
        const ratio = state.widthCm / state.heightCm;
        const cssW = Math.max(20, Math.min(wrapRect.width - 76, (wrapRect.height - 76) * ratio, 610));
        const cssH = cssW / ratio;
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        editorCanvas.style.width = `${cssW}px`;
        editorCanvas.style.height = `${cssH}px`;
        const width = Math.round(cssW * dpr),
            height = Math.round(cssH * dpr);
        paintField(editorCanvas, width, height, 1, 1, state.mode === "half" ? "half" : "straight");
        const ctx = editorCanvas.getContext("2d");
        if (guides) {
            ctx.save();
            ctx.setLineDash([4 * dpr, 5 * dpr]);
            ctx.strokeStyle = "#53745666";
            ctx.lineWidth = dpr;
            ctx.beginPath();
            ctx.moveTo(width / 2, 0);
            ctx.lineTo(width / 2, height);
            ctx.moveTo(0, height / 2);
            ctx.lineTo(width, height / 2);
            ctx.stroke();
            ctx.restore();
        }
        const item = currentItem();
        if (item) {
            for (const copy of latticeCopies(item, width, height, width, height, state.mode === "half" ? "half" : "straight")) {
                ctx.save();
                ctx.translate(copy.x, copy.y);
                ctx.rotate((item.angle * Math.PI) / 180);
                ctx.strokeStyle = "#385a3c";
                ctx.lineWidth = 1.3 * dpr;
                ctx.setLineDash([5 * dpr, 3 * dpr]);
                ctx.strokeRect(-copy.width / 2 - 3 * dpr, -copy.height / 2 - 3 * dpr, copy.width + 6 * dpr, copy.height + 6 * dpr);
                ctx.restore();
            }
        }
    }
    function render() {
        renderRequest = 0;
        if (disposed || drawing) return;
        drawing = true;
        try {
            drawEditor();
            const ratio = state.widthCm / state.heightCm;
            const previewW = Math.min(700, Math.max(200, previewCanvas.parentElement.clientWidth * 2));
            const maxH = 700;
            const fieldW = Math.min(previewW, maxH * ratio),
                fieldH = fieldW / ratio;
            paintField(previewCanvas, fieldW / 3, fieldH / 3, 3, 3, state.mode, Math.round(fieldW), Math.round(fieldH));
        } catch (error) {
            fail(error);
        } finally {
            drawing = false;
        }
    }
    function requestRender() {
        if (!renderRequest && !disposed) renderRequest = requestAnimationFrame(render);
    }
    function syncDetails() {
        const { width, height, period, preview } = dimensions();
        setWorkbenchText($('[data-role="unit-pixels"]'), () => uiText("{value1} × {value2} 像素 / 设计单元", { value1: width, value2: height }));
        setWorkbenchText($('[data-role="unit-label"]'), () => uiText("{value1} × {value2} 厘米 · {value3} × {value4} 像素", { value1: state.widthCm, value2: state.heightCm, value3: width, value4: height }));
        setWorkbenchText($('[data-role="mode-label"]'), () => uiText(MODES[state.mode]));
        setWorkbenchText($('[data-role="export-pixels"]'), () => uiText("{value1} × {value2} 像素", { value1: period.width, value2: period.height }));
        const cm = periodSize(state.widthCm, state.heightCm, state.mode);
        setWorkbenchText($('[data-role="export-cm"]'), () => uiText("目标 {value1} × {value2} 厘米 / {value3} DPI", { value1: cm.width, value2: cm.height, value3: state.dpi }));
        setWorkbenchText($('[data-role="period-note"]'), () => state.mode === "half" ? uiText("半落：相邻列下移 ½ 高度。矩形无缝周期 = 2 宽 × 1 高。") : state.mode === "mirror" ? uiText("镜像：相邻行列交替翻转。无缝周期 = 2 宽 × 2 高。") : uiText("直排：左右、上下同位衔接。无缝周期 = 1 个设计单元。"));
        setWorkbenchText($('[data-role="limit-warning"]'), () => period.valid ? "" : uiText("周期尺寸超过限制：每边 ≤ 4096 像素，面积 ≤ 1600 万像素。请减小厘米尺寸或 DPI 后导出。"));
        $('[data-action="export-unit"]').disabled = !period.valid || exporting;
        $('[data-action="export-preview"]').disabled = exporting;
        if ($('[data-action="save-asset"]')) $('[data-action="save-asset"]').disabled = !period.valid || exporting;
        setWorkbenchText($('[data-role="preview-size"]'), () => uiText("3 × 3 预览导出 {value1} × {value2} 像素{value3}；不是新增的无缝周期。", { value1: preview.width, value2: preview.height, value3: preview.scale < 1 ? uiText("（已缩小，最长边 1600 像素）") : uiText("（原像素）") }));
        $$("[data-mode]").forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.mode === state.mode)));
        $('[data-setting="background"]').disabled = state.transparent;
        const selected = currentItem();
        setWorkbenchText($('[data-role="selection-name"]'), () => selected ? uiText("正在编辑 · {value1}", { value1: selected.name }) : uiText("点击花叶开始编辑"));
        $('[data-role="size"]').disabled = !selected;
        $('[data-role="angle"]').disabled = !selected;
        $('[data-action="duplicate"]').disabled = !selected || state.elements.length >= 32;
        $('[data-action="delete"]').disabled = !selected;
        if (selected) {
            $('[data-role="size"]').value = selected.size;
            $('[data-role="angle"]').value = selected.angle;
            $('[data-role="size-label"]').textContent = `${Math.round(selected.size * 100)}%`;
            $('[data-role="angle-label"]').textContent = `${selected.angle}°`;
        } else {
            $('[data-role="size-label"]').textContent = "—";
            $('[data-role="angle-label"]').textContent = "—";
        }
        setWorkbenchText($('[data-role="item-count"]'), () => uiText("{value1} / 32 个元素 · 点击编号选择", { value1: state.elements.length }));
        const layers = $('[data-role="layers"]');
        layers.replaceChildren();
        state.elements.forEach((item, index) => {
            const button = document.createElement("button");
            button.type = "button";
            button.textContent = `${index + 1} ${item.name}`;
            button.dataset.select = item.id;
            button.setAttribute("aria-pressed", String(item.id === selectedId));
            layers.append(button);
        });
        requestRender();
    }
    function syncSettings() {
        $$("[data-setting]").forEach((input) => {
            if (input.type === "checkbox") input.checked = state[input.dataset.setting];
            else input.value = state[input.dataset.setting];
        });
        syncDetails();
    }
    async function addElement(src, name) {
        const operation = operationSequence;
        if (state.elements.length >= 32) throw new Error("最多添加 32 个元素；请先删除一个");
        const item = { id: makeId(), src, name, x: 0.5, y: 0.5, size: 0.28, angle: 0, ratio: 1 };
        await prepareImages({ elements: [item] });
        if (disposed || operation !== operationSequence || projects.view().switching) return;
        if (state.elements.length >= 32) throw new Error("最多添加 32 个元素");
        state.elements.push(item);
        projects.changed();
        selectedId = item.id;
        syncDetails();
    }
    async function importImage(file, operation = operationSequence) {
        const src = await readImageFile(file);
        if (disposed || operation !== operationSequence || projects.view().switching) return;
        await addElement(src, file.name.replace(/\.[^.]+$/, "").slice(0, 16) || "上传图案");
        if (!disposed && operation === operationSequence) status("元素已加入。文件原有透明度保留，不自动去背景。");
    }
    bindLocalImageDrop(root, services, {
        scopeKey: () => operationSequence,
        disabled: () => disposed || exporting || !projects.view().ready || projects.view().switching,
        onFiles: async files => {
            if (state.elements.length + files.length > 32) throw new Error("最多添加 32 个元素；请先删除一个");
            const operation = operationSequence;
            for (const file of files) {
                if (disposed || operation !== operationSequence) return;
                await importImage(file, operation);
            }
        },
    });
    function deleteSelected() {
        if (!selectedId) return;
        state.elements = state.elements.filter((item) => item.id !== selectedId);
        projects.changed();
        selectedId = null;
        syncDetails();
    }
    function projectFile() {
        const { width, height, period } = dimensions();
        return {
            ...state,
            metadata: {
                tool: "Pattern Repeat Workbench",
                exportedAt: new Date().toISOString(),
                basePixels: { width, height },
                periodPixels: { width: period.width, height: period.height },
                pngDpiMetadata: false,
                imageDataEmbedded: true,
                note: "DPI 用于计算目标尺寸；PNG 文件不嵌入 DPI 元数据。",
            },
        };
    }
    async function pngDownload(kind, toAssets = false) {
        if (exporting) return;
        exporting = true;
        syncDetails();
        try {
            const { width, height, period, preview } = dimensions();
            if (kind === "unit" && !period.valid) throw new Error("无缝周期超出 4096 像素 / 1600 万像素限制");
            const canvas = document.createElement("canvas");
            if (kind === "unit") paintField(canvas, width, height, state.mode === "straight" ? 1 : 2, state.mode === "mirror" ? 2 : 1, state.mode, period.width, period.height);
            else paintField(canvas, preview.width / 3, preview.height / 3, 3, 3, state.mode, preview.width, preview.height);
            const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
            const sizeLabel = `${canvas.width}x${canvas.height}`;
            canvas.width = 1;
            canvas.height = 1;
            if (disposed) return;
            if (!blob) throw new Error("PNG 导出失败，请降低输出尺寸");
            const filename = `花型-${MODES[state.mode]}-${kind === "unit" ? "无缝周期" : "3×3预览"}-${sizeLabel}.png`;
            if (toAssets) {
                await services.saveAsset(blob, filename);
                status("无缝周期已保存到素材库。");
            } else {
                downloadBlob(blob, filename);
                status(() => uiText("已导出 {value1} 像素 {value2} PNG；不含 DPI 元数据。", { value1: sizeLabel.replace("x", " × "), value2: kind === "unit" ? uiText("无缝周期") : uiText("3 × 3 预览") }));
            }
        } finally {
            exporting = false;
            if (!disposed) syncDetails();
        }
    }
    const clickHandler = async (event) => {
        const button = event.target.closest("button");
        if (!button || !root.contains(button)) return;
        try {
            if (button.dataset.mode) {
                state.mode = button.dataset.mode;
                projects.changed();
                syncDetails();
                return;
            }
            if (button.dataset.add) {
                await addElement(BUILTINS[button.dataset.add], button.dataset.add === "flower" ? "花朵" : "叶枝");
                return;
            }
            if (button.dataset.select) {
                selectedId = button.dataset.select;
                syncDetails();
                return;
            }
            switch (button.dataset.action) {
                case "upload":
                    $('[data-role="image-file"]').click();
                    break;
                case "asset-element": {
                    const operation = operationSequence;
                    const asset = await services.pickImage();
                    if (asset && !disposed && operation === operationSequence) await addElement(asset.src, asset.name);
                    break;
                }
                case "save-asset":
                    button.disabled = true;
                    try {
                        await pngDownload("unit", true);
                    } finally {
                        if (!disposed) syncDetails();
                    }
                    break;
                case "delete":
                    deleteSelected();
                    break;
                case "duplicate": {
                    const item = currentItem();
                    if (!item || state.elements.length >= 32) return;
                    const copy = { ...item, id: makeId(), ...wrapPosition(item.x + 0.08, item.y + 0.08, state.mode) };
                    state.elements.push(copy);
                    projects.changed();
                    selectedId = copy.id;
                    syncDetails();
                    break;
                }
                case "export-unit":
                    await pngDownload("unit");
                    break;
                case "export-preview":
                    await pngDownload("preview");
                    break;
                case "save":
                    await projects.save();
                    status("已保存到当前账号。切换工具或刷新后可重新打开。");
                    notify("花型已保存到当前账号");
                    break;
                case "restore": {
                    root.querySelector(".workbench-project-bar select").focus();
                    status("使用顶部工程列表切换；当前更改会先保存。");
                    break;
                }
                case "export-json": {
                    const json = JSON.stringify(projectFile(), null, 2);
                    if (json.length > 50_000_000) throw new Error("项目 JSON 超过 50MB，请减少上传图片");
                    downloadBlob(new Blob([json], { type: "application/json" }), `花型-${MODES[state.mode]}-项目.json`);
                    status("项目 JSON 已导出；包含图片和物理尺寸参数。");
                    break;
                }
                case "import-json":
                    $('[data-role="json-file"]').click();
                    break;
            }
        } catch (error) {
            fail(error);
        }
    };
    const inputHandler = (event) => {
        const input = event.target;
        if (input.dataset.role === "size" || input.dataset.role === "angle") {
            const item = currentItem();
            if (!item) return;
            item[input.dataset.role] = Number(input.value);
            projects.changed();
            syncDetails();
        }
        if (input.dataset.setting === "background") {
            state.background = input.value;
            projects.changed();
            syncDetails();
        }
    };
    const changeHandler = async (event) => {
        const input = event.target;
        try {
            if (input.dataset.setting) {
                const key = input.dataset.setting;
                if (key === "transparent") state[key] = input.checked;
                else if (key === "background") state[key] = input.value;
                else {
                    const value = Number(input.value),
                        min = key === "dpi" ? 72 : 1,
                        max = key === "dpi" ? 600 : 60;
                    if (!Number.isFinite(value) || value < min || value > max) {
                        input.value = state[key];
                        throw new Error(`${key === "dpi" ? "DPI" : "尺寸"}范围为 ${min}–${max}`);
                    }
                    state[key] = value;
                }
                projects.changed();
                syncDetails();
            }
            if (input.dataset.role === "guides") {
                guides = input.checked;
                requestRender();
            }
            if (input.dataset.role === "image-file" && input.files[0]) {
                const file = input.files[0];
                await importImage(file);
                input.value = "";
            }
            if (input.dataset.role === "json-file" && input.files[0]) {
                if (input.files[0].size > 50_000_000) throw new Error("JSON 文件不得超过 50MB");
                const operation = ++operationSequence;
                const project = sanitizeProject(JSON.parse(await input.files[0].text()));
                await prepareImages(project);
                if (disposed || operation !== operationSequence) return;
                await projects.create(input.files[0].name.replace(/\.json$/i, "").slice(0, 80), project);
                status("已导入为新工程，原有工程保留。");
                input.value = "";
            }
        } catch (error) {
            if (input.type === "file") input.value = "";
            fail(error);
        }
    };
    function pointerDown(event) {
        if (event.button !== 0) return;
        editorCanvas.focus({ preventScroll: true });
        const rect = editorCanvas.getBoundingClientRect();
        const point = { x: ((event.clientX - rect.left) / rect.width) * editorCanvas.width, y: ((event.clientY - rect.top) / rect.height) * editorCanvas.height };
        let hit = null;
        for (const item of [...state.elements].reverse()) {
            if (latticeCopies(item, editorCanvas.width, editorCanvas.height, editorCanvas.width, editorCanvas.height, state.mode === "half" ? "half" : "straight").some((copy) => hitElement(point, copy, item.angle))) {
                hit = item;
                break;
            }
        }
        selectedId = hit?.id || null;
        if (hit) {
            drag = { id: hit.id, pointerId: event.pointerId, x: hit.x, y: hit.y, clientX: event.clientX, clientY: event.clientY, rect };
            editorCanvas.setPointerCapture(event.pointerId);
            editorCanvas.style.cursor = "grabbing";
        }
        syncDetails();
        event.preventDefault();
    }
    function pointerMove(event) {
        if (!drag) return;
        const item = state.elements.find((item) => item.id === drag.id);
        if (!item) return;
        Object.assign(item, wrapPosition(drag.x + (event.clientX - drag.clientX) / drag.rect.width, drag.y + (event.clientY - drag.clientY) / drag.rect.height, state.mode === "half" ? "half" : "straight"));
        projects.changed();
        requestRender();
    }
    function pointerUp(event) {
        drag = null;
        editorCanvas.style.cursor = "grab";
        if (editorCanvas.hasPointerCapture(event.pointerId)) editorCanvas.releasePointerCapture(event.pointerId);
    }
    function keyHandler(event) {
        const item = currentItem();
        if (event.key === "Escape") {
            selectedId = null;
            syncDetails();
            return;
        }
        if (!item) return;
        if (event.key === "Delete" || event.key === "Backspace") {
            event.preventDefault();
            deleteSelected();
            return;
        }
        const step = event.shiftKey ? 0.05 : 0.005;
        const moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
        if (moves[event.key]) {
            event.preventDefault();
            const [dx, dy] = moves[event.key];
            Object.assign(item, wrapPosition(item.x + dx, item.y + dy, state.mode === "half" ? "half" : "straight"));
            projects.changed();
            requestRender();
        }
    }
    root.addEventListener("click", clickHandler);
    root.addEventListener("input", inputHandler);
    root.addEventListener("change", changeHandler);
    editorCanvas.addEventListener("pointerdown", pointerDown);
    editorCanvas.addEventListener("pointermove", pointerMove);
    editorCanvas.addEventListener("pointerup", pointerUp);
    editorCanvas.addEventListener("pointercancel", pointerUp);
    editorCanvas.addEventListener("keydown", keyHandler);
    const observer = new ResizeObserver(requestRender);
    observer.observe(editorWrap);
    observer.observe(previewCanvas.parentElement);
    const cleanup = () => {
        if (disposed) return;
        disposed = true;
        projects.dispose();
        cancelAnimationFrame(renderRequest);
        observer.disconnect();
        if (drag && editorCanvas.hasPointerCapture(drag.pointerId)) editorCanvas.releasePointerCapture(drag.pointerId);
        root.removeEventListener("click", clickHandler);
        root.removeEventListener("input", inputHandler);
        root.removeEventListener("change", changeHandler);
        editorCanvas.removeEventListener("pointerdown", pointerDown);
        editorCanvas.removeEventListener("pointermove", pointerMove);
        editorCanvas.removeEventListener("pointerup", pointerUp);
        editorCanvas.removeEventListener("pointercancel", pointerUp);
        editorCanvas.removeEventListener("keydown", keyHandler);
        images.clear();
        drag = null;
        state.elements = [];
        editorCanvas.width = 1;
        editorCanvas.height = 1;
        previewCanvas.width = 1;
        previewCanvas.height = 1;
    };
    signal.addEventListener("abort", cleanup, { once: true });
    root.querySelector(".repeat-workspace").inert = true;
    try {
        await prepareImages(state);
        if (!disposed) {
            syncSettings();
            await projects.initialize();
        }
    } catch (error) {
        fail(error);
    } finally {
        if (!disposed) root.querySelector(".repeat-workspace").inert = !projects.view().ready;
    }
    return cleanup;
}
