import {createHash} from "node:crypto";
import {lstat,readFile,realpath,writeFile} from "node:fs/promises";
import {dirname,isAbsolute,join,relative,resolve,sep} from "node:path";
import {evaluate,type Evaluation} from "./score";

type Media={path:string;sha256:string};
export type Pair=Pick<Evaluation,"sampleId"|"modelIdentity"|"variant"|"repeat">&{product:Media;result:Media;mustKeep:string[];note:string};
const escape=(s:string)=>s.replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]!));
const key=(r:Pick<Evaluation,"sampleId"|"modelIdentity"|"variant"|"repeat">)=>JSON.stringify([r.sampleId,r.modelIdentity,r.variant,r.repeat]);
export async function writeContactSheet(manifest:string,group:string,round:number,rows:Evaluation[]){
    const root=await realpath(dirname(manifest)),pairs:Pair[]=JSON.parse(await readFile(manifest,"utf8"));
    if(!Array.isArray(pairs)||!pairs.length||pairs.length!==rows.length)throw Error("逐项原图和结果图不齐全");
    const indexed=new Map(pairs.map(p=>[key(p),p])),cache=new Map<string,string>(),cards:string[]=[];
    const image=async(m:Media)=>{
        if(!m||typeof m.path!=="string"||isAbsolute(m.path)||!m.path||!/^[a-f\d]{64}$/.test(m.sha256))throw Error("图像须给出目录内相对路径及 SHA-256");
        const absolute=await realpath(resolve(root,m.path)),rel=relative(root,absolute);
        if(!rel||rel===".."||rel.startsWith(".."+sep)||isAbsolute(rel)||!/\.(png|jpe?g|webp)$/i.test(rel))throw Error("只允许本次目录中的产品及结果图片");
        if(!cache.has(absolute)){
            const s=await lstat(absolute);if(!s.isFile()||s.size>32*1024*1024)throw Error("不是可用的原件文件");
            const bytes=await readFile(absolute);
            if(!(bytes.subarray(0,8).toString("hex")==="89504e470d0a1a0a"||bytes.subarray(0,3).toString("hex")==="ffd8ff"||(bytes.toString("ascii",0,4)==="RIFF"&&bytes.toString("ascii",8,12)==="WEBP")))throw Error("不支持的图片内容");
            cache.set(absolute,createHash("sha256").update(bytes).digest("hex"));
        }
        if(cache.get(absolute)!==m.sha256)throw Error("图片与评测回执指纹不一致");
        return rel.split(sep).map(encodeURIComponent).join("/");
    };
    for(const row of [...rows].sort((a,b)=>a.sampleId.localeCompare(b.sampleId)||a.modelIdentity.localeCompare(b.modelIdentity)||a.variant.localeCompare(b.variant)||a.repeat-b.repeat)){
        const p=indexed.get(key(row));if(!p||!Array.isArray(p.mustKeep)||!p.mustKeep.length||p.mustKeep.some(s=>typeof s!=="string"||!s.trim())||typeof p.note!=="string")throw Error("缺少对应样品、特征或评语");
        indexed.delete(key(row));const [a,b]=await Promise.all([image(p.product),image(p.result)]);
        const score=evaluate(row.reviewed??row.automatic),auto=evaluate(row.automatic);
        cards.push('<article><h2>'+escape(row.sampleId+" · "+row.modelIdentity)+'</h2><p>'+escape(row.variant)+' · 第 '+row.repeat+' 次</p><div class="pair"><figure><img loading="lazy" src="'+a+'" alt="产品原图"><figcaption>产品原图</figcaption></figure><figure><img loading="lazy" src="'+b+'" alt="上身结果"><figcaption>上身结果</figcaption></figure></div><p>须保留：'+escape(p.mustKeep.join("、"))+'</p><strong>'+score.score.toFixed(2)+' / 5 · '+(score.pass?"通过":"未通过")+'</strong><p>自动评分 '+auto.score.toFixed(2)+' · '+(row.reviewed?"已人工复核":"未人工抽查")+'</p><p>'+escape(p.note)+'</p></article>');
    }
    if(indexed.size)throw Error("存在未使用的图像回执");
    const title=escape(group)+" · 第 "+round+" 轮",out=join(root,"try-on-review-r"+round+"-"+encodeURIComponent(group)+".html");
    await writeFile(out,'<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src \'self\' file:; style-src \'unsafe-inline\'"><title>'+title+'</title><style>body{margin:2rem auto;padding:0 1rem;max-width:100rem;font:16px/1.5 system-ui;color:#1d2927;background:#f6f6f2}main{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(27rem,100%),1fr));gap:1rem}article{background:white;border:1px solid #ced3cd;padding:1rem;border-radius:.6rem}figure{margin:0}.pair{display:grid;grid-template-columns:1fr 1fr;gap:.4rem}img{width:100%;height:14rem;object-fit:contain}figcaption,p{color:#485651}p{overflow-wrap:anywhere}</style><h1>'+title+'</h1><p>原图与结果按样品排序；得分以人工修正优先。此报告不生成图像。</p><main>'+cards.join("")+'</main></html>',{flag:"wx"});
    return out;
}
