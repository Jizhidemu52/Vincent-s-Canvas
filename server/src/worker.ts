import { loadConfig } from "./config";
import { randomUUID } from "node:crypto";
import { createCache, createDatabase, type Cache, type Database } from "./db";
import { decryptSecret } from "./security";
import { settleReservation } from "./billing";
import { queueScore, recalculateBatch, type TaskPriority } from "./tasks";
import { ObjectStorage } from "./object-storage";
import { decodeWorkflowImage, normalizeWorkflowOutputs, parsePromptVariables, readPath, renderTemplate } from "./workflow-runtime";
import { buildOpenAiAudioRequest, buildOpenAiVideoFields, unwrapProviderEnvelope } from "./media-runtime";
import { recordAssetEvent } from "./asset-events";
import { classifyDesignDirection } from "./design-direction";

type WorkRow = {
    id: string; request_id: string; batch_id: string | null; user_id: string; department_id: string | null; project_id: string; operation_type: string; model_config_id: string | null; prompt: string; parameters: Record<string, unknown>; source_urls: string[]; attempts: number; priority: TaskPriority;
    model_id: string | null; concurrency_limit: number | null; protocol: string | null; base_url: string | null; encrypted_credentials: string | null;
    workflow_config_id:string|null;workflow_id:string|null;submit_path:string|null;status_path:string|null;request_template:unknown;external_task_path:string|null;status_value_path:string|null;success_values:string[]|null;failure_values:string[]|null;output_path:string|null;poll_interval_ms:number|null;timeout_seconds:number|null;
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
    const details = await db.query<WorkRow>(`SELECT t.id,t.request_id,t.batch_id,t.user_id,t.department_id,t.project_id,t.operation_type,t.model_config_id,t.prompt,t.parameters,t.source_urls,t.attempts,t.priority,m.model_id,m.concurrency_limit,m.workflow_config_id,p.protocol,p.base_url,p.encrypted_credentials,w.workflow_id,w.submit_path,w.status_path,w.request_template,w.external_task_path,w.status_value_path,w.success_values,w.failure_values,w.output_path,w.poll_interval_ms,w.timeout_seconds
        FROM tasks t LEFT JOIN model_configs m ON m.id=t.model_config_id LEFT JOIN providers p ON p.id=m.provider_id LEFT JOIN workflow_configs w ON w.id=m.workflow_config_id AND w.enabled=true WHERE t.id=$1`, [taskId]);
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
            await client.query("UPDATE tasks SET status='success',result_urls=$1,completed_at=now(),updated_at=now() WHERE id=$2", [JSON.stringify(resultUrls), task.id]);
            await client.query(`INSERT INTO generation_history(task_id,user_id,department_id,project_id,operation_type,model_config_id,prompt,parameters,source_urls,result_urls,credits,rmb_cost,status)
                SELECT id,user_id,department_id,project_id,operation_type,model_config_id,prompt,parameters,source_urls,result_urls,credits,rmb_cost,'success' FROM tasks WHERE id=$1 ON CONFLICT(task_id) DO NOTHING`, [task.id]);
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
            await db.query(`INSERT INTO generation_history(task_id,user_id,department_id,project_id,operation_type,model_config_id,prompt,parameters,source_urls,result_urls,credits,rmb_cost,status,failure_reason)
                SELECT id,user_id,department_id,project_id,operation_type,model_config_id,prompt,parameters,source_urls,'[]',0,0,'failed',$2 FROM tasks WHERE id=$1 ON CONFLICT(task_id) DO NOTHING`, [task.id, reason]);
            await db.query(`INSERT INTO audit_logs(actor_user_id,action,target_type,target_id,result,detail)
                SELECT user_id,'task.failed','task',id::text,'failed',jsonb_build_object('reason',$2::text,'attempts',attempts) FROM tasks WHERE id=$1`, [task.id, reason]);
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
    if(task.workflow_config_id&&task.submit_path&&task.output_path)return executeWorkflow(task,credentials);
    const authorization: Record<string,string> = credentials.apiKey ? { authorization: `Bearer ${credentials.apiKey}` } : {};
    if (task.protocol === "openai" && task.operation_type === "audio_generation") return executeOpenAiAudio(task, authorization);
    if (task.protocol === "openai" && task.operation_type === "video_generation") return executeOpenAiVideo(task, authorization);
    let response: Response;
    if (task.protocol === "openai" && task.operation_type !== "image_generation" && task.source_urls.length) {
        const form = new FormData(); form.set("model",task.model_id); form.set("prompt",task.prompt); form.set("n","1"); form.set("response_format","b64_json");
        for(const [index,url] of task.source_urls.entries()){const source=await loadSourceAsset(url,task.user_id);form.append("image",new Blob([Uint8Array.from(source.bytes).buffer],{type:source.mimeType}),source.filename||`reference-${index+1}.png`);}
        response=await fetch(`${task.base_url.replace(/\/$/, "")}/images/edits`,{method:"POST",headers:authorization,body:form,signal:AbortSignal.timeout(180_000)});
    } else {
        const endpoint = task.protocol === "openai" ? `${task.base_url.replace(/\/$/, "")}/images/generations` : task.base_url;
        const payload = task.protocol === "openai" ? { model: task.model_id, prompt: task.prompt, n: 1, response_format:"b64_json" } : { model: task.model_id, prompt: task.prompt, sourceUrls: task.source_urls, credentials: Object.fromEntries(Object.entries(credentials).filter(([key]) => key !== "apiKey")) };
        response=await fetch(endpoint,{method:"POST",headers:{"content-type":"application/json",...authorization},body:JSON.stringify(payload),signal:AbortSignal.timeout(180_000)});
    }
    if (!response.ok) throw new Error(`Provider ${response.status}: ${(await response.text()).slice(0, 500)}`);
    const body = await response.json() as { data?: Array<{ url?: string; b64_json?: string }>; resultUrls?: string[]; url?: string };
    const urls = body.resultUrls ?? body.data?.map((item) => item.url || (item.b64_json ? `data:image/png;base64,${item.b64_json}` : "")).filter(Boolean) ?? (body.url ? [body.url] : []);
    if (!urls.length) throw new Error("Provider 未返回图片结果");
    return Promise.all(urls.map(fetchResult));
}

