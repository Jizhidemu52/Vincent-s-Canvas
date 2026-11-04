import { nanoid } from "nanoid";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData, type CanvasNodeGroup, type Position } from "@/types/canvas";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { CANVAS_EXAMPLE_OVERVIEW_PREFIX, canvasExampleLessons, canvasExampleNodePrefix, type CanvasExampleLessonId } from "./canvas-example-lessons";
import { createImageSequence } from "./canvas-image-sequence";
import { canvasExampleControlPrefix, canvasExampleControlSteps } from "./canvas-example-controls";
import { canvasExampleControlProof, canvasExamplePractices, canvasPracticeImage } from "./canvas-example-practices";

export function createCanvasExampleProject() {
    const { createProject, updateProject } = useCanvasStore.getState();
    const id = createProject("设计教学画布 · 全功能操作案例");
    updateProject(id, { ...createCanvasExampleGraph(), viewport: { x: 56, y: 112, k: .7 } });
    return id;
}

/** A new editable teaching graph only: no dispatch, remote records or personal templates. */
export function createCanvasExampleGraph(makeId: () => string = nanoid) {
    const nodes: CanvasNodeData[] = [];
    const connections: CanvasConnection[] = [];
    const groups: CanvasNodeGroup[] = [];
    const addText = (id: string, title: string, content: string, position: Position, width: number, height: number, fontSize = 22) => {
        const node: CanvasNodeData = { id, type: CanvasNodeType.Text, title, position, width, height, metadata: { status: "idle", content, fontSize } };
        nodes.push(node);
        return node;
    };
    addText(`${CANVAS_EXAMPLE_OVERVIEW_PREFIX}${makeId()}`, "设计教学画布 · 从这里开始", `设计教学画布\n10 份流程画面 · ${Object.keys(canvasExampleControlProof).length} 项按钮配有实操截图\n\n右上“教学目录” → 设计案例：看输入、操作画面和结果。\n按钮详解保留 ${canvasExampleControlSteps.length} 项用法；没有截图的条目标注“未逐项实测”。`, { x: 0, y: 0 }, 1260, 340, 30);
    addText(`canvas-example-intro-${makeId()}`, "怎么使用这张教学板", "看图\n大图来自隔离本地画布，旁边写明按钮、输入与得到什么。\n\n动手\n到下方练习区操作，或替换成自己的图片。\n\n示例身份\nAI 效果参考不是本次生成记录；配置、工作流和助手草稿均未自动执行。", { x: 0, y: 380 }, 1260, 340, 22);

    canvasExampleLessons.forEach((lesson, index) => {
        const x = index % 2 * 2140, y = 900 + Math.floor(index / 2) * 3420;
        const caseId = () => `${canvasExampleNodePrefix(lesson.id, "case")}${makeId()}`;
        const practiceId = () => `${canvasExampleNodePrefix(lesson.id, "practice")}${makeId()}`;
        const practice = canvasExamplePractices[lesson.id];
        addText(caseId(), `${lesson.number} · ${lesson.title}`, `${lesson.number}  ${lesson.title}\n${lesson.scenario}\n左：输入与结果　右：本地实际操作画面（可双击放大）`, { x, y }, 1820, 200, 28);
        nodes.push({ id: caseId(), type: CanvasNodeType.Image, title: `${lesson.productName} · 输入原图 · AI教学素材`, position: { x, y: y + 230 }, width: 350, height: 233.3333, metadata: { content: `/design-examples/${lesson.product}-source.webp`, naturalWidth: 1536, naturalHeight: 1024, mimeType: "image/webp", status: "idle", locked: true } });
        nodes.push({ id: caseId(), type: CanvasNodeType.Image, title: practice.evidence, position: { x: x + 400, y: y + 230 }, width: 1420, height: 1420 * 900 / 1366, metadata: { content: canvasPracticeImage(practice.image), naturalWidth: 1366, naturalHeight: 900, mimeType: "image/jpeg", status: "idle", locked: true } });
        if (practice.resultImage) {
            addText(caseId(), practice.resultLabel!, practice.resultLabel!, { x, y: y + 475 }, 350, 95, 19);
            const ratio = (practice.resultHeight || 1024) / (practice.resultWidth || 1536);
            const width = Math.min(350, 230 / ratio);
            nodes.push({ id: caseId(), type: CanvasNodeType.Image, title: practice.resultLabel!, position: { x, y: y + 580 }, width, height: width * ratio, metadata: { content: practice.resultImage, naturalWidth: practice.resultWidth || 1536, naturalHeight: practice.resultHeight || 1024, mimeType: practice.resultImage.endsWith(".png") ? "image/png" : "image/webp", status: "idle", locked: true } });
        }
        addText(caseId(), `${lesson.number} · 实操简注`, `${practice.evidence}\n\n${practice.annotation}\n\n入口：${lesson.location}`, { x, y: y + (practice.resultImage ? 830 : 500) }, 350, practice.resultImage ? 420 : 740, 20);
        addText(practiceId(), `${lesson.number} · 可操作练习区`, "练习区\n选择下方单品图，按案例步骤操作；也可以替换为自己的图片。", { x, y: y + 960 }, 1820, 130, 24);
        const image = (product: string, title: string, offsetX = 0, offsetY = 0) => {
            const node: CanvasNodeData = { id: practiceId(), type: CanvasNodeType.Image, title, position: { x: x + offsetX, y: y + 1150 + offsetY }, width: 340, height: 226.6667, metadata: { content: `/design-examples/${product}-source.webp`, naturalWidth: 1536, naturalHeight: 1024, mimeType: "image/webp", status: "idle" } };
            nodes.push(node);
            return node;
        };
        const config = (title: string, prompt: string, sources: CanvasNodeData[], offsetX = 560, mode: "combined" | "per-image" = "combined") => {
            const node: CanvasNodeData = { id: practiceId(), type: CanvasNodeType.Config, title, position: { x: x + offsetX, y: y + 1150 }, width: 460, height: 480, metadata: { status: "idle", generationMode: "image", generationType: "edit", configImageInputMode: mode, count: 1, prompt, composerContent: mode === "per-image" ? prompt : `${sources.map((source, sourceIndex) => `图${sourceIndex + 1}：@[node:${source.id}]`).join("\n")}\n${prompt}` } };
            nodes.push(node);
            sources.forEach(source => connections.push({ id: makeId(), fromNodeId: source.id, toNodeId: node.id }));
            return node;
        };
        const source = image(lesson.product, `${lesson.number} · ${lesson.productName}单品图 · 可替换`);
        if (lesson.id === "nodes") {
            addText(practiceId(), "包款要求 · 双击编辑", "仅将包身材质改为麂皮。\n保留包身轮廓、肩带原有皮革、连接位置和全部五金。", { x: x + 450, y: y + 1150 }, 390, 250);
            for (const [mediaIndex, type] of [CanvasNodeType.Video, CanvasNodeType.Audio].entries()) nodes.push({ id: practiceId(), type, title: `${type === "video" ? "视频" : "音频"}占位 · 请导入自己的文件`, position: { x: x + 950 + mediaIndex * 450, y: y + 1150 }, width: 400, height: 280, metadata: { status: "idle" } });
        } else if (lesson.id === "config") {
            const palette = image("scarf", "图2 · 围巾单品，只参考配色", 0, 300);
            config("毛衫海军蓝 · 合并参考，手动生成", "以图1毛衫为唯一主体，保持版型、领口、袖长和针织纹理；图2围巾仅参考深蓝色，不采用其格纹、形状或流苏。将毛衫主体改为海军蓝，单件白底商品图。", [source, palette]);
            addText(practiceId(), "毛衫改色", "输入\n图1：毛衫款式；图2：围巾深蓝配色。\n\n操作\n打开配置 → 合并参考，选择模型并点击生成。\n\n结果\n毛衫换成海军蓝，保留原有版型与针织纹理。", { x: x + 1120, y: y + 1150 }, 600, 420);
        } else if (lesson.id === "connections") {
            const sequence = createImageSequence(source, [["女装马甲白底整理", "保留女装马甲版型、长度、领型、材质与全部结构，将背景整理为纯白，单件正面商品图。", "white_bg"], ["马甲3颗金色纽扣", "沿用上一步女装马甲，保持版型、颜色、领型和材质，只将正面3颗纽扣改为金色，数量和位置不变。", "custom"]], { x: x + 560, y: y + 1150 }, undefined, <T extends string>() => practiceId() as T);
            nodes.push(...sequence.nodes);
            connections.push(...sequence.connections);
            groups.push({ ...sequence.group, title: "练习：马甲白底 → 3金扣" });
        } else if (lesson.id === "batch") {
            const second = image("scarf", "逐图任务2 · 同源副本，请替换自己的围巾图", 0, 290);
            const third = image("scarf", "逐图任务3 · 同源副本，请替换自己的围巾图", 430, 290);
            config("3张围巾 · 逐图执行（3个独立任务）", "以图片1作为当前唯一主图，只将围巾格纹配色调整为米白与深蓝，保留格纹排列、条纹宽度、流苏、轮廓与面料纹理。每张输出单件商品图，不拼接其它围巾。", [source, second, third], 960, "per-image");
            addText(practiceId(), "围巾逐图改色", "输入\n3张围巾主图。\n\n操作\n配置 → 逐图执行，填写米白、深蓝配色要求并生成。\n\n结果\n3张围巾分别得到改色图。", { x: x + 1480, y: y + 1150 }, 450, 580, 21);
        } else if (lesson.id === "versions") {
            config("男装Polo细边 · 等你确认后生成", "以参考男装Polo衫为唯一主体，只在领口边缘和袖口边缘增加细米白色饰边，保留原有领型、门襟、袖长、纽扣、主体颜色和针织材质。输出单件白底商品图。", [source]);
            addText(practiceId(), "继续制作下一版", "输入\n已生成的男装 Polo 细边版本。\n\n操作\n选中结果 → AI 编辑 → 基于此图继续，填写下一版要求。\n\n结果\n保留当前版，追加新的修改版本。", { x: x + 1120, y: y + 1150 }, 650, 370);
        } else if (lesson.id === "compare") {
            const second = image("bag", "麂皮改款 · 对比练习图", 560);
            second.metadata!.content = "/design-examples/bag.webp";
            addText(practiceId(), "比较包款变化", "输入\n包款原图与麂皮版本。\n\n操作\n打开高级对比，拖动滑块查看包身、肩带和五金。\n\n结果\n看清哪些部分发生变化，选出需要保留的方案。", { x: x + 1120, y: y + 1150 }, 650, 360);
        } else {
            const practice: Record<Exclude<CanvasExampleLessonId, "nodes" | "config" | "connections" | "batch" | "versions" | "compare">, string> = {
                view: "输入\n左侧帽款图片。\n\n操作\n选中帽图 → Shift+2；按 H 拖动视野，按 V 回到选择。\n\n结果\n快速定位帽款并查看翻边细节。",
                local: "输入\n左侧帽款图片。\n\n操作\n图片工具 → 裁剪，框选翻边后确认。\n\n结果\n得到一张独立的翻边细节图。",
                assistant: "输入\n左侧毛衫图。\n\n操作\n打开对话，发送：只讨论这件毛衫，列出换配色时需保留的版型、袖长与针织细节。\n\n结果\n得到毛衫换色的设计检查建议。",
                delivery: "输入\n左侧女装单品图与当前画布。\n\n操作\n选图 → 下载原件；左上菜单 → 导出画布。\n\n结果\n得到单品原图和画布备份。",
            };
            addText(practiceId(), `${lesson.number} · 实操提示`, practice[lesson.id], { x: x + 560, y: y + 1150 }, 1080, 340, 24);
        }
        if (lesson.id === "connections" || lesson.id === "batch") {
            const area = lesson.id === "connections" ? "branches" : "shared";
            const extraId = () => `${canvasExampleNodePrefix(lesson.id, area)}${makeId()}`;
            const rowY = y + (area === "branches" ? 2400 : 2100);
            const addExtraImage = (product: string, title: string, offsetX: number) => {
                const node: CanvasNodeData = { id: extraId(), type: CanvasNodeType.Image, title, position: { x: x + offsetX, y: rowY }, width: 340, height: 226.6667, metadata: { content: `/design-examples/${product}-source.webp`, naturalWidth: 1536, naturalHeight: 1024, mimeType: "image/webp", status: "idle" } };
                nodes.push(node);
                return node;
            };
            const addExtraConfig = (title: string, prompt: string, offsetX: number) => {
                const node: CanvasNodeData = { id: extraId(), type: CanvasNodeType.Config, title, position: { x: x + offsetX, y: rowY }, width: 440, height: 480, metadata: { status: "idle", generationMode: "image", generationType: "edit", configImageInputMode: "combined", count: 1, prompt, composerContent: prompt } };
                nodes.push(node);
                return node;
            };
            if (area === "branches") {
                addText(extraId(), "一图多方案 · 3条独立分支", "输入\n同一张帽款原图。\n操作\n原图分别连入3个配置，填写酒红、海军蓝、炭灰翻边要求并生成。\n结果\n得到同款帽子的3种独立配色方案。", { x, y: y + 1810 }, 1930, 280, 22);
                const original = addExtraImage("hat", "分支共同原图 · 帽子单品，可替换", 700);
                original.position.y = y + 2100;
                ["酒红", "海军蓝", "炭灰"].forEach((color, branchIndex) => {
                    const branch = addExtraConfig(`方案${branchIndex + 1} · 仅翻边${color}`, `保持这顶针织帽的帽型、翻边宽度、罗纹方向和细针织纹理；只将翻边改为${color}色，帽身颜色、形状与背景不变，单件商品图。`, branchIndex * 650);
                    branch.metadata!.composerContent = `@[node:${original.id}]\n${branch.metadata!.prompt}`;
                    connections.push({ id: makeId(), fromNodeId: original.id, toNodeId: branch.id });
                });
            } else {
                addText(extraId(), "共享配置 · 一套要求，3个单品任务", "输入\n帽子、围巾、毛衫3张主图。\n操作\n从左侧共享配置连接右侧3张目标图，写统一海军蓝要求，点击执行3个任务。\n结果\n3个单品各自保留款式，形成统一色组。", { x, y: y + 1810 }, 1930, 280, 22);
                const shared = addExtraConfig("共享配置 · 单品统一海军蓝", "以图片1当前单品为唯一主体，将主体配色调整为海军蓝，保留原有轮廓、大小比例与面料纹理；帽子保留翻边，围巾保留格纹明暗关系和流苏，毛衫保留领口、袖长和针织组织。只输出当前单品，不加入其它商品。", 0);
                shared.position.y += 180;
                [["hat", "帽子"], ["scarf", "围巾"], ["knit", "毛衫"]].forEach(([product, name], targetIndex) => {
                    const target = addExtraImage(product!, `共享目标${targetIndex + 1} · ${name}原图，可替换`, 900);
                    target.position.y += targetIndex * 300;
                    connections.push({ id: makeId(), fromNodeId: shared.id, toNodeId: target.id, kind: "config-target" });
                });
            }
        }
        // Keep real editable practice below the larger, captured operation board.
        for (const node of nodes) if (node.id.startsWith(`canvas-example-${lesson.id}-`) && !node.id.startsWith(canvasExampleNodePrefix(lesson.id, "case"))) node.position.y += 300;
    });
    // Actual operation captures are attached only to verified controls. The rest
    // remain searchable usage notes, not unrelated product pictures or fake proof.
    let rowY = 900;
    for (let row = 0; row < canvasExampleControlSteps.length; row += 2) {
        let rowHeight = 0;
        canvasExampleControlSteps.slice(row, row + 2).forEach(({ key, guide, step }, column) => {
            const x = 4600 + column * 1560;
            const prefix = canvasExampleControlPrefix(key);
            const proof = canvasExampleControlProof[key];
            const content = `${step.control}\n${proof?.evidence || "用法说明 · 未逐项实测"}\n入口：${guide.location}\n\n输入\n${guide.prepare}\n\n操作\n${step.action}\n\n结果说明\n${step.result}${proof?.annotation ? `\n\n实操图解\n${proof.annotation}` : ""}`;
            // Conservative CJK line budget. Browser checks verify actual overflow.
            const lines = content.split("\n").reduce((sum, line) => sum + Math.max(1, Math.ceil([...line].length / 52)), 0);
            const height = Math.max(500, lines * 33 + 110);
            if (proof) nodes.push({ id: `${prefix}image-${makeId()}`, type: CanvasNodeType.Image,
                title: proof.evidence, position: { x, y: rowY }, width: 1350, height: 1350 * 900 / 1366,
                metadata: { content: canvasPracticeImage(proof.image), naturalWidth: 1366, naturalHeight: 900, mimeType: "image/jpeg", status: "idle", locked: true } });
            addText(`${prefix}text-${makeId()}`, `按钮详解 · ${step.control}`, content, { x, y: rowY + (proof ? 930 : 0) }, 1350, height, 22);
            rowHeight = Math.max(rowHeight, height + (proof ? 930 : 0));
        });
        rowY += rowHeight + 130;
    }
    return { nodes, connections, groups };
}
