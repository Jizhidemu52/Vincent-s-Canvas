import { loadConfig } from "./config";
import { randomUUID } from "node:crypto";
import { createCache, createDatabase, type Cache, type Database } from "./db";
import { decryptSecret } from "./security";
import { settleReservation } from "./billing";
import { queueScore, recalculateBatch, type TaskPriority } from "./tasks";
import { ObjectStorage } from "./object-storage";

type WorkRow = {
    id: string; request_id: string; batch_id: string | null; user_id: string; department_id: string | null; project_id: string; operation_type: string; model_config_id: string | null; prompt: string; source_urls: string[]; attempts: number; priority: TaskPriority;
    model_id: string | null; concurrency_limit: number | null; protocol: string | null; base_url: string | null; encrypted_credentials: string | null;
};

const config = loadConfig();
const db = createDatabase(config.DATABASE_URL);
const cache = await createCache(config.REDIS_URL);
const storage = new ObjectStorage(config);
let stopping = false;

async function nextTask() {
    const result = await cache.zPopMin("tasks:queue");
    return result?.value ?? null;
}

async function runTask(taskId: string) {
    const claimed = await db.query<WorkRow>(`UPDATE tasks SET status='processing',started_at=COALESCE(started_at,now()),attempts=attempts+1,updated_at=now()
        WHERE id=$1 AND status='waiting' RETURNING id,request_id,batch_id,prompt,source_urls,attempts,priority,model_config_id`, [taskId]);
    if (!claimed.rows[0]) return;
    const details = await db.query<WorkRow>(`SELECT t.id,t.request_id,t.batch_id,t.user_id,t.department_id,t.project_id,t.operation_type,t.model_config_id,t.prompt,t.source_urls,t.attempts,t.priority,m.model_id,m.concurrency_limit,p.protocol,p.base_url,p.encrypted_credentials
        FROM tasks t LEFT JOIN model_configs m ON m.id=t.model_config_id LEFT JOIN providers p ON p.id=m.provider_id WHERE t.id=$1`, [taskId]);
    const task = details.rows[0]!;
    const semaphoreKey = task.model_id ? `model:${task.model_id}:running` : "model:none:running";
    const running = await cache.incr(semaphoreKey);
    await cache.expire(semaphoreKey, 600);
    if (running > (task.concurrency_limit ?? 5)) {
        await cache.decr(semaphoreKey);
        await db.query("UPDATE tasks SET status='waiting',updated_at=now() WHERE id=$1 AND status='processing'", [task.id]);
        await cache.zAdd("tasks:queue", { score: queueScore(task.priority, Date.now() + 1_000), value: task.id });
        return;
    }
    try {
        const providerResults = config.TASK_MOCK_MODE === "true" ? [{ bytes: Buffer.from(mockSvg(task.id)), mimeType: "image/svg+xml" }] : await executeProvider(task);
        const resultUrls = await storeResults(task, providerResults);
        await settleReservation(db, task.request_id, "capture");
        const client = await db.connect();
        try {
            await client.query("BEGIN");
            await client.query("UPDATE tasks SET status='success',result_urls=$1,completed_at=now(),updated_at=now() WHERE id=$2", [resultUrls, task.id]);
            await client.query(`INSERT INTO generation_history(task_id,user_id,department_id,project_id,operation_type,model_config_id,prompt,source_urls,result_urls,credits,rmb_cost,status)
                SELECT id,user_id,department_id,project_id,operation_type,model_config_id,prompt,source_urls,result_urls,credits,rmb_cost,'success' FROM tasks WHERE id=$1 ON CONFLICT(task_id) DO NOTHING`, [task.id]);
            await client.query("COMMIT");
        } catch (error) { await client.query("ROLLBACK"); throw error; }
        finally { client.release(); }
    } catch (error) {
        const reason = error instanceof Error ? error.message.slice(0, 2_000) : "任务执行失败";
        if (task.attempts < 3) {
            await db.query("UPDATE tasks SET status='waiting',failure_reason=$1,updated_at=now() WHERE id=$2", [reason, task.id]);
            await cache.zAdd("tasks:queue", { score: queueScore(task.priority, Date.now() + task.attempts * 5_000), value: task.id });
        } else {
            await settleReservation(db, task.request_id, "release").catch(() => undefined);
            await db.query("UPDATE tasks SET status='failed',failure_reason=$1,completed_at=now(),updated_at=now() WHERE id=$2", [reason, task.id]);
            await db.query(`INSERT INTO generation_history(task_id,user_id,department_id,project_id,operation_type,model_config_id,prompt,source_urls,result_urls,credits,rmb_cost,status,failure_reason)
                SELECT id,user_id,department_id,project_id,operation_type,model_config_id,prompt,source_urls,'[]',0,0,'failed',$2 FROM tasks WHERE id=$1 ON CONFLICT(task_id) DO NOTHING`, [task.id, reason]);
            await db.query(`INSERT INTO audit_logs(actor_user_id,action,target_type,target_id,result,detail)
                SELECT user_id,'task.failed','task',id::text,'failed',jsonb_build_object('reason',$2,'attempts',attempts) FROM tasks WHERE id=$1`, [task.id, reason]);
        }
    } finally {
        await cache.decr(semaphoreKey);
        if (task.batch_id) await recalculateBatch(db, task.batch_id);
    }
}

