import { useEffect, useRef, useState } from "react";
import { Alert, Button, Checkbox, Empty, Tag } from "antd";
import { ArrowLeft, Globe, Upload } from "lucide-react";
import { Link } from "react-router-dom";
import { useUserStore } from "@/stores/use-user-store";
import { getCurrentSession } from "@/services/api/auth";
import { uploadServerAsset } from "@/services/api/server-assets";
import { createClientId } from "@/lib/client-id";
import { decodeReference, isReferenceEnvelope, MAX_IMAGES, MAX_TOTAL_BYTES, REFERENCE_CHANNEL, type ReferencePayload } from "./protocol";

type Draft = { payload: ReferencePayload; file: File; preview: string; clientReferenceId: string; selected: boolean; status: "pending" | "uploading" | "done" | "error"; error?: string };

export default function ReferenceImportPage() {
    const user = useUserStore(state => state.user);
    const nonce = useRef(new URLSearchParams(window.location.hash.slice(1)).get("referenceNonce") || "");
    const drafts = useRef<Draft[]>([]);
    const [items, setItems] = useState<Draft[]>([]);
    const [notice, setNotice] = useState("");
    const [busy, setBusy] = useState(false);
    const busyRef = useRef(false);
    const cancelled = useRef(false);
    const owner = useRef(user?.id);
    const publish = () => setItems([...drafts.current]);
    const clear = () => { drafts.current.forEach(item => URL.revokeObjectURL(item.preview)); drafts.current = []; publish(); };

    useEffect(() => {
        if (owner.current !== user?.id) {
            cancelled.current = true; nonce.current = ""; clear();
            owner.current = user?.id;
            setNotice("员工身份已变化，本批采集已停止。请从扩展重新发送。");
        }
    }, [user?.id]);

    useEffect(() => {
        const receive = (event: MessageEvent) => {
            if (event.source !== window || event.origin !== window.location.origin || !isReferenceEnvelope(event.data, nonce.current)) return;
            const data = event.data;
            const ack = (ok: boolean, error = "") => window.postMessage({ channel: REFERENCE_CHANNEL, nonce: nonce.current, type: "ack", requestId: data.requestId, ok, error }, window.location.origin);
            if (!useUserStore.getState().user?.id || owner.current !== useUserStore.getState().user?.id) { ack(false, "请先在画布网站完成登录，再重新发送"); return; }
            if (data.type === "hello") { ack(true); return; }
            if (busyRef.current) { ack(false, "正在导入，请稍后重新发送"); return; }
            try {
                const { payload, file } = decodeReference(data.image);
                const sameId = drafts.current.find(item => item.payload.id === payload.id);
                if (sameId && sameId.payload.base64 !== payload.base64) throw new Error("重复标识对应了不同图片");
                if (drafts.current.some(item => item.payload.base64 === payload.base64)) { ack(true); return; }
                if (drafts.current.length >= MAX_IMAGES || drafts.current.reduce((sum, item) => sum + item.file.size, 0) + file.size > MAX_TOTAL_BYTES) throw new Error("本批最多 20 张、合计 30 MiB；请完成后开始新一批");
                drafts.current.push({ payload, file, preview: URL.createObjectURL(file), clientReferenceId: `web-reference-${createClientId()}`, selected: true, status: "pending" });
                publish(); ack(true);
            } catch (error) { const reason = error instanceof Error ? error.message : "图片接收失败"; setNotice(reason); ack(false, reason); }
        };
        window.addEventListener("message", receive);
        return () => { cancelled.current = true; window.removeEventListener("message", receive); drafts.current.forEach(item => URL.revokeObjectURL(item.preview)); };
    }, []);

    useEffect(() => {
        const warn = (event: BeforeUnloadEvent) => { if (drafts.current.some(item => item.status !== "done")) { event.preventDefault(); event.returnValue = ""; } };
        window.addEventListener("beforeunload", warn);
        return () => window.removeEventListener("beforeunload", warn);
    }, []);

    const importSelected = async () => {
        if (busyRef.current || !user?.id) return;
        const expectedOwnerId = user.id;
        busyRef.current = true; setBusy(true); cancelled.current = false; setNotice("");
        try {
            for (const item of drafts.current.filter(value => value.selected && value.status !== "done")) {
                if (cancelled.current) break;
                try {
                    const preview = new window.Image();
                    preview.src = item.preview;
                    let timer: ReturnType<typeof setTimeout> | undefined;
                    try { await Promise.race([preview.decode(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("图片解码超时")), 10000); })]); }
                    finally { clearTimeout(timer); }
                    if (!preview.naturalWidth || !preview.naturalHeight || preview.naturalWidth * preview.naturalHeight > 40_000_000) throw new Error("图片无法解码或超过 4000 万像素限制");
                    const session = await getCurrentSession();
                    if (cancelled.current || useUserStore.getState().user?.id !== expectedOwnerId || session.user.id !== expectedOwnerId) throw new Error("员工会话已变化，已停止导入");
                    item.status = "uploading"; item.error = undefined; publish();
                    await uploadServerAsset(item.file, { title: item.file.name, source: "web-reference", module: "网页参考图采集", originalFileName: item.file.name, sourceFile: item.payload.sourceImage, sourcePageUrl: item.payload.sourcePage, sourceImageUrl: item.payload.sourceImage, sourcePageTitle: item.payload.pageTitle, collectedAt: new Date().toISOString(), tags: ["网页参考图"] }, { expectedOwnerId, clientReferenceId: item.clientReferenceId });
                    if (useUserStore.getState().user?.id !== expectedOwnerId) { cancelled.current = true; break; }
                    item.status = "done"; item.selected = false; publish();
                } catch (error) {
                    item.status = "error"; item.error = error instanceof Error ? error.message : "导入失败"; publish();
                    setNotice("已停止后续导入。请确认登录和网络后重试；已成功的图片不会再次提交。");
                    break;
                }
            }
        } finally { busyRef.current = false; setBusy(false); }
    };

    const pending = items.filter(item => item.selected && item.status !== "done").length;
    return <div className="h-full overflow-auto bg-background p-4 text-foreground sm:p-8">
        <div className="mx-auto max-w-6xl space-y-6">
            <Link to="/assets" className="inline-flex items-center gap-2 text-sm text-muted-foreground"><ArrowLeft size={16} />返回素材库</Link>
            <header className="space-y-2"><h1 className="flex items-center gap-3 text-2xl font-semibold"><Globe />网页参考图采集</h1><p className="text-sm text-muted-foreground">先在 Chrome 扩展勾选，再在这里审核。只有点击“确认导入”才会写入当前员工的素材库。</p></header>
            <Alert type="info" title={`当前员工：${user?.displayName || user?.username || "未登录"} · ${items.length}/20 张 · 原始图片字节，不压缩、不重绘`} description="仅 PNG / JPEG / WebP / GIF，单张 ≤ 10 MiB、总计 ≤ 30 MiB。来源会移除查询参数和片段。草稿仅在本页内存中，刷新或离页会丢失；请确认你有权保存这些图片。" />
            {notice && <Alert type="warning" title={notice} closable onClose={() => setNotice("")} />}
            <div className="flex flex-wrap items-center gap-3"><Button type="primary" icon={<Upload size={16} />} disabled={!pending || busy} onClick={() => void importSelected()}>确认导入 {pending ? `${pending} 张` : ""}</Button>{busy ? <Button onClick={() => { cancelled.current = true; setNotice("已取消后续导入；正在上传的一张可能已经保存，请等待其结果。"); }}>取消后续导入</Button> : <Button disabled={!items.length} onClick={clear}>清空本页草稿</Button>}<span role="status" className="text-sm text-muted-foreground">{busy ? "正在逐张导入…" : `已成功 ${items.filter(item => item.status === "done").length} 张`}</span></div>
            {!items.length ? <Empty description={nonce.current ? "等待扩展发送；请回到采集标签页完成发送" : "还没有采集图片，请从 Chrome 扩展发起"} /> : <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{items.map(item => <article key={item.clientReferenceId} className="overflow-hidden rounded-xl border border-border bg-card"><img src={item.preview} alt={item.file.name} className="aspect-[4/3] w-full object-contain" onError={() => { item.error = "浏览器无法解码这张图片，请勿导入"; item.selected = false; publish(); }} /><div className="space-y-2 p-4"><Checkbox checked={item.selected} disabled={busy || item.status === "done" || Boolean(item.error?.includes("解码"))} onChange={event => { item.selected = event.target.checked; publish(); }}><span className="break-all">{item.file.name}</span></Checkbox><p className="text-xs text-muted-foreground">{(item.file.size / 1024 / 1024).toFixed(2)} MiB · {item.file.type}</p><p className="break-all text-xs text-muted-foreground">来源：{item.payload.sourcePage || "未提供"}</p>{item.payload.sourceImage && <a className="block break-all text-xs" href={item.payload.sourceImage} target="_blank" rel="noreferrer">查看来源图片</a>}<Tag color={item.status === "done" ? "green" : undefined}>{({ pending: "待审核", uploading: "上传中", done: "已导入", error: "失败，可重试" })[item.status]}</Tag>{item.error && <p role="alert" className="text-sm text-red-600">{item.error}</p>}</div></article>)}</div>}
            <details id="install" className="rounded-xl border border-border p-5" open={!nonce.current}><summary className="cursor-pointer font-medium">Chrome 扩展安装与使用说明</summary><ol className="mt-3 list-decimal space-y-2 pl-5 text-sm leading-6"><li>在本项目目录找到 <code>tools/chrome-reference-importer</code>，打开 <code>chrome://extensions</code>，启用开发者模式，点击“加载已解压的扩展程序”并选择该目录。</li><li>先在此浏览器登录画布网站（企业用户仍从 OA 进入）。在需要采集的网页点击扩展图标，会打开独立采集标签页。</li><li>填写画布地址 <code>{window.location.origin}</code>；扫描当前网页、勾选图片，再点击“授权并送到画布审核”。权限只请求画布域名和已勾选图片所在域名。</li><li>回到自动打开的审核页核对来源与图片，再确认导入。扩展不采视频、不自动翻页，也不绕过登录、付费或 DRM 限制。</li></ol><p className="mt-3 text-xs text-muted-foreground">本机和可信内网可使用 HTTP；其他地址必须 HTTPS。扩展可在 Chrome 的扩展管理页面随时移除或撤销站点权限。详细打包与测试说明见扩展目录 README.md。</p></details>
        </div>
    </div>;
}
