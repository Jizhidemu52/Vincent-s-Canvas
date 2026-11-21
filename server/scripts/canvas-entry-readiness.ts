import {createDatabase} from "../src/db";
import {canvasEntryReadiness} from "../src/canvas-entry-readiness";

if(import.meta.main){
    if(process.argv.length!==2||!process.env.DATABASE_URL)throw Error("需要当前部署的 DATABASE_URL；不接受账户筛选或写入参数");
    const db=createDatabase(process.env.DATABASE_URL),c=await db.connect();
    try{
        await c.query("BEGIN READ ONLY");
        await c.query("SET LOCAL statement_timeout='10s'");
        console.log(JSON.stringify(await canvasEntryReadiness(c,new Date()),null,2));
    }finally{try{await c.query("ROLLBACK");}finally{c.release();await db.end();}}
}
