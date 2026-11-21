import { expect, test } from "bun:test";
import { boardStaleItems, computeBoardLayout, defaultLayout, pageSize, type BoardRect, type ProposalBoardSpec } from "@/lib/canvas/proposal-board";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

function board(count: number): ProposalBoardSpec {
    return {
        version: 1, page: "a4-landscape", layout: defaultLayout(count, false), title: "秋冬系列",
        fields: { styleNo: "", fabric: "羊毛", craft: "", note: "" }, footer: { designer: "", date: "" },
        items: Array.from({ length: count }, (_, i) => ({ nodeId: String(i), storageKey: "s" + i, caption: "" })),
        showPalette: true, palette: [{ hex: "#357270" }],
    };
}

test("150dpi page sizes, default layouts, and same-source colourways", () => {
    expect(pageSize("a4-landscape")).toEqual({ width: 1754, height: 1240 });
    expect(pageSize("a4-portrait")).toEqual({ width: 1240, height: 1754 });
    expect(pageSize("wide-16-9")).toEqual({ width: 1920, height: 1080 });
    expect([1,2,3,4,5,6,7,8].map(n => defaultLayout(n, false))).toEqual(["single","compare","feature","feature","grid","grid","grid","grid"]);
    expect(defaultLayout(8, true)).toBe("colorway");
    expect(defaultLayout(1, true)).toBe("single");
    expect(() => computeBoardLayout(board(0))).toThrow();
    expect(() => computeBoardLayout(board(9))).toThrow();
});

const within = (n: number) => n >= -1e-7;
function overlap(a: BoardRect, b: BoardRect) {
    return Math.min(a.x+a.width,b.x+b.width) - Math.max(a.x,b.x) > 1e-7 &&
        Math.min(a.y+a.height,b.y+b.height) - Math.max(a.y,b.y) > 1e-7;
}

for (const page of ["a4-landscape","a4-portrait","wide-16-9"] as const) {
    for (const layout of ["single","compare","feature","grid","colorway"] as const) {
        test(`${page}: ${layout} keeps 1–8 images, captions and optional regions inside the page without overlap`, () => {
            for (let n=1; n<=8; n++) for (const hasFields of [false,true]) for (const showPalette of [false,true]) {
                const spec = { ...board(n), layout, page, showPalette };
                if (!hasFields) spec.fields.fabric = " ";
                const result = computeBoardLayout(spec);
                expect(result.images).toHaveLength(n);
                expect(result.captions).toHaveLength(n);
                expect(Boolean(result.fields)).toBe(hasFields);
                expect(Boolean(result.palette)).toBe(showPalette);
                const boxes=[result.title,...result.images,...result.captions,result.fields,result.palette,result.footer].filter((r): r is BoardRect=>r !== null);
                for (const [i,r] of boxes.entries()) {
                    expect(r.width>0 && r.height>0 && within(r.x) && within(r.y) && within(result.size.width-r.x-r.width) && within(result.size.height-r.y-r.height)).toBe(true);
                    expect(boxes.slice(i+1).every(s=>!overlap(r,s))).toBe(true);
                }
            }
        });
    }
}

test("hero, side-by-side, two grid rows and colorway strip retain the specified reading order", () => {
    const hero = computeBoardLayout(board(4)).images;
    expect(hero[0].width / hero[1].width).toBeCloseTo(1.5);
    expect(hero[0].x).toBeLessThan(hero[1].x);
    expect(hero[2].y).toBeGreaterThan(hero[1].y);
    expect(hero[2].x).toBe(hero[1].x);
    const pair = computeBoardLayout(board(2)).images;
    expect(pair[0].width).toBe(pair[1].width);
    expect(pair[0].y).toBe(pair[1].y);
    for (const n of [5,6,7,8]) {
        const cells=computeBoardLayout(board(n)).images;
        expect(new Set(cells.map(c=>c.y)).size).toBe(2);
        expect(new Set(cells.map(c=>c.x)).size).toBe(n<=6 ? 3 : 4);
        expect(new Set(computeBoardLayout({...board(n),layout:"colorway"}).images.map(c=>c.y)).size).toBe(1);
    }
    expect(computeBoardLayout({...board(1),palette:[]}).palette).toBeNull();
});

test("staleness identifies changed originals without dropping a deleted source or mistaking refreshed previews for new originals", () => {
    const spec=board(5);
    spec.items[3]={nodeId:"3",caption:"",serverAssetId:"asset1",content:"preview-a"};
    spec.items[4]={nodeId:"4",caption:"",serverAssetId:"asset2"};
    const node=(id:string,metadata:CanvasNodeData["metadata"]):CanvasNodeData=>({id,metadata,type:CanvasNodeType.Image,title:"",position:{x:0,y:0},width:1,height:1});
    const nodes=[node("1",{storageKey:"changed"}),node("2",{storageKey:"s2"}),node("3",{serverAssetId:"asset1",content:"preview-b"}),node("4",{serverAssetId:"replacement"})];
    expect(boardStaleItems(spec,new Map(nodes.map(n=>[n.id,n])))).toEqual([1,4]);
    expect(spec.items[0].storageKey).toBe("s0");
});