async function executeOpenAiAudio(task: WorkRow, authorization: Record<string, string>) {
    const request = buildOpenAiAudioRequest(task.model_id!, task.prompt, task.parameters);
    const response = await fetch(`${task.base_url!.replace(/\/$/, "")}/audio/speech`, {
        method: "POST",
        headers: { "content-type": "application/json", ...authorization },
        body: JSON.stringify(request.payload),
        signal: AbortSignal.timeout(180_000),
    });
    if (!response.ok) throw new Error(`音频 Provider ${response.status}: ${(await response.text()).slice(0, 500)}`);
    return [{ bytes: Buffer.from(await response.arrayBuffer()), mimeType: response.headers.get("content-type")?.split(";")[0] || request.mimeType }];
}

async function executeOpenAiVideo(task: WorkRow, authorization: Record<string, string>) {
    const fields = buildOpenAiVideoFields(task.model_id!, task.prompt, task.parameters);
    const form = new FormData();
    form.set("model", fields.model);
    form.set("prompt", fields.prompt);
    form.set("seconds", fields.seconds);
    if (fields.size) form.set("size", fields.size);
    form.set("resolution_name", fields.resolution);
    form.set("preset", fields.preset);
    for (const [index, url] of task.source_urls.entries()) {
        const source = await loadSourceAsset(url, task.user_id);
        if (!source.mimeType.startsWith("image/")) continue;
        form.append("input_reference[]", new Blob([Uint8Array.from(source.bytes).buffer], { type: source.mimeType }), source.filename || `reference-${index + 1}.png`);
    }
    const createdResponse = await fetch(`${task.base_url!.replace(/\/$/, "")}/videos`, { method: "POST", headers: authorization, body: form, signal: AbortSignal.timeout(180_000) });
    if (!createdResponse.ok) throw new Error(`视频 Provider ${createdResponse.status}: ${(await createdResponse.text()).slice(0, 500)}`);
    const created = unwrapProviderEnvelope(await createdResponse.json()) as { id?: string; status?: string; error?: { message?: string } };
    if (!created.id) throw new Error("视频 Provider 没有返回任务 ID");
    const deadline = Date.now() + fields.timeoutSeconds * 1000;
    while (Date.now() < deadline) {
        await Bun.sleep(2_000);
        const statusResponse = await fetch(`${task.base_url!.replace(/\/$/, "")}/videos/${encodeURIComponent(created.id)}`, { headers: authorization, signal: AbortSignal.timeout(60_000) });
        if (!statusResponse.ok) throw new Error(`视频状态查询失败 ${statusResponse.status}`);
        const status = unwrapProviderEnvelope(await statusResponse.json()) as { status?: string; error?: { message?: string } };
        if (status.status === "failed" || status.status === "cancelled") throw new Error(status.error?.message || "视频生成失败");
        if (status.status !== "completed") continue;
        const content = await fetch(`${task.base_url!.replace(/\/$/, "")}/videos/${encodeURIComponent(created.id)}/content`, { headers: authorization, signal: AbortSignal.timeout(180_000) });
        if (!content.ok) throw new Error(`视频下载失败 ${content.status}`);
        return [{ bytes: Buffer.from(await content.arrayBuffer()), mimeType: content.headers.get("content-type")?.split(";")[0] || "video/mp4" }];
    }
    throw new Error("视频生成超时");
}