async function executeProvider(task: WorkRow) {
    if (!task.protocol || !task.base_url || !task.model_id) throw new Error("任务模型或 Provider 未配置");
    if (!task.encrypted_credentials || !config.PROVIDER_ENCRYPTION_KEY) throw new Error("Provider 服务端凭据未配置");
    const credentials = JSON.parse(decryptSecret(task.encrypted_credentials, config.PROVIDER_ENCRYPTION_KEY)) as Record<string, string>;
    const headers = { "content-type": "application/json", ...(credentials.apiKey ? { authorization: `Bearer ${credentials.apiKey}` } : {}) };
    const endpoint = task.protocol === "openai" ? `${task.base_url.replace(/\/$/, "")}/images/generations` : task.base_url;
    const payload = task.protocol === "openai" ? { model: task.model_id, prompt: task.prompt, n: 1 } : { model: task.model_id, prompt: task.prompt, sourceUrls: task.source_urls, credentials: Object.fromEntries(Object.entries(credentials).filter(([key]) => key !== "apiKey")) };
    const response = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify(payload), signal: AbortSignal.timeout(180_000) });
    if (!response.ok) throw new Error(`Provider ${response.status}: ${(await response.text()).slice(0, 500)}`);
    const body = await response.json() as { data?: Array<{ url?: string; b64_json?: string }>; resultUrls?: string[]; url?: string };
    const urls = body.resultUrls ?? body.data?.map((item) => item.url || (item.b64_json ? `data:image/png;base64,${item.b64_json}` : "")).filter(Boolean) ?? (body.url ? [body.url] : []);
    if (!urls.length) throw new Error("Provider 未返回图片结果");
    return Promise.all(urls.map(fetchResult));
}

async function fetchResult(url: string) {
    if (url.startsWith("data:")) {
        const match = url.match(/^data:([^;,]+);base64,(.+)$/);
        if (!match) throw new Error("Provider 返回了无法识别的内联图片");
        return { bytes: Buffer.from(match[2]!, "base64"), mimeType: match[1]! };
    }
    const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    if (!response.ok) throw new Error(`下载 Provider 结果失败：${response.status}`);
    return { bytes: Buffer.from(await response.arrayBuffer()), mimeType: response.headers.get("content-type")?.split(";")[0] || "image/png" };
}

async function storeResults(task: WorkRow, results: Array<{ bytes: Uint8Array; mimeType: string }>) {
    if (!storage.configured) throw new Error("公司对象存储尚未配置，不能保存生成结果");
    const urls: string[] = [];
    for (const [index, result] of results.entries()) {
        const id = randomUUID();
        const extension = result.mimeType === "image/jpeg" ? "jpg" : result.mimeType === "image/svg+xml" ? "svg" : "png";
        const filename = `task-${task.id}-${index + 1}.${extension}`;
        const key = `users/${task.user_id}/generated/${task.id}/${filename}`;
        await storage.put(key, result.bytes, result.mimeType);
        await db.query(`INSERT INTO assets(id,owner_user_id,department_id,project_external_id,task_id,object_key,filename,mime_type,byte_size,kind,source,operation_type,prompt,model_config_id,status)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'image',$10,$11,$12,$13,'ready')`, [id, task.user_id, task.department_id, task.project_id, task.id, key, filename, result.mimeType, result.bytes.byteLength, task.operation_type === "image_generation" ? "generation" : "edit", task.operation_type, task.prompt, task.model_config_id]);
        urls.push(`/api/assets/${id}/content`);
    }
    return urls;
}

function mockSvg(id: string) { const hue = [...id].reduce((sum, char) => sum + char.charCodeAt(0), 0) % 360; return `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024"><rect width="1024" height="1024" fill="hsl(${hue} 65% 46%)"/><circle cx="512" cy="440" r="260" fill="white" opacity=".7"/><text x="512" y="900" text-anchor="middle" font-family="sans-serif" font-size="40" fill="white">Wireless Canvas QA ${id.slice(0, 8)}</text></svg>`; }

async function workerLoop() {
    while (!stopping) {
        const taskId = await nextTask();
        if (!taskId) { await Bun.sleep(500); continue; }
        await runTask(taskId).catch((error) => console.error("Task worker error", error));
    }
}

console.log(`Starting ${config.WORKER_CONCURRENCY} task workers`);
const workers = Array.from({ length: config.WORKER_CONCURRENCY }, () => workerLoop());
const shutdown = () => { stopping = true; };
process.on("SIGTERM", shutdown); process.on("SIGINT", shutdown);
await Promise.all(workers);
await Promise.all([db.end(), cache.quit()]);
