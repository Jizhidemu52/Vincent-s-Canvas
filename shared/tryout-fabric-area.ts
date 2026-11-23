import { z } from "zod";

const unit = z.number().int().min(0).max(1000);
const point = z.strictObject({ x: unit, y: unit });
export type FabricVertex = z.infer<typeof point>;
const turn = (a: FabricVertex, b: FabricVertex, c: FabricVertex) => (b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x);
function intersects(a: FabricVertex,b: FabricVertex,c: FabricVertex,d: FabricVertex) {
    if (Math.max(a.x,b.x)<Math.min(c.x,d.x)||Math.max(c.x,d.x)<Math.min(a.x,b.x)||Math.max(a.y,b.y)<Math.min(c.y,d.y)||Math.max(c.y,d.y)<Math.min(a.y,b.y)) return false;
    return turn(a,b,c)*turn(a,b,d)<=0 && turn(c,d,a)*turn(c,d,b)<=0;
}
export function validFabricBoundary(vertices: FabricVertex[]) {
    const n=vertices.length;
    if(n<3||n>64||new Set(vertices.map(p=>p.x+":"+p.y)).size!==n)return false;
    let area=0;
    for(let i=0;i<n;i++) {
        const a=vertices[i]!, b=vertices[(i+1)%n]!;
        area+=a.x*b.y-a.y*b.x;
        for(let j=i+2;j<n;j++) if(!(i===0&&j===n-1)&&intersects(a,b,vertices[j]!,vertices[(j+1)%n]!)) return false;
    }
    return Math.abs(area)>=200;
}
export function fabricCrossings(vertices: FabricVertex[], y:number) {
    const xs:number[]=[];
    for(let i=0;i<vertices.length;i++) {
        const a=vertices[i]!,b=vertices[(i+1)%vertices.length]!;
        if((a.y>y)!==(b.y>y)) xs.push(a.x+(y-a.y)*(b.x-a.x)/(b.y-a.y));
    }
    return xs.sort((a,b)=>a-b);
}
export const fabricBoundary=z.array(point).min(3).max(64).refine(validFabricBoundary,"请沿部位边缘依次点选，轮廓不能交叉或过小");
export const fabricArea=z.strictObject({vertices:fabricBoundary,useColor:z.boolean()});