async function executeWorkflow(task:WorkRow,credentials:Record<string,string>){const sourceAssets=await Promise.all(task.source_urls.map((url)=>loadSourceAsset(url,task.user_id)));const sourceImagesBase64=sourceAssets.map((asset)=>Buffer.from(asset.bytes).toString("base64"));const variables:Record<string,unknown>={taskId:task.id,prompt:task.prompt,...task.parameters,...parsePromptVariables(task.prompt),sourceUrls:task.source_urls,sourceBase64:sourceImagesBase64[0]??"",sourceImagesBase64,workflowId:task.workflow_id,modelId:task.model_id,...credentials};const body=renderTemplate(task.request_template??{},variables);const headers:Record<string,string>={"content-type":"application/json"};if(credentials.apiKey){headers.authorization=`Bearer ${credentials.apiKey}`;headers["x-api-key"]=credentials.apiKey;}if(credentials.walletApiKey)headers["wallet-api-key"]=credentials.walletApiKey;const submit=await fetch(joinUrl(task.base_url!,task.submit_path!),{method:"POST",headers,body:JSON.stringify(body),signal:AbortSignal.timeout(180_000)});if(!submit.ok)throw new Error(`工作流提交失败 ${submit.status}: ${(await submit.text()).slice(0,500)}`);let payload=await submit.json() as unknown;let outputs=normalizeWorkflowOutputs(readPath(payload,task.output_path!));if(outputs.length)return Promise.all(outputs.map(fetchResult));const externalId=task.external_task_path?readPath(payload,task.external_task_path):null;if(!externalId||!task.status_path)throw new Error("工作流响应中没有任务 ID 或直接结果");const deadline=Date.now()+(task.timeout_seconds??600)*1000;while(Date.now()<deadline){await Bun.sleep(task.poll_interval_ms??2000);const statusResponse=await fetch(joinUrl(task.base_url!,task.status_path.replace("{taskId}",encodeURIComponent(String(externalId)))),{headers,signal:AbortSignal.timeout(60_000)});if(!statusResponse.ok)throw new Error(`工作流状态查询失败 ${statusResponse.status}`);payload=await statusResponse.json();outputs=normalizeWorkflowOutputs(readPath(payload,task.output_path!));if(outputs.length)return Promise.all(outputs.map(fetchResult));const state=String(task.status_value_path?readPath(payload,task.status_value_path):"").toLowerCase();if((task.failure_values??[]).map((value)=>value.toLowerCase()).includes(state))throw new Error(`工作流执行失败：${state}`);if((task.success_values??[]).map((value)=>value.toLowerCase()).includes(state))throw new Error("工作流已完成但没有返回结果地址");}throw new Error("工作流执行超时");}

