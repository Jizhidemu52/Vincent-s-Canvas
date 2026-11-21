import {expect,test} from "bun:test";
import {mkdtemp,readFile,unlink,writeFile,rmdir} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createHash} from "node:crypto";
import {writeContactSheet,type Pair} from "../../tools/try-on-eval/report";
import type {Evaluation} from "../../tools/try-on-eval/score";

test("review sheet verifies local originals, preserves scores and never overwrites a prior report",async()=>{
    const dir=await mkdtemp(join(tmpdir(),"try-on-sheet-")),manifest=join(dir,"pairs.json"),pic=join(dir,"sample #1.png");
    const bytes=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAACXBIWXMAAAABAAAAAQBPJcTWAAAAFUlEQVR4nGP8////fwYGBgYWEAHCAD4KBAICIHhuAAAAAElFTkSuQmCC","base64");
    const media={path:"sample #1.png",sha256:createHash("sha256").update(bytes).digest("hex")};
    const marks={style:5,color:4,detail:5,wear:3,natural:5};
    const row:Evaluation={sampleId:"01",modelIdentity:"adult-a",variant:"base",repeat:1,elapsedMs:61,outputs:1,automatic:marks,reviewed:{...marks,wear:4}};
    const p:Pair={...row,product:media,result:media,mustKeep:["<翻边>"],note:"隔离样例"};
    let out:string|undefined;
    try{
        await writeFile(pic,bytes);await writeFile(manifest,JSON.stringify([p]));
        out=await writeContactSheet(manifest,"帽子",1,[row]);const html=await readFile(out,"utf8");
        expect(html).toContain("sample%20%231.png");expect(html).toContain("&lt;翻边&gt;");expect(html).toContain("4.60 / 5 · 通过");expect(html).not.toContain("<script");
        await expect(writeContactSheet(manifest,"帽子",1,[row])).rejects.toThrow();
        await writeFile(manifest,JSON.stringify([{...p,result:{...media,sha256:"0".repeat(64)}}]));
        await expect(writeContactSheet(manifest,"帽子",1,[row])).rejects.toThrow("指纹不一致");
    }finally{if(out)await unlink(out);await unlink(manifest);await unlink(pic);await rmdir(dir);}
});
