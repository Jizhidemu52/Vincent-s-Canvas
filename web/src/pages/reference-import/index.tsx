import { useEffect, useRef, useState } from "react";
import { Alert, Button, Checkbox, Empty, Input, Tag } from "antd";
import { ArrowLeft, Globe, Search, Upload } from "lucide-react";
import { Link } from "react-router-dom";
import { useUserStore } from "@/stores/use-user-store";
import { getCurrentSession } from "@/services/api/auth";
import { uploadServerAsset } from "@/services/api/server-assets";
import { createClientId } from "@/lib/client-id";
import { decodeReference, isReferenceEnvelope, MAX_IMAGES, MAX_TOTAL_BYTES, REFERENCE_CHANNEL, type ReferencePayload } from "./protocol";
import { collectReferencePage, referenceReturnPath } from "./collect";

type Draft = { payload: ReferencePayload; file: File; preview: string; clientReferenceId: string; selected: boolean; status: "pending" | "uploading" | "done" | "error"; error?: string };

export default function ReferenceImportPage() {
    const user = useUserStore(state => state.user);
    const nonce = useRef(new URLSearchParams(window.location.hash.slice(1)).get("referenceNonce") || "");
    const drafts = useRef<Draft[]>([]);
    const [items, setItems] = useState<Draft[]>([]);
    const [notice, setNotice] = useState("");
    const [busy, setBusy] = useState(false);
    const [collecting, setCollecting] = useState(false);
    const [pageUrl, setPageUrl] = useState("");
    const [progress, setProgress] = useState("");
    const [failures, setFailures] = useState<{ name: string; reason: string }[]>([]);
    const [scanWarnings, setScanWarnings] = useState<string[]>([]);
    const [pageTitle, setPageTitle] = useState("");
    const controller = useRef<AbortController | null>(null);
    const revision = useRef(0);
    const busyRef = useRef(false);
    const cancelled = useRef(false);
    const owner = useRef(user?.id);
    const publish = () => setItems([...drafts.current]);
    const clear = () => { revision.current++; controller.current?.abort(); drafts.current.forEach(item => URL.revokeObjectURL(item.preview)); drafts.current = []; publish(); setFailures([]); setScanWarnings([]); setPageTitle(""); setProgress(""); };
    const returnPath = referenceReturnPath(window.location.search);

    useEffect(() => {
        return useUserStore.subscribe(state => {
            if (owner.current !== state.user?.id) {
                cancelled.current = true; nonce.current = ""; clear();
                owner.current = state.user?.id;
                busyRef.current = false; setBusy(false); setCollecting(false);
                setNotice("员工身份已变化，本批采集已停止并清空。请重新采集。");
            }
        });
    }, []);

    useEffect(() => {
        const receive = (event: MessageEvent) => {
            if (event.source !== window || event.origin !== window.location.origin || !isReferenceEnvelope(event.data, nonce.current)) return;
            const data = event.data;
            const ack = (ok: boolean, error = "") => window.postMessage({ channel: REFERENCE_CHANNEL, nonce: nonce.current, type: "ack", requestId: data.requestId, ok, error }, window.location.origin);
            if (!useUserStore.getState().user?.id || owner.current !== useUserStore.getState().user?.id) { ack(false, "请先在画布网站完成登录，再重新发送"); return; }
            if (data.type === "hello") { ack(true); return; }
            if (busyRef.current) { ack(false, "正在采集或导入，请稍后重新发送"); return; }
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
        return () => { cancelled.current = true; revision.current++; controller.current?.abort(); window.removeEventListener("message", receive); drafts.current.forEach(item => URL.revokeObjectURL(item.preview)); };
    }, []);

    const collect = async () => {
        if (busyRef.current || !user?.id) return;
        if (drafts.current.length) { setNotice("请先审核、导入或清空本页草稿，再采集另一网页。现有图片不会被覆盖。"); return; }
        const expectedOwnerId = user.id;
        const currentRevision = ++revision.current;
        const requestController = new AbortController(); controller.current = requestController;
        const active = () => revision.current === currentRevision && useUserStore.getState().user?.id === expectedOwnerId && !requestController.signal.aborted;
        busyRef.current = true; setBusy(true); setCollecting(true); setNotice(""); setFailures([]); setScanWarnings([]); setPageTitle(""); setProgress("正在读取公开网页…");
        let received = 0;
        try {
            await collectReferencePage({
                url: pageUrl, ownerId: expectedOwnerId, signal: requestController.signal,
                getOwner: () => useUserStore.getState().user?.id,
                onScan: scan => { if (active()) { setPageTitle(scan.pageTitle); setScanWarnings(scan.warnings); setProgress(`已找到 ${scan.candidates.length} 张候选图片，正在读取…`); } },
                onImage: ({ payload, file }) => {
                    if (!active() || drafts.current.some(item => item.payload.base64 === payload.base64)) return;
                    drafts.current.push({ payload, file, preview: URL.createObjectURL(file), clientReferenceId: `web-reference-${createClientId()}`, selected: true, status: "pending" });
                    received++; publish();
                },
                onFailure: (name, reason) => { if (active()) setFailures(value => [...value, { name, reason }]); },
                onProgress: (completed, total) => { if (active()) setProgress(`正在读取图片 ${completed}/${total}…`); },
            });
            if (active()) setProgress(received ? `已读取 ${received} 张，请审核后确认导入` : "没有可读取的图片，请检查下方提示或尝试其他公开网页");
        } catch (error) {
            if (active()) { setNotice(error instanceof Error ? error.message : "网页采集失败"); setProgress("采集已停止；已读取的图片仍需确认导入"); }
        } finally {
            if (revision.current === currentRevision) { controller.current = null; busyRef.current = false; setBusy(false); setCollecting(false); }
        }
    };

    const cancelCollection = () => {
        revision.current++; controller.current?.abort(); controller.current = null;
        busyRef.current = false; setBusy(false); setCollecting(false);
        setProgress("采集已取消，已读取图片保留供审核；尚未写入素材库");
    };

    useEffect(() => {
        const warn = (event: BeforeUnloadEvent) => { if (drafts.current.some(item => item.status !== "done")) { event.preventDefault(); event.returnValue = ""; } };
        window.addEventListener("beforeunload", warn);
        return () => window.removeEventListener("beforeunload", warn);
    }, []);

    const importSelected = async () => {
        if (busyRef.current || !user?.id) return;
        const expectedOwnerId = user.id;
        const currentRevision = ++revision.current;
        busyRef.current = true; setBusy(true); cancelled.current = false; setNotice("");
        try {
            for (const item of drafts.current.filter(value => value.selected && value.status !== "done")) {
                if (cancelled.current || revision.current !== currentRevision) break;
                try {
                    const preview = new window.Image();
                    preview.src = item.preview;
                    let timer: ReturnType<typeof setTimeout> | undefined;
                    try { await Promise.race([preview.decode(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("图片解码超时")), 10000); })]); }
                    finally { clearTimeout(timer); }
                    if (!preview.naturalWidth || !preview.naturalHeight || preview.naturalWidth * preview.naturalHeight > 40_000_000) throw new Error("图片无法解码或超过 4000 万像素限制");
                    const session = await getCurrentSession();
                    if (cancelled.current || revision.current !== currentRevision || useUserStore.getState().user?.id !== expectedOwnerId || session.user.id !== expectedOwnerId) throw new Error("员工会话已变化，已停止导入");
                    item.status = "uploading"; item.error = undefined; publish();
                    await uploadServerAsset(item.file, { title: item.file.name, source: "web-reference", module: "网页参考图采集", originalFileName: item.file.name, sourceFile: item.payload.sourceImage, sourcePageUrl: item.payload.sourcePage, sourceImageUrl: item.payload.sourceImage, sourcePageTitle: item.payload.pageTitle, collectedAt: new Date().toISOString(), tags: ["网页参考图"] }, { expectedOwnerId, clientReferenceId: item.clientReferenceId });
                    if (revision.current !== currentRevision || useUserStore.getState().user?.id !== expectedOwnerId) break;
                    item.status = "done"; item.selected = false; publish();
                } catch (error) {
                    if (revision.current !== currentRevision) break;
                    item.status = "error"; item.error = error instanceof Error ? error.message : "导入失败"; publish();
                    setNotice("已停止后续导入。请确认登录和网络后重试；已成功的图片不会再次提交。");
                    break;
                }
            }
        } finally { if (revision.current === currentRevision) { busyRef.current = false; setBusy(false); } }
    };

    const pending = items.filter(item => item.selected && item.status !== "done").length;
    return <div className="h-full overflow-auto bg-background p-4 text-foreground sm:p-8">
        <div className="mx-auto max-w-6xl space-y-6">
            <Link to={returnPath} className="inline-flex items-center gap-2 text-sm text-muted-foreground"><ArrowLeft size={16} />{returnPath === "/assets" ? "返回素材库" : "返回画布"}</Link>
            <header className="space-y-2"><h1 className="flex items-center gap-3 text-2xl font-semibold"><Globe />网页参考图采集</h1><p className="text-sm text-muted-foreground">粘贴公开网页链接，无需安装插件。先采集、再审核，只有点击“确认导入”才会写入当前员工的素材库。</p></header>
            <form className="space-y-3" onSubmit={event => { event.preventDefault(); void collect(); }}>
                <label htmlFor="reference-page-url" className="block text-sm font-medium">公开网页链接</label>
                <div className="flex flex-col gap-3 sm:flex-row"><Input id="reference-page-url" type="url" value={pageUrl} onChange={event => setPageUrl(event.target.value)} placeholder="https://example.com/gallery（也支持 HTTP）" autoComplete="off" disabled={busy} className="min-w-0 flex-1" /><Button htmlType="submit" type="primary" icon={<Search size={16} />} loading={collecting} disabled={busy || !user?.id || !pageUrl.trim()} data-testid="reference-scan">采集网页图片</Button>{collecting && <Button onClick={cancelCollection}>取消采集</Button>}</div>
                <p className="text-xs leading-5 text-muted-foreground">读取公开 HTML 中的前 20 张候选图片，不执行网页脚本。登录、动态加载或防盗链图片可能无法读取；可展开下方可选扩展说明。已有草稿请先处理，再开始新一批。</p>
                {(progress || pageTitle) && <div role="status" className="break-words text-sm text-muted-foreground">{pageTitle && <span className="mr-3 font-medium text-foreground">{pageTitle}</span>}{progress}</div>}
            </form>
            <Alert type="info" title={`当前员工：${user?.displayName || user?.username || "未登录"} · ${items.length}/20 张 · 原始图片字节，不压缩、不重绘`} description="仅 PNG / JPEG / WebP / GIF，单张 ≤ 10 MiB、总计 ≤ 30 MiB。来源会移除查询参数和片段。草稿仅在本页内存中，刷新或离页会丢失；请确认你有权保存这些图片。" />
            {notice && <Alert type="warning" title={notice} closable onClose={() => setNotice("")} />}
            {scanWarnings.length > 0 && <Alert type="info" title="网页采集提示" description={<ul className="list-disc space-y-1 pl-4">{scanWarnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>} />}
            {failures.length > 0 && <Alert type="warning" title={`${failures.length} 张图片未能读取，其他图片仍可审核`} description={<ul className="list-disc space-y-1 break-words pl-4">{failures.map((failure, index) => <li key={index}>{failure.name}：{failure.reason}</li>)}</ul>} />}
            <div className="flex flex-wrap items-center gap-3"><Button type="primary" icon={<Upload size={16} />} disabled={!pending || busy} onClick={() => void importSelected()} data-testid="reference-confirm">确认导入 {pending ? `${pending} 张` : ""}</Button>{busy && !collecting ? <Button onClick={() => { cancelled.current = true; setNotice("已取消后续导入；正在上传的一张可能已经保存，请等待其结果。"); }}>取消后续导入</Button> : <Button disabled={busy || !items.length} onClick={clear}>清空本页草稿</Button>}<span role="status" className="text-sm text-muted-foreground">{busy && !collecting ? "正在逐张导入…" : `已成功 ${items.filter(item => item.status === "done").length} 张`}</span></div>
            {!items.length ? <Empty description={collecting ? "正在读取网页中的图片…" : nonce.current ? "可粘贴链接采集，也可回到扩展采集标签页发送图片" : "粘贴网页链接，开始收集参考图片"} /> : <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{items.map(item => <article key={item.clientReferenceId} data-testid="reference-draft" className="overflow-hidden rounded-xl border border-border bg-card"><img src={item.preview} alt={item.file.name} className="aspect-[4/3] w-full object-contain" onError={() => { item.error = "浏览器无法解码这张图片，请勿导入"; item.selected = false; publish(); }} /><div className="space-y-2 p-4"><Checkbox checked={item.selected} disabled={busy || item.status === "done" || Boolean(item.error?.includes("解码"))} onChange={event => { item.selected = event.target.checked; publish(); }}><span className="break-all">{item.file.name}</span></Checkbox><p className="text-xs text-muted-foreground">{(item.file.size / 1024 / 1024).toFixed(2)} MiB · {item.file.type}</p><p className="break-all text-xs text-muted-foreground">来源：{item.payload.sourcePage || "未提供"}</p>{item.payload.sourceImage && <a className="block break-all text-xs" href={item.payload.sourceImage} target="_blank" rel="noreferrer">查看来源图片</a>}<Tag color={item.status === "done" ? "green" : undefined}>{({ pending: "待审核", uploading: "上传中", done: "已导入", error: "失败，可重试" })[item.status]}</Tag>{item.error && <p role="alert" className="text-sm text-destructive">{item.error}</p>}</div></article>)}</div>}
            <details id="install" className="rounded-xl border border-border p-5"><summary className="cursor-pointer font-medium">可选：使用 Chrome 扩展采集当前网页</summary><p className="mt-3 text-sm text-muted-foreground">适合查看浏览器当前网页中的图片，不保证能读取登录或防盗链图片的原始字节。普通公开网页直接粘贴链接即可，无需扩展。</p><ol className="mt-3 list-decimal space-y-2 pl-5 text-sm leading-6"><li>在本项目目录找到 <code>tools/chrome-reference-importer</code>，打开 <code>chrome://extensions</code>，启用开发者模式，点击“加载已解压的扩展程序”并选择该目录。</li><li>先在此浏览器登录画布网站（企业用户仍从 OA 进入）。在需要采集的网页点击扩展图标，会打开独立采集标签页。</li><li>填写画布地址 <code>{window.location.origin}</code>；扫描当前网页、勾选图片，再点击“授权并送到画布审核”。权限只请求画布域名和已勾选图片所在域名。</li><li>回到自动打开的审核页核对来源与图片，再确认导入。扩展不采视频、不自动翻页，也不绕过登录、付费或 DRM 限制。</li></ol><p className="mt-3 text-xs text-muted-foreground">本机和可信内网可使用 HTTP；其他地址必须 HTTPS。扩展可在 Chrome 的扩展管理页面随时移除或撤销站点权限。详细打包与测试说明见扩展目录 README.md。</p></details>
        </div>
    </div>;
}
