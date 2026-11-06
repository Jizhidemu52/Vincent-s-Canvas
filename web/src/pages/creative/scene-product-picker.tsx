import { LoaderCircle, ScanSearch } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { uiText, useUiText } from "@/lib/i18n";
import { createWorkspaceStorage } from "@/lib/workspace-storage";
import { getImageBlob, resolveImageUrl } from "@/services/image-storage";
import { uploadServerAsset } from "@/services/api/server-assets";
import { getProductCandidates, identifyProductCandidates } from "@/services/api/product-candidates";
import { useUserStore } from "@/stores/use-user-store";
import { createSceneProductCandidates, type SceneProductCandidateRecord } from "./scene-product-candidates";
import type { SceneImage } from "./use-scene-workspace";

const storage = createWorkspaceStorage("creative_product_candidates");
const MAX_SOURCE_BYTES = 10 * 1024 * 1024;

export function SceneProductPicker({ sceneId, source, disabled, onConfirm }: {
    sceneId: string; source?: SceneImage; disabled: boolean; onConfirm: (target: string) => void;
}) {
    useUiText();
    const ownerId = useUserStore(state => state.user?.id);
    const [record, setRecord] = useState<SceneProductCandidateRecord | null>(null);
    const [ready, setReady] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [selected, setSelected] = useState("");
    const [confirmed, setConfirmed] = useState(false);
    const current = useRef("");
    const key = `${ownerId}:${sceneId}:${source?.id}`;
    current.current = key;
    const requests = useRef(new Set<AbortController>());
    const actionBusy = useRef(false);
    const controller = useMemo(() => ownerId && source ? createSceneProductCandidates(ownerId, sceneId, source.id, {
        storage,
        assertCurrent() {
            storage.assertIdentity();
            if (useUserStore.getState().user?.id !== ownerId) throw new Error("员工会话已变化，请重新进入工作区。");
        },
        async upload(requestId, signal) {
            let blob = source.storageKey ? await getImageBlob(source.storageKey) : null;
            if (!blob) {
                const url = await resolveImageUrl(source.storageKey, source.dataUrl);
                const response = await fetch(url, { signal });
                if (!response.ok) throw new Error("原图读取失败，尚未提交产品识别。");
                blob = await response.blob();
            }
            if (!blob.size || !["image/png", "image/jpeg", "image/webp"].includes(blob.type || source.mimeType)) throw new Error("请使用有效的 PNG、JPG 或 WebP 原图。");
            if (blob.size > MAX_SOURCE_BYTES) throw new Error("产品识别仅支持不超过 10 MiB 的单张原图；原件未压缩，尚未上传或提交识别。");
            signal?.throwIfAborted();
            if (current.current !== key) throw new Error("素材已切换，未提交产品识别。");
            return uploadServerAsset(new File([blob], source.name || "product.png", { type: blob.type || source.mimeType }),
                { source: "creative-product-candidates", sceneId }, { expectedOwnerId: ownerId, clientReferenceId: requestId, signal });
        },
        submit: (requestId, sourceAssetId, signal) => identifyProductCandidates(requestId, sourceAssetId, ownerId, signal),
        query: (requestId, signal) => getProductCandidates(requestId, ownerId, signal),
    }) : null, [ownerId, sceneId, source?.id]);

    useEffect(() => {
        let active = true;
        setReady(false); setRecord(null); setError(null); setSelected(""); setConfirmed(false); setBusy(false);
        if (!controller) { setReady(true); return; }
        void controller.read().then(value => { if (active) { setRecord(value); setReady(true); } }).catch(caught => {
            if (active) setError(caught instanceof Error ? caught.message : "识别记录读取失败，请重新打开页面后查询。");
        });
        return () => { active = false; for (const request of requests.current) request.abort(); requests.current.clear(); };
    }, [controller]);

    const act = async (query: boolean, retryFailed = false) => {
        if (!controller || !ready || disabled || actionBusy.current) return;
        actionBusy.current = true;
        const request = new AbortController(); requests.current.add(request);
        setBusy(true); setError(null); setConfirmed(false);
        try {
            const result = await (query ? controller.query(request.signal) : controller.identify(request.signal, retryFailed));
            if (current.current === key && result) { setRecord(result); setSelected(""); }
        } catch (caught) {
            if (current.current === key) setError(caught instanceof Error ? caught.message : "识别状态暂时未知，请查询原请求。");
        } finally {
            actionBusy.current = false;
            requests.current.delete(request);
            if (current.current === key) setBusy(false);
        }
    };
    const status = record?.receipt?.status;
    const rejected = Boolean(record?.rejection);
    const candidates = status === "success" ? record?.receipt?.candidates || [] : [];
    const candidate = candidates.find(item => item.id === selected);
    return <div className="cs-product-picker" aria-label={uiText("产品识别与确认")}>
        {!record ? <button type="button" className="cs-tool-entry" disabled={disabled || busy || !ready || !source || !ownerId || source.bytes > MAX_SOURCE_BYTES} onClick={() => void act(false)}>
            {busy ? <LoaderCircle size={14} className="animate-spin" /> : <ScanSearch size={14} />}<span>{busy ? uiText("正在识别产品…") : uiText("识别图中产品")}</span><small>{uiText("可能付费")}</small>
        </button> : null}
        {!record && <p className="cs-help">{uiText(source && source.bytes > MAX_SOURCE_BYTES ? "产品识别仅支持不超过 10 MiB 的单张原图；原件未压缩，可手动填写产品。" : "仅点击后看图识别；限单张 PNG / JPG / WebP、10 MiB 以内。也可手填，不会自动生成图片。")}</p>}
        {record && !rejected && status !== "success" && status !== "failed" && <>
            <p className="cs-help" role="status">{uiText(status === "processing" ? "产品识别仍在处理，请查询原请求。" : "识别状态待核查；已保留原请求编号，不会重新提交。")}</p>
            <button type="button" className="cs-tool-entry" disabled={disabled || busy || !ready} onClick={() => void act(true)}>{busy ? <LoaderCircle size={14} className="animate-spin" /> : null}{uiText("查询原识别请求")}</button>
        </>}
        {(status === "failed" || rejected) && <>
            <p className="cs-help" role="status">{rejected ? uiText("本次识别未提交。检查素材或配置后可明确再试，将沿用原编号核验，不会自动重发。") : record?.receipt?.message || uiText("本次识别已结束，未取得有效候选。可手填产品，或明确重新识别。")}</p>
            <button type="button" className="cs-tool-entry" disabled={disabled || busy || !ready} onClick={() => void act(false, true)}>{busy ? <LoaderCircle size={14} className="animate-spin" /> : null}{uiText("重新识别（可能付费）")}</button>
        </>}
        {status === "success" && !candidates.length && <p className="cs-help" role="status">{uiText("未识别到明确产品，请手动填写要处理的产品。")}</p>}
        {!!candidates.length && <fieldset className="cs-product-candidates" disabled={disabled || busy}>
            <legend className="cs-help">{uiText("请核对候选，再确认要处理的产品")}</legend>
            {candidates.map(item => <label className={`cs-product-candidate${selected === item.id ? " is-active" : ""}`} key={item.id}>
                <input type="radio" name={`product-${sceneId}-${source?.id}`} value={item.id} checked={selected === item.id} onChange={() => { setSelected(item.id); setConfirmed(false); }} disabled={disabled || busy} />
                <span><strong>{item.name}</strong><span>{item.brief}</span><small>{uiText("识别依据：")}{item.evidence}</small></span>
            </label>)}
            <button type="button" className="cs-tool-entry" disabled={disabled || busy || !candidate} onClick={() => {
                if (!candidate || disabled || busy || current.current !== key || useUserStore.getState().user?.id !== ownerId) return;
                onConfirm(`${candidate.name}（${candidate.brief}）`); setConfirmed(true);
            }}>{uiText("确认使用所选产品")}</button>
        </fieldset>}
        {confirmed && <p className="cs-help" role="status">{uiText("已填入目标产品，可继续手动修改；未生成图片，也未建立像素选区。")}</p>}
        {(error || record?.error) && <p className="cs-error" role="alert">{error || record?.error}</p>}
    </div>;
}
