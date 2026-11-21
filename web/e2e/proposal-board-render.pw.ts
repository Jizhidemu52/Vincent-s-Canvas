import { test, expect } from "./fixtures";
import { PDFDocument } from "pdf-lib";
import type { ProposalBoardSpec } from "../src/lib/canvas/proposal-board";

test("proposal board fits entire originals, preserves print sizes and exports ordered image-only PDF pages locally", async ({
    page,
    api,
}, info) => {
    await page.route("**/board-render-test", (r) =>
        r.fulfill({ contentType: "text/html", body: "<!DOCTYPE html><html lang='zh-CN'><body></body></html>" }),
    );
    await page.goto("/board-render-test");
    const result = await page.evaluate(async () => {
        const { renderProposalBoard } = await import("/src/lib/canvas/proposal-board-render.ts");
        const { computeBoardLayout } = await import("/src/lib/canvas/proposal-board.ts");
        const { exportBoardPng, exportBoardsPdf } = await import("/src/lib/canvas/proposal-board-export.ts");
        const spec: ProposalBoardSpec = {
            version: 1,
            page: "a4-landscape",
            layout: "feature",
            title: "秋冬针织　｜　色彩提案",
            fields: { styleNo: "AW-018", fabric: "羊毛混纺", craft: "提花", note: "保留织物纹理" },
            footer: { designer: "设计部", date: "2026-11-21" },
            items: ["墨绿", "棕红", "深蓝"].map((caption, i) => ({ nodeId: String(i), caption })),
            palette: [
                { hex: "#357270", label: "墨绿" },
                { hex: "#984945", label: "棕红" },
                { hex: "#364a64", label: "深蓝" },
            ],
            showPalette: true,
        };
        const load = async (item: ProposalBoardSpec["items"][number]) => {
            const n = Number(item.nodeId),
                src = document.createElement("canvas");
            src.width = n === 0 ? 40 : 120;
            src.height = n === 0 ? 120 : 40;
            const c = src.getContext("2d")!;
            c.fillStyle = spec.palette[n].hex;
            c.fillRect(0, 0, src.width, src.height);
            c.fillStyle = "#ff0077";
            c.fillRect(0, 0, src.width, 10);
            c.fillStyle = "#132c1d";
            c.fillRect(0, src.height - 10, src.width, 10);
            return createImageBitmap(src);
        };
        const canvas = await renderProposalBoard(spec, load);
        canvas.style.width = "900px";
        document.body.append(canvas);
        const ctx = canvas.getContext("2d")!;
        const first = computeBoardLayout(spec).images[0],
            mid = first.x + first.width / 2;
        const pixel = (x: number, y: number) => [...ctx.getImageData(Math.floor(x), Math.floor(y), 1, 1).data];
        const png = await exportBoardPng(spec, load, { hd: true }),
            hd = await createImageBitmap(png);
        const hdSize = [hd.width, hd.height];
        hd.close();
        const pdf = await exportBoardsPdf([spec, { ...spec, page: "wide-16-9" }], load, { hd: false });
        const data = await pdf.arrayBuffer();
        const encoded = await new Promise<string>((r) => {
            const reader = new FileReader();
            reader.onload = () => r(String(reader.result).split(",")[1]);
            reader.readAsDataURL(new Blob([data]));
        });
        return {
            dimensions: [canvas.width, canvas.height],
            hdSize,
            firstTop: pixel(mid, first.y + 5),
            firstBottom: pixel(mid, first.y + first.height - 5),
            side: pixel(first.x + 2, first.y + first.height / 2),
            encoded,
        };
    });
    expect(result.dimensions).toEqual([1754, 1240]);
    expect(result.hdSize).toEqual([3508, 2480]);
    expect(result.firstTop).toEqual([255, 0, 119, 255]);
    expect(result.firstBottom).toEqual([19, 44, 29, 255]);
    expect(result.side).toEqual([255, 255, 255, 255]);
    const bytes = Buffer.from(result.encoded, "base64"),
        pdf = await PDFDocument.load(bytes);
    expect(pdf.getPages().map((p) => p.getSize())).toEqual([
        { width: 841.89, height: 595.28 },
        { width: 960, height: 540 },
    ]);
    expect(api.submissions).toHaveLength(0);
    await info.attach("proposal-board-pdf", { body: bytes, contentType: "application/pdf" });
    await page.locator("canvas").screenshot({ path: info.outputPath("proposal-board.png") });
});
