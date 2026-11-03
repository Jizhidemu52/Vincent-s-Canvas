import { nanoid } from "nanoid";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData, type CanvasNodeGroup, type Position } from "@/types/canvas";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { CANVAS_EXAMPLE_OVERVIEW_PREFIX, canvasExampleLessons, canvasExampleNodePrefix, type CanvasExampleLessonId } from "./canvas-example-lessons";
import { createImageSequence } from "./canvas-image-sequence";
import { canvasExampleControlPrefix, canvasExampleControlSteps } from "./canvas-example-controls";

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
    addText(`${CANVAS_EXAMPLE_OVERVIEW_PREFIX}${makeId()}`, "设计教学画布 · 从这里开始", `设计教学画布\n10 类操作 · ${canvasExampleControlSteps.length} 项按钮详解 · 6 类单品\n\n右上“教学目录”可读案例、到练习；切到“按钮详解”，搜索按钮名即可定位独立图文步骤。全部内容都在这一张练习板中。`, { x: 0, y: 0 }, 1260, 340, 30);
    addText(`canvas-example-intro-${makeId()}`, "教材属性与使用边界", "帽子 / 包包 / 围巾 / 毛衫 / 女装 / 男装：Zara 风格的简约都市设计练习，非品牌官方款式。\n全部图片为 AI 教学素材，未调用本项目模型；并排的原款与教学效果是锁定示意，不是生成记录，也不连接配置。\n下方单品图可用于练习，正式设计请替换为你的单张原图。创建、阅读、连线、刷新均不会自动生成；手动运行配置或发送在线对话才可能产生费用。旧画布与历史保持独立。", { x: 0, y: 380 }, 1260, 340, 22);

    canvasExampleLessons.forEach((lesson, index) => {
        const x = index % 2 * 2140, y = 900 + Math.floor(index / 2) * 3120;
        const caseId = () => `${canvasExampleNodePrefix(lesson.id, "case")}${makeId()}`;
        const practiceId = () => `${canvasExampleNodePrefix(lesson.id, "practice")}${makeId()}`;
        addText(caseId(), `${lesson.number} · ${lesson.title}`, `${lesson.number}  ${lesson.title}\n${lesson.scenario}\n左：原款　右：教学效果（AI示意，非实测）`, { x, y }, 1820, 200, 28);
        for (const [imageIndex, imageRole] of ["source", "result"].entries()) nodes.push({ id: caseId(), type: CanvasNodeType.Image, title: imageRole === "source" ? `${lesson.productName} · 教材原款（AI示意，不作输入）` : `${lesson.productName} · 教学效果（AI示意，非实测）`, position: { x: x + imageIndex * 380, y: y + 230 }, width: 350, height: 233.3333, metadata: { content: `/design-examples/${lesson.product}${imageRole === "source" ? "-source" : ""}.webp`, naturalWidth: 1536, naturalHeight: 1024, mimeType: "image/webp", status: "idle", locked: true } });
        addText(caseId(), `${lesson.number} · 准备 / 操作 / 得到 / 注意`, `准备\n${lesson.prepare}\n\n操作\n${lesson.action}\n\n得到\n${lesson.result}\n\n注意\n${lesson.caution}`, { x: x + 800, y: y + 230 }, 1020, 680, 20);
        addText(practiceId(), `${lesson.number} · 可操作练习区`, "可操作练习区 · 单品图可替换，配置尚未运行\n先检查参考图、提示词、已启用模型与费用，再手动执行。", { x, y: y + 960 }, 1820, 130, 24);
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
        const source = image(lesson.product, `${lesson.number} · ${lesson.productName}单品原图（AI练习素材，可替换）`);
        if (lesson.id === "nodes") {
            addText(practiceId(), "包款要求 · 双击编辑", "仅将包身材质改为麂皮。\n保留包身轮廓、肩带原有皮革、连接位置和全部五金。", { x: x + 450, y: y + 1150 }, 390, 250);
            for (const [mediaIndex, type] of [CanvasNodeType.Video, CanvasNodeType.Audio].entries()) nodes.push({ id: practiceId(), type, title: `${type === "video" ? "视频" : "音频"}占位 · 请导入自己的文件`, position: { x: x + 950 + mediaIndex * 450, y: y + 1150 }, width: 400, height: 280, metadata: { status: "idle" } });
        } else if (lesson.id === "config") {
            const palette = image("scarf", "图2 · 围巾单品，只参考配色", 0, 300);
            config("毛衫海军蓝 · 合并参考，手动生成", "以图1毛衫为唯一主体，保持版型、领口、袖长和针织纹理；图2围巾仅参考深蓝色，不采用其格纹、形状或流苏。将毛衫主体改为海军蓝，单件白底商品图。", [source, palette]);
            addText(practiceId(), "配置检查单", "1. 模式：生图 / 合并参考\n2. @ 图1：毛衫结构\n3. @ 图2：只看深蓝配色\n4. 选支持提示词多参考改图的模型\n5. 核对任务数：本例 1 个任务\n\n未配置模型时请联系管理员。\n不要把上方左右对照图连进来。", { x: x + 1120, y: y + 1150 }, 600, 420);
        } else if (lesson.id === "connections") {
            const sequence = createImageSequence(source, [["女装马甲白底整理", "保留女装马甲版型、长度、领型、材质与全部结构，将背景整理为纯白，单件正面商品图。", "white_bg"], ["马甲3颗金色纽扣", "沿用上一步女装马甲，保持版型、颜色、领型和材质，只将正面3颗纽扣改为金色，数量和位置不变。", "custom"]], { x: x + 560, y: y + 1150 }, undefined, <T extends string>() => practiceId() as T);
            nodes.push(...sequence.nodes);
            connections.push(...sequence.connections);
            groups.push({ ...sequence.group, title: "练习：马甲白底 → 3金扣（尚未运行）" });
        } else if (lesson.id === "batch") {
            const second = image("scarf", "逐图任务2 · 同源副本，请替换自己的围巾图", 0, 290);
            const third = image("scarf", "逐图任务3 · 同源副本，请替换自己的围巾图", 430, 290);
            config("3张围巾 · 逐图执行（3个独立任务）", "以图片1作为当前唯一主图，只将围巾格纹配色调整为米白与深蓝，保留格纹排列、条纹宽度、流苏、轮廓与面料纹理。每张输出单件商品图，不拼接其它围巾。", [source, second, third], 960, "per-image");
            addText(practiceId(), "批量计数与收费", "合并参考：3图共同参与 → 1个任务\n逐图执行：3张主图 → 3个任务\n批量改图：N个文件 → N个结果\n\n串行工作流：上一步成功图成为下一步输入，每一步另调用。\n公共参考不等于额外主图；不同图的角色不可混淆。", { x: x + 1480, y: y + 1150 }, 450, 580, 21);
        } else if (lesson.id === "versions") {
            config("男装Polo细边 · 等你确认后生成", "以参考男装Polo衫为唯一主体，只在领口边缘和袖口边缘增加细米白色饰边，保留原有领型、门襟、袖长、纽扣、主体颜色和针织材质。输出单件白底商品图。", [source]);
            addText(practiceId(), "真实版本产生后再做", "原图 → 第一次结果 → 基于结果继续\n\n这里没有伪造的版本链、taskId或生成记录。\n生成成功后再学习恢复输入、同参数重做与对比；查询旧任务和重新生成不是同一件事。", { x: x + 1120, y: y + 1150 }, 650, 370);
        } else if (lesson.id === "compare") {
            const second = image("bag", "麂皮改款 · AI教学效果，可直接练对比", 560);
            second.metadata!.content = "/design-examples/bag.webp";
            addText(practiceId(), "对比检查点", "轮廓：包宽、包高、侧片是否变形？\n结构：肩带连接、五金数量与位置是否保留？\n材质：包身是否呈麂皮，肩带皮革纹理是否保留？\n范围：只改允许区域，背景保持一致。", { x: x + 1120, y: y + 1150 }, 650, 360);
        } else {
            const practice: Record<Exclude<CanvasExampleLessonId, "nodes" | "config" | "connections" | "batch" | "versions" | "compare">, string> = {
                view: "练习：选中左侧帽图 → Shift+2；H拖动视野 → V回到选择；Ctrl/Cmd+K 搜索“帽子”。\n这张单品图可以移动、复制和重命名，不会自动生成。",
                local: "练习：选中帽图 → 图片工具 → 裁剪，保留翻边局部作为新节点；撤销后再试切图。\n处理前后比较尺寸和像素，别把本地放大当作真实细节恢复。",
                assistant: "可手动复制到对话：\n只讨论这件毛衫：保留版型、袖长与针织纹理，列出换配色时要检查的细节，不生成图片。\n\n发送在线对话仍可能产生文本模型费用；此文本不会自动发送。",
                delivery: "练习：选中左侧女装单品 → 下载原件；回我的画布 → 导出这个教学项目作为备份。\n不要删除、清空或替换旧项目来练习。复制链接不会改变同事的访问权限。",
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
                addText(extraId(), "一图多方案 · 3条独立分支", "目标：同一帽款仅改变翻边配色，比较酒红 / 海军蓝 / 炭灰3种提案。\n操作：上方同一原图分别连入下方3个配置 → 分别选择可用模型 → 按需手动生成。配置之间不串接，结果互不影响。\n注意：3个配置全部运行会产生3个独立任务；这里没有预制生成记录，也不会自动执行。", { x, y: y + 1810 }, 1930, 240, 22);
                const original = addExtraImage("hat", "分支共同原图 · 帽子单品，可替换", 700);
                original.position.y = y + 2100;
                ["酒红", "海军蓝", "炭灰"].forEach((color, branchIndex) => {
                    const branch = addExtraConfig(`方案${branchIndex + 1} · 仅翻边${color}`, `保持这顶针织帽的帽型、翻边宽度、罗纹方向和细针织纹理；只将翻边改为${color}色，帽身颜色、形状与背景不变，单件商品图。`, branchIndex * 650);
                    branch.metadata!.composerContent = `@[node:${original.id}]\n${branch.metadata!.prompt}`;
                    connections.push({ id: makeId(), fromNodeId: original.id, toNodeId: branch.id });
                });
            } else {
                addText(extraId(), "共享配置 · 一套要求，3个单品任务", "目标：帽子、围巾与毛衫统一海军蓝色组，各自保留原结构与材质。\n操作：检查左侧共享配置 → 选择可用模型 → 核对“执行 3 个任务”后手动运行。连线从配置指向右侧3个目标，图片1是每个任务自己的主图。\n注意：不要再将3个目标反向连入配置，否则会变成公共参考而混图；全部运行会产生3个独立任务。", { x, y: y + 1810 }, 1930, 240, 22);
                const shared = addExtraConfig("共享配置 · 单品统一海军蓝", "以图片1当前单品为唯一主体，将主体配色调整为海军蓝，保留原有轮廓、大小比例与面料纹理；帽子保留翻边，围巾保留格纹明暗关系和流苏，毛衫保留领口、袖长和针织组织。只输出当前单品，不加入其它商品。", 0);
                shared.position.y += 180;
                [["hat", "帽子"], ["scarf", "围巾"], ["knit", "毛衫"]].forEach(([product, name], targetIndex) => {
                    const target = addExtraImage(product!, `共享目标${targetIndex + 1} · ${name}原图，可替换`, 900);
                    target.position.y += targetIndex * 300;
                    connections.push({ id: makeId(), fromNodeId: shared.id, toNodeId: target.id, kind: "config-target" });
                });
            }
        }
    });
    // A separate illustrated card for each small control, in the SAME project.
    // No fake result lineage is required to explain controls that need a real task.
    let rowY = 900;
    for (let row = 0; row < canvasExampleControlSteps.length; row += 2) {
        let rowHeight = 0;
        canvasExampleControlSteps.slice(row, row + 2).forEach(({ key, guide, step }, column) => {
            const lesson = canvasExampleLessons.find(item => item.id === guide.lessonId)!;
            const x = 4600 + column * 1560;
            const prefix = canvasExampleControlPrefix(key);
            const content = `${step.control}\n${guide.title} · ${guide.scenario}\n\n准备\n${guide.prepare}\n\n操作\n${step.action}\n\n得到\n${step.result}\n\n注意\n${guide.caution}`;
            // Conservative CJK line budget. Browser checks verify actual overflow.
            const lines = content.split("\n").reduce((sum, line) => sum + Math.max(1, Math.ceil([...line].length / 39)), 0);
            const height = Math.max(590, lines * 33 + 110);
            nodes.push({ id: `${prefix}image-${makeId()}`, type: CanvasNodeType.Image,
                title: `${step.control} · ${lesson.productName}教学素材`, position: { x, y: rowY }, width: 380, height: 253.3333,
                metadata: { content: `/design-examples/${lesson.product}-source.webp`, naturalWidth: 1536, naturalHeight: 1024, mimeType: "image/webp", status: "idle", locked: true } });
            addText(`${prefix}text-${makeId()}`, `按钮详解 · ${step.control}`, content, { x: x + 420, y: rowY }, 930, height, 20);
            rowHeight = Math.max(rowHeight, height);
        });
        rowY += rowHeight + 130;
    }
    return { nodes, connections, groups };
}