function joinUrl(base:string,path:string){return`${base.replace(/\/$/,"")}/${path.replace(/^\//,"")}`;}


async function loadSourceAsset(url:string,userId:string){const match=url.match(/^\/api\/assets\/([0-9a-f-]{36})\/content$/i);if(!match)throw new Error("参考图不是公司素材地址");const result=await db.query<{object_key:string;mime_type:string;filename:string}>("SELECT object_key,mime_type,filename FROM assets WHERE id=$1 AND owner_user_id=$2 AND status='ready' AND deleted_at IS NULL",[match[1],userId]);const asset=result.rows[0];if(!asset)throw new Error("参考图不存在或无权访问");const object=await storage.get(asset.object_key);return{bytes:await object.Body!.transformToByteArray(),mimeType:asset.mime_type,filename:asset.filename};}

async function fetchResult(url: string) {
    const inlineImage = decodeWorkflowImage(url);
    if (inlineImage) return inlineImage;
    if (url.startsWith("data:")) throw new Error("Provider 返回了无法识别的内联图片");
    const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    if (!response.ok) throw new Error(`下载 Provider 结果失败：${response.status}`);
    return { bytes: Buffer.from(await response.arrayBuffer()), mimeType: response.headers.get("content-type")?.split(";")[0] || "image/png" };
}

async function storeResults(task: WorkRow, results: Array<{ bytes: Uint8Array; mimeType: string }>) {
    if (!storage.configured) throw new Error("公司对象存储尚未配置，不能保存生成结果");
    const urls: string[] = [];
    for (const [index, result] of results.entries()) {
        const id = randomUUID();
        const extension = result.mimeType === "image/jpeg" ? "jpg" : result.mimeType === "image/svg+xml" ? "svg" : result.mimeType.includes("webm")?"webm":result.mimeType.startsWith("video/")?"mp4":result.mimeType.includes("wav")?"wav":result.mimeType.includes("aac")?"aac":result.mimeType.includes("ogg")?"ogg":result.mimeType.startsWith("audio/")?"mp3":"png";
        const filename = `task-${task.id}-${index + 1}.${extension}`;
        const key = `users/${task.user_id}/generated/${task.id}/${filename}`;
        await storage.put(key, result.bytes, result.mimeType);
        const kind=result.mimeType.startsWith("video/")?"video":result.mimeType.startsWith("audio/")?"other":"image";
        const direction = classifyDesignDirection({ operationType: task.operation_type, prompt: task.prompt, tool: task.parameters.tool });
        const asset = await db.query<{ id: string }>(`INSERT INTO assets(id,owner_user_id,department_id,project_external_id,task_id,object_key,filename,mime_type,byte_size,kind,source,operation_type,prompt,model_config_id,status,primary_direction,secondary_directions,direction_rule_version,direction_evidence)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'ready',$15,$16,$17,$18)
            ON CONFLICT(object_key) DO UPDATE SET status='ready',byte_size=EXCLUDED.byte_size,mime_type=EXCLUDED.mime_type,
              primary_direction=EXCLUDED.primary_direction,secondary_directions=EXCLUDED.secondary_directions,
              direction_rule_version=EXCLUDED.direction_rule_version,direction_evidence=EXCLUDED.direction_evidence,updated_at=now()
            RETURNING id`, [id, task.user_id, task.department_id, task.project_id, task.id, key, filename, result.mimeType, result.bytes.byteLength,kind, task.operation_type === "image_generation"||task.operation_type==="video_generation"||task.operation_type==="audio_generation" ? "generation" : "edit", task.operation_type, task.prompt, task.model_config_id, direction.primaryDirection, JSON.stringify(direction.secondaryDirections), direction.ruleVersion, JSON.stringify(direction.evidence)]);
        const assetId = asset.rows[0]!.id;
        await recordAssetEvent(db, {
            assetId,
            actor: null,
            eventType: "asset.generated",
            idempotencyKey: `task:${task.id}:asset:${assetId}:generated`,
            metadata: { resultIndex: index, operationType: task.operation_type },
        });
        urls.push(`/api/assets/${assetId}/content`);
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
