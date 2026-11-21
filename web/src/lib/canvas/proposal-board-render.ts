import { computeBoardLayout, type AnyProposalBoard, type BoardRect, type ProposalBoardSpec } from "./proposal-board";

export type BoardImageLoader = (item: ProposalBoardSpec["items"][number], signal?: AbortSignal) => Promise<ImageBitmap>;
export type BoardRenderOptions = { scale?: 1 | 2; signal?: AbortSignal };
const family = '"Geist Variable", "PingFang SC", "Microsoft YaHei", sans-serif';
const ink = "#202422",
    secondary = "#52615b";

function textInBox(ctx: CanvasRenderingContext2D, value: string, box: BoardRect, size: number, color: string, weight = 400) {
    const text = value.trim();
    if (!text) return;
    size = Math.min(size, box.height * 0.8);
    ctx.font = `${weight} ${size}px ${family}`;
    const measured = ctx.measureText(text).width;
    if (measured > box.width) {
        size *= Math.max(0.6, box.width / measured);
        ctx.font = `${weight} ${size}px ${family}`;
    }
    let label = text;
    if (ctx.measureText(text).width > box.width) {
        const chars = Array.from(text);
        let low = 0,
            high = chars.length;
        while (low < high) {
            const middle = Math.ceil((low + high) / 2);
            if (ctx.measureText(chars.slice(0, middle).join("") + "…").width <= box.width) low = middle;
            else high = middle - 1;
        }
        label = chars.slice(0, low).join("") + "…";
    }
    ctx.save();
    ctx.beginPath();
    ctx.rect(box.x, box.y, box.width, box.height);
    ctx.clip();
    ctx.textBaseline = "middle";
    ctx.fillStyle = color;
    ctx.fillText(label, box.x, box.y + box.height / 2);
    ctx.restore();
}

function swatch(ctx: CanvasRenderingContext2D, value: string, box: BoardRect) {
    if (!/^#[0-9a-f]{6}$/i.test(value)) return;
    ctx.fillStyle = value;
    ctx.fillRect(box.x, box.y, box.width, box.height);
}

export async function renderProposalBoard(
    spec: AnyProposalBoard,
    loadImage: BoardImageLoader,
    { scale = 1, signal }: BoardRenderOptions = {},
) {
    signal?.throwIfAborted();
    const layout = computeBoardLayout(spec);
    await document.fonts.ready;
    signal?.throwIfAborted();
    const canvas = document.createElement("canvas");
    canvas.width = layout.size.width * scale;
    canvas.height = layout.size.height * scale;
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) throw new Error("无法创建提案板画布");
    ctx.scale(scale, scale);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, layout.size.width, layout.size.height);
    textInBox(ctx, spec.title, layout.title, layout.title.height * 0.45, ink, 600);
    const drawItem = async (item: ProposalBoardSpec["items"][number], box: BoardRect) => {
        signal?.throwIfAborted();
        const image = await loadImage(item, signal);
        try {
            signal?.throwIfAborted();
            if (!image.width || !image.height) throw new Error("提案板原图尺寸无效");
            const ratio = Math.min(box.width / image.width, box.height / image.height);
            const w = image.width * ratio,
                h = image.height * ratio;
            ctx.drawImage(image, box.x + (box.width - w) / 2, box.y + (box.height - h) / 2, w, h);
        } finally {
            image.close();
        }
    };
    const byId = new Map(spec.items.map(item => [item.nodeId,item]));
    const slots = spec.version === 2 ? spec.cells.map(cell => ({
        item: byId.get(cell.styleNodeId), wear: spec.showWear ? byId.get(cell.wearNodeIds[0]) : undefined,
        caption: [cell.label, spec.showCode && cell.color?.code].filter(Boolean).join(" · "), hex: cell.color?.hex,
    })) : spec.items.map(item => ({ item, wear: undefined, caption:item.caption, hex:spec.layout === "colorway" ? item.dominantHex : undefined }));
    for (const [i, slot] of slots.entries()) {
        if (!slot.item) throw new Error("找不到提案款式原图");
        const box = layout.images[i], caption = layout.captions[i];
        if (slot.wear) {
            const gap = Math.min(12, box.height * 0.035), height = (box.height-gap)/2;
            await drawItem(slot.item,{...box,height});
            await drawItem(slot.wear,{...box,y:box.y+height+gap,height});
        } else await drawItem(slot.item,box);
        const chip = slot.hex ? Math.min(caption.height * 0.5, caption.width * 0.18) : 0;
        if (slot.hex) swatch(ctx,slot.hex,{x:caption.x,y:caption.y+(caption.height-chip)/2,width:chip,height:chip});
        const inset = chip ? chip + chip / 3 : 0;
        textInBox(ctx,slot.caption,{...caption,x:caption.x+inset,width:caption.width-inset},caption.height*0.48,secondary);
    }
    const palette = layout.palette;
    if (palette) {
        const entries = spec.palette.slice(0, 5),
            width = palette.width / entries.length;
        entries.forEach((entry, i) => {
            const x = palette.x + i * width,
                bar = palette.height * 0.46;
            swatch(ctx, entry.hex, { x, y: palette.y, width: width * 0.94, height: bar });
            textInBox(
                ctx,
                entry.label ? entry.label + " · " + entry.hex : entry.hex,
                { x, y: palette.y + bar, width: width * 0.94, height: palette.height - bar },
                bar * 0.55,
                secondary,
            );
        });
    }
    const fields = layout.fields;
    if (fields) {
        const labels = { styleNo: "款号", fabric: "面料", craft: "工艺", note: "备注" } as const;
        const keys = (Object.keys(labels) as Array<keyof typeof labels>).filter((k) => spec.fields[k].trim());
        const row = Math.min(fields.height / keys.length, layout.title.height * 1.2);
        keys.forEach((key, i) => {
            const y = fields.y + i * row;
            textInBox(ctx, labels[key], { ...fields, y, height: row * 0.38 }, row * 0.17, secondary, 500);
            textInBox(ctx, spec.fields[key], { ...fields, y: y + row * 0.38, height: row * 0.58 }, row * 0.26, ink);
        });
    }
    textInBox(
        ctx,
        [spec.footer.designer, spec.footer.date].filter(Boolean).join("　·　"),
        layout.footer,
        layout.footer.height * 0.44,
        secondary,
    );
    return canvas;
}
