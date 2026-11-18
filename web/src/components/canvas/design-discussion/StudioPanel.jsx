import React, { useEffect, useRef, useState } from "react";
import { createClientUuid } from "../../../lib/client-uuid.ts";
import { ArrowUp, Check, FileText, ImagePlus, LoaderCircle, MessageCircle, Paperclip, Sparkles, X } from "lucide-react";
import { ReferencePicker } from "./ReferencePicker.jsx";
import { DESIGN_MODELS, DESIGN_PRESETS, designModels, designVideoModels } from "./model-presets.mjs";
import { generationSlots, requestedGenerationCount } from "./generation-batch.mjs";
import { requestDesignSession, designReferenceSnapshot } from "./design-session.mjs";
import { createProposalExecution } from "./proposal-execution.mjs";
import { assertProposalSubmission, proposalSubmission, proposalSubmissionMessage } from "./proposal-submission.mjs";
import { createDesignRecord, DESIGN_MODES, REFERENCE_ROLES } from "./design-record.mjs";
import { CATEGORIES } from "./fashion-context.mjs";
import { readDesignMaterial } from "./studio-media.mjs";
import { selectedTrendSources } from "./trend-sources.mjs";
import { DiscussionResults } from "./DiscussionResults.jsx";
import { messageTasks, resultDiscussionReference } from "./discussion-thread.mjs";

export function newStudioSession(references = []) {
    return { id: createClientUuid(), references, history: [], executedThrough: 0, brief: {}, documents: [], designRecord: createDesignRecord(), designRecordReferenceSnapshot: [], prompt: "", mode: "discuss", preset: "brand", proposalCount: 6, generationCount: 1, outputKind: "image", videoSeconds: 6, modelId: "", proposalBatch: null };
}
const fingerprint = session => JSON.stringify({ sessionId: session.id, prompt: session.prompt, focus: session.discussionFocus, references: session.references.map(ref => ({ id: ref.id, role: ref.role || "auto" })), brief: session.brief, documents: session.documents.map(doc => ({ id: doc.id, text: doc.text })), preset: session.preset, count: session.proposalCount, outputKind: session.outputKind || "image", record: session.designRecord, history: session.history.map(message => ({ role: message.role, content: message.content })) });
const emptyPrompt = "根据所选图片、品牌与资料提出有差异、可以落图的设计方向。";

function ModelOptions({ models, video }) {
    if (video) return models.map(model => <option key={model.id} value={model.id}>{model.label}</option>);
    return DESIGN_MODELS.map(preset => { const model = models.find(item => item.label === preset.label); return <option key={preset.label} value={model?.id || preset.publicName} disabled={!model}>{preset.label}{!model ? " · 当前不可用" : ""}</option>; });
}

function ProposalDialog({ batch, selected, onSelect, onClose, onGenerate, busy, ready, error, stale, models, modelId, onModel, count, onCount, video }) {
    const dialog = useRef();
    useEffect(() => { dialog.current.showModal(); }, []);
    return <dialog ref={dialog} className="proposal-dialog" aria-labelledby="proposal-title" onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>
        <header><div><span className="studio-eyebrow">选择方向，再让想法落图</span><h2 id="proposal-title">可选设计方向 · {batch.proposals.length} 个方案</h2></div><button aria-label="关闭方案选择" disabled={busy} onClick={onClose}><X size={20} /></button></header>
        <p className="proposal-intro">{batch.message}</p>
        {error && <p className="studio-error" role="alert">{error}</p>}
        {stale && <p className="studio-error" role="alert">图片分工、资料或讨论已变化，这批方案需要更新，不能直接用新参考执行。</p>}
        <div className="proposal-options">{batch.proposals.map((proposal, index) => {
            const receipts = Object.entries(batch.submissions || {}).filter(([key]) => key === proposal.id || key.startsWith(proposal.id + ":output:"));
            return <article key={proposal.id} className={selected.includes(proposal.id) ? "picked" : ""}>
                <label><input type="checkbox" aria-label={`选择方案：${proposal.title}`} checked={selected.includes(proposal.id)} disabled={busy || !ready || stale || Boolean(receipts.length)} onChange={event => onSelect(event.target.checked ? [...selected, proposal.id] : selected.filter(id => id !== proposal.id))} /><span className="proposal-number">0{index + 1}</span><h3>{proposal.title}</h3></label>
                <ul>{proposal.features.map(feature => <li key={feature}>{feature}</li>)}</ul><p>{proposal.rationale}</p>
                <div className="proposal-references">{proposal.referenceIds.map(id => { const ref = batch.references.find(item => item.id === id); return ref ? <figure key={id}><img src={ref.image} alt={ref.title} /><figcaption>图{batch.references.findIndex(item => item.id === id) + 1} · {REFERENCE_ROLES[ref.role || "auto"]}</figcaption></figure> : null; })}</div>
                {proposal.sourceNotes.map(note => <small key={note}>{note}</small>)}
                <details><summary>查看完整出图要求</summary><p className="proposal-prompt">{proposal.prompt}</p></details>
                {receipts.map(([key, receipt]) => <p key={key} className="proposal-receipt">提交回执：{proposalSubmissionMessage(receipt)}。在任务岛查看最新进度，不会重复生成。</p>)}
            </article>;
        })}</div>
        <footer><div><label>{video ? "视频模型" : "出图模型"}<select aria-label="方案出图模型" disabled={busy || !ready} value={modelId || ""} onChange={event => onModel(event.target.value)}><ModelOptions models={models} video={video} /></select></label><label>生成数量<select aria-label="方案生成数量" disabled={busy || !ready} value={count} onChange={event => onCount(Number(event.target.value))}>{Array.from({ length: 15 }, (_, index) => index + 1).map(value => <option key={value} value={value} disabled={value < selected.length}>{value}</option>)}</select></label></div><div><p>计划生成 {count} 个独立{video ? "视频" : "图片"}任务 · 已记录的请求不会重发</p><button className="studio-primary" disabled={busy || !ready || stale || !selected.length || !modelId || count < selected.length} onClick={onGenerate}>{busy ? <LoaderCircle size={16} className="spin" /> : <Sparkles size={16} />}按选中方案生成 {count} {video ? "个视频" : "张"}</button></div></footer>
    </dialog>;
}

export function StudioPanel({ visible, session, onChange, items, onChoose, onImport, onFigures, api, ownerId, catalog, ready, brands, onSave, onSubmitBatch, onClose, onNotice, tasks = [], onLocateResult }) {
    const [pickerOpen, setPickerOpen] = useState(false);
    const [proposalOpen, setProposalOpen] = useState(false);
    const [chosenProposals, setChosenProposals] = useState([]);
    const [busy, setBusy] = useState(false);
    const [uploading, setUploading] = useState(false);
    const [error, setError] = useState("");
    const [steps, setSteps] = useState([]);
    const [pendingMessage, setPendingMessage] = useState(null);
    const busyRef = useRef(false);
    const latest = useRef(session);
    latest.current = session;
    const input = useRef();
    const imageInput = useRef();
    const materialInput = useRef();
    const materialDetails = useRef();
    const scroll = useRef();
    const video = session.outputKind === "video";
    const models = video ? designVideoModels(catalog) : designModels(catalog, session.references.length);
    const chosenModel = session.modelId ? models.find(item => item.id === session.modelId) : models.find(item => video ? (item.parameterModelId || item.modelId) === "seedance-2-5-flash" : item.imageParameterProfile === "seedream55") || models[0];
    const batch = session.proposalBatch;
    const stale = batch && batch.fingerprint !== fingerprint(session);
    const taskProgress = tasks.map(task => `${task.id}:${task.status}:${task.resultUrls.length}`).join("|");
    useEffect(() => { scroll.current?.scrollTo({ top: scroll.current.scrollHeight, behavior: "smooth" }); }, [session.history.length, pendingMessage, taskProgress]);
    const progress = step => setSteps(current => [...current.filter(item => item.id !== step.id), step]);
    const update = changes => { if (!ready) return; setError(""); onChange(changes); };
    const changeRole = (id, role) => {
        if (role === "base" && session.references.some(ref => ref.id !== id && ref.role === "base")) { setError("一次只有一张修改对象；请先调整原修改对象的用途。"); return; }
        update({ references: session.references.map(ref => ref.id === id ? { ...ref, role } : ref) });
    };
    const generate = async (currentBatch, ids, model, count) => {
        if (!model) throw new Error("当前选择的模型不可用，请明确选择可用项。");
        if (currentBatch.fingerprint !== fingerprint(latest.current)) throw new Error("参考图、资料或讨论已变化，请重新提方案。");
        const slots = generationSlots(currentBatch.proposals, ids, count);
        let submittedCount = 0;
        for (const { proposal, key } of slots) {
            const existing = currentBatch.submissions?.[key] || currentBatch.submissions?.[proposal.id];
            if (existing) assertProposalSubmission(existing);
        }
        const pending = slots.filter(({ proposal, key }) => !currentBatch.submissions?.[key] && !currentBatch.submissions?.[proposal.id]);
        const inputs = pending.map(({ proposal, index, key }) => {
            const plan = createProposalExecution({ proposal, references: currentBatch.references, userRequirements: currentBatch.userRequirements, designRecord: currentBatch.designRecord, designRecordReferenceSnapshot: currentBatch.designRecordReferenceSnapshot, brief: currentBatch.brief, conversation: currentBatch.history, modelId: model.id, outputKind: currentBatch.outputKind || "image", generationAllowed: true });
            return { ...plan, discussionSessionId: currentBatch.sessionId, discussionMessageId: currentBatch.messageId, videoSeconds: latest.current.videoSeconds || 6, proposal: { ...plan.proposal, id: key, originalId: proposal.id, batchId: currentBatch.id, outputIndex: index } };
        });
        if (inputs.length) {
            setProposalOpen(false);
            await onSubmitBatch(inputs, (task, slot) => {
            const { proposal, index, key } = pending[slot];
            const receipt = proposalSubmission(task);
            currentBatch.submissions = { ...currentBatch.submissions, [key]: receipt };
            onChange(current => current.id === currentBatch.sessionId ? { ...current, proposalBatch: { ...currentBatch } } : current);
            progress({ id: `generate-${key}`, label: `${index + 1}/${count}「${proposal.title}」${proposalSubmissionMessage(receipt)}`, status: "recorded" });
            assertProposalSubmission(receipt);
            submittedCount++;
            progress({ id: `generate-${key}`, label: `${index + 1}/${count}「${proposal.title}」${proposalSubmissionMessage(receipt)}`, status: "complete" });
            });
        }
        onChange(current => current.id === currentBatch.sessionId ? { ...current, executedThrough: currentBatch.history.length } : current);
        return submittedCount;
    };
    const run = async intent => {
        if (busyRef.current) return;
        if (!ready) { setError("真实服务未连接，请先重新连接。"); return; }
        if (!catalog?.tools?.some(tool => tool.toolKey === "canvas-design-chat" && tool.enabled)) { setError("当前后台尚未启用设计对话模型。"); return; }
        if (intent === "direct" && !chosenModel) { setError("请选择当前可用的出图模型。"); return; }
        busyRef.current = true; setBusy(true); setError(""); setSteps([]);
        const snapshot = structuredClone(latest.current);
        const draft = snapshot.prompt.trim() || (intent === "discuss" ? "一起看看这些图稿与资料，帮我确定下一步设计方向。" : emptyPrompt);
        const prompt = snapshot.discussionFocus ? `围绕${snapshot.discussionFocus.kind === "result" ? "生成结果" : "方案"}「${snapshot.discussionFocus.title}」：${draft}` : draft;
        const initialFingerprint = fingerprint(snapshot);
        const sourceSnapshot = designReferenceSnapshot(snapshot.references);
        const userMessage = { id: createClientUuid(), role: "user", content: prompt, referenceSnapshot: sourceSnapshot };
        setPendingMessage(userMessage);
        const brief = { ...snapshot.brief, ...(snapshot.discussionFocus ? { discussionFocus: snapshot.discussionFocus } : {}), documents: snapshot.documents.map(doc => ({ id: doc.id, name: doc.name, text: doc.text, figures: doc.figures.map(figure => ({ id: figure.id, label: figure.label })) })) };
        try {
            await onSave();
            const count = requestedGenerationCount(prompt) || snapshot.generationCount || 1;
            const result = await requestDesignSession(api, ownerId, { mode: intent === "discuss" ? "discuss" : "propose", outputKind: snapshot.outputKind || "image", prompt, references: snapshot.references, history: snapshot.history, brief, designRecord: snapshot.designRecord, preset: DESIGN_PRESETS.find(preset => preset.id === snapshot.preset), proposalCount: snapshot.proposalCount, trendSources: selectedTrendSources(brief.season), onProgress: progress });
            const batchId = result.proposals.length ? createClientUuid() : null;
            const assistantMessage = { id: createClientUuid(), role: "assistant", content: result.message, referenceSnapshot: sourceSnapshot, questions: result.questions, proposals: result.proposals, proposalBatchId: batchId, sources: result.sources, trendStatus: result.trendStatus };
            const history = [...snapshot.history, userMessage, assistantMessage];
            const next = { ...snapshot, history, prompt: "", generationCount: count };
            const newBatch = result.proposals.length ? {
                id: batchId, messageId: assistantMessage.id, sessionId: snapshot.id, outputKind: snapshot.outputKind || "image", ...result, history, references: snapshot.references, brief, designRecord: snapshot.designRecord, designRecordReferenceSnapshot: snapshot.designRecordReferenceSnapshot,
                userRequirements: history.slice(snapshot.executedThrough || 0).filter(message => message.role === "user").map(message => ({ text: message.content, referenceSnapshot: message.referenceSnapshot })),
                fingerprint: fingerprint(next), submissions: {},
            } : null;
            if (initialFingerprint !== fingerprint(latest.current)) {
                onChange(current => current.id === snapshot.id ? { ...current, history, proposalBatch: newBatch } : current);
                throw new Error("回复对应发送时的参考组；你已换图或修改资料，旧方案未执行。请基于当前参考继续讨论。");
            }
            latest.current = { ...next, proposalBatch: newBatch };
            onChange(latest.current);
            setPendingMessage(null);
            if (newBatch) {
                setChosenProposals([newBatch.proposals[0].id]);
                if (intent === "direct") await generate(newBatch, newBatch.proposals.slice(0, Math.min(count, newBatch.proposals.length)).map(proposal => proposal.id), chosenModel, count);
            }
        } catch (failure) { setError(failure.message); }
        finally { busyRef.current = false; setBusy(false); setPendingMessage(null); }
    };
    const generateSelected = async () => {
        if (busyRef.current || !batch) return;
        if (!ready) { setError("正在恢复讨论与连接服务，请稍候再生成。"); return; }
        busyRef.current = true; setBusy(true); setError("");
        try { const count = await generate(structuredClone(batch), chosenProposals, chosenModel, session.generationCount || 1); setProposalOpen(false); onNotice(count ? `已提交 ${count} 个方案任务，画布占位框会显示进度并原位更新结果。` : "所选任务已有确认回执，本次未重复提交；请在任务岛查看最新进度。"); }
        catch (failure) { setError(failure.message); setProposalOpen(true); }
        finally { busyRef.current = false; setBusy(false); }
    };
    const importMaterial = async event => {
        const file = event.target.files?.[0]; event.target.value = "";
        if (!file || !ready || busyRef.current) return;
        if (materialDetails.current) materialDetails.current.open = true;
        if (session.documents.length >= 3) { setError("一次讨论最多添加 3 份资料。"); return; }
        setUploading(true); setError("");
        try {
            const doc = await readDesignMaterial(file);
            if (session.documents.reduce((sum, item) => sum + item.text.length, doc.text.length) > 12000) throw new Error("本轮资料正文合计超过 12000 字，请只保留本次需要的部分。");
            if (doc.figures.length > 20) throw new Error("文件含超过 20 张插图，请拆分本次需要的部分；本次未添加。");
            update({ documents: [...session.documents, { id: doc.id, name: doc.name, text: doc.text, figures: doc.figures, warnings: doc.warnings }] });
        } catch (failure) { setError(failure.message); }
        finally { setUploading(false); }
    };
    const setBrief = (key, value) => update({ brief: { ...session.brief, [key]: value } });
    const discussProposal = (proposal, referenceSnapshot) => {
        update({ discussionFocus: { kind: "proposal", title: proposal.title, proposal, referenceSnapshot }, mode: "discuss" });
        input.current.focus();
    };
    const discussResult = (task, index) => {
        try {
            const reference = resultDiscussionReference(task, index);
            update({ references: [reference], discussionFocus: { kind: "result", title: reference.title, taskId: task.taskId }, mode: "discuss" });
            input.current.focus();
        } catch (failure) { setError(failure.message); }
    };
    return <aside className={`studio-panel ${visible ? "" : "studio-panel-hidden"}`} aria-label="设计讨论面板" aria-hidden={!visible} aria-busy={!ready}>
        <header className="studio-panel-heading"><div><span className="studio-avatar"><Sparkles size={19} /></span><div><h1>设计讨论</h1><p>一起看稿，把方向聊清楚。</p></div></div><button aria-label="收起讨论面板" onClick={onClose}><X size={18} /></button></header>
        {!ready && <p className="studio-connection-status" role="status">正在恢复讨论或等待画布编辑权限，请稍候再编辑；连接失败时可在顶部重新连接。</p>}
        <nav className="studio-modes" aria-label="设计工作方式"><button disabled={busy || !ready} aria-pressed={session.mode === "discuss"} onClick={() => update({ mode: "discuss" })}><MessageCircle size={16} /><span>聊设计<small>讨论 → 选方案 → 出图</small></span></button><button disabled={busy || !ready} aria-pressed={session.mode === "direct"} onClick={() => update({ mode: "direct" })}><Sparkles size={16} /><span>直接出方案<small>图片 + 资料 → 多个方案图</small></span></button></nav>
        <div className="studio-context-heading"><strong>当前讨论对象 <span>{session.references.length ? `${session.references.length} 张 · 同一段讨论` : "尚未选图"}</span></strong><button disabled={busy || uploading || !ready} onClick={() => setPickerOpen(true)}>画布 / 素材选图</button></div>
        <div className="studio-references">{session.references.map((ref, index) => <div key={ref.id} className="studio-reference"><img src={ref.image} alt={ref.title} /><div><span title={ref.title}>图{index + 1} · {ref.title}</span><select aria-label={`图${index + 1}用途`} disabled={busy || !ready} value={ref.role || "auto"} onChange={event => changeRole(ref.id, event.target.value)}>{Object.entries(REFERENCE_ROLES).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div><button disabled={busy || !ready} aria-label={`移除图${index + 1}`} onClick={() => update({ references: session.references.filter(item => item.id !== ref.id) })}><X size={12} /></button></div>)}{!session.references.length && <p>单击画布图片即可带入；Shift 多选后一起聊。</p>}</div>
        {session.references.length > 1 && <p className="studio-reference-help">在下面说“图1保留版型、图2参考配色”即可，也可直接设置每张用途。分工影响结果时会先确认，不默认第一张是底图。</p>}
        <div className="studio-scroll" ref={scroll}>
            <details ref={materialDetails} className="studio-brief" open={session.mode === "direct" || undefined}><summary>品牌与设计资料 <span>{session.brief.brand || "添加客户背景"}</span></summary>
                <fieldset disabled={busy || uploading || !ready}><div className="studio-brief-grid"><label>合作品牌<select aria-label="合作品牌" value={session.brief.brand || ""} onChange={event => setBrief("brand", event.target.value)}><option value="">未指定品牌</option>{brands.map(brand => <option key={brand}>{brand}</option>)}</select></label><label>品类<select aria-label="产品品类" value={session.brief.category || ""} onChange={event => setBrief("category", event.target.value)}><option value="">按图片与描述判断</option>{CATEGORIES.map(category => <option key={category}>{category}</option>)}</select></label></div>
                <label>季节 / 客群 / 市场<input aria-label="季节与客群" maxLength={100} value={session.brief.season || ""} placeholder="如 2027 秋冬 · 女装 · 欧洲" onChange={event => setBrief("season", event.target.value)} /></label>
                <label>客户资料与设计边界<textarea aria-label="设计资料" maxLength={4000} value={session.brief.notes || ""} placeholder="品牌子线、客群、价格带、工艺条件、参考资料摘要…" onChange={event => setBrief("notes", event.target.value)} /></label>
                <label>必须保留<textarea aria-label="必须保留" maxLength={2000} value={session.designRecord.constraints.join("\n")} placeholder="每行一条，如保留图案完整轮廓、保留针织材质" onChange={event => update({ designRecord: { ...session.designRecord, constraints: event.target.value.split("\n").filter(Boolean) }, designRecordReferenceSnapshot: designReferenceSnapshot(session.references) })} /></label>
                <label>改动范围<select aria-label="改动范围" value={session.designRecord.mode} onChange={event => update({ designRecord: { ...session.designRecord, mode: event.target.value } })}>{Object.entries(DESIGN_MODES).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
                <button className="studio-attach" onClick={() => materialInput.current.click()}><Paperclip size={14} />{uploading ? "正在读取资料…" : "添加资料文件"}</button><p className="studio-help">PDF / Word / Excel / TXT，单份上限 20 MB；最多 3 份，正文合计 12000 字、单份最多 20 张页面图或插图。文字按页读取；扫描页与图表须选入参考组才参与看图，不会自动 OCR。添加资料本身不调用模型。</p>
                {session.documents.map(doc => <div className="studio-document" key={doc.id}><FileText size={15} /><div><strong>{doc.name}</strong><small>{doc.text.length} 字 · {doc.figures.length} 张插图</small>{doc.warnings.map(warning => <small key={warning}>{warning}</small>)}{doc.figures.length > 0 && <button onClick={() => onFigures(doc.figures, doc.name)}>把插图放到画布</button>}</div><button aria-label={`移除资料：${doc.name}`} onClick={() => update({ documents: session.documents.filter(item => item.id !== doc.id) })}><X size={13} /></button></div>)}
                </fieldset>
                <details className="studio-trend"><summary>可用趋势资料与边界</summary><p>使用带日期资料快照，不冒充实时搜索；只采用与本次季节、品类相符的观察。</p>{selectedTrendSources(session.brief.season).map(source => <p key={source.url}><a href={source.url} target="_blank" rel="noreferrer">{source.title} ↗</a><small>{source.date} · {source.scope}</small></p>)}</details>
            </details>
            {session.mode === "direct" && <section className="studio-presets"><h2>这次想怎样开发？</h2><div>{DESIGN_PRESETS.map(preset => <button key={preset.id} disabled={busy || !ready} aria-pressed={session.preset === preset.id} onClick={() => update({ preset: preset.id })}><strong>{preset.title}</strong><small>{preset.description}</small></button>)}</div></section>}
            {!session.history.length && <div className="studio-welcome"><span className="studio-eyebrow">LET'S DESIGN TOGETHER</span><h2>{session.mode === "discuss" ? "先聊清楚，再动手。" : "从参考出发，直接看方向。"}</h2><p>{session.mode === "discuss" ? "告诉我这组参考里你喜欢什么、想改变什么。我会看图、接住你的回答，提出不同的方案，再由你选来出图。" : "选好品牌、参考分工和开发预设，点击下方按钮。我会整理方案并提交对应图片任务，结果下方展示特色和所用参考。"}</p></div>}
            <section className="studio-conversation" aria-label="设计讨论记录">{session.history.map((message, index) => <article key={message.id || index} className={`studio-message ${message.role}`}>
                <span>{message.role === "user" ? "你" : "设计助手"}</span><p>{message.content}</p>
                {message.referenceSnapshot?.length > 0 && <small className="studio-message-refs">本轮：{message.referenceSnapshot.map(ref => `${ref.label} ${ref.title}`).join(" · ")}</small>}
                {message.questions?.map(question => <div className="studio-question" key={question.id}><strong>{question.question}</strong><div>{question.options.map(option => <button key={option} disabled={busy || !ready} onClick={() => { update({ prompt: `${question.question}\n我的选择：${option}` }); input.current.focus(); }}>{option}</button>)}</div></div>)}
                {message.proposals?.length > 0 && <div className="discussion-proposals" aria-label="本轮设计方向">{message.proposals.map((proposal, proposalIndex) => <div key={proposal.id}>
                    <details><summary><span>{proposalIndex + 1}</span>{proposal.title}</summary><ul>{proposal.features.map(feature => <li key={feature}>{feature}</li>)}</ul><p>{proposal.rationale}</p></details>
                    <button disabled={busy || !ready} onClick={() => discussProposal(proposal, message.referenceSnapshot)}>围绕这个聊</button>
                </div>)}</div>}
                {message.trendStatus && <details><summary>本轮资料依据</summary><p>{message.trendStatus}</p>{message.sources.map(source => <a key={source.url} href={source.url} target="_blank" rel="noreferrer">{source.title} ↗</a>)}</details>}
                <DiscussionResults tasks={messageTasks(session, message, index, tasks)} onDiscuss={discussResult} onLocate={onLocateResult} disabled={busy || !ready} />
            </article>)}
                {pendingMessage && <><article className="studio-message user"><span>你</span><p>{pendingMessage.content}</p></article><div className="discussion-thinking" role="status"><LoaderCircle size={14} className="spin" />正在看这一轮的图片和想法…</div></>}
            </section>
            {batch && <button className="studio-batch" disabled={busy || !ready} onClick={() => { setChosenProposals([batch.proposals[0].id]); setProposalOpen(true); }}><Sparkles size={17} /><span>{stale ? "参考或资料已变化 · 旧方案需要更新" : `${batch.proposals.length} 个设计方案已整理`}<small>{Object.keys(batch.submissions || {}).length ? `已记录 ${Object.keys(batch.submissions).length} 个请求 · 查看回执与特色` : "点击比较、勾选，再生成图片"}</small></span></button>}
            {steps.length > 0 && <details className="discussion-process"><summary>本轮处理记录</summary><ol className="studio-progress" aria-label="实际处理步骤">{steps.map(step => <li key={step.id}>{step.status === "complete" ? <Check size={13} /> : busy ? <LoaderCircle size={13} className="spin" /> : <span>·</span>}<span>{step.label}{!busy && step.status !== "complete" ? "（本轮已停止）" : ""}</span></li>)}</ol></details>}
        </div>
        <footer className="studio-composer">
            {error && <p role="alert" className="studio-error">{error}</p>}
            {session.discussionFocus && <div className="discussion-focus" role="status"><span>正在聊：{session.discussionFocus.title}{session.discussionFocus.kind === "result" ? " · 此图已作为当前修改对象" : ""}</span><button disabled={busy || !ready} aria-label="取消指定讨论对象" onClick={() => update({ discussionFocus: null })}><X size={13} /></button></div>}
            <textarea ref={input} aria-label="输入设计需求" disabled={busy || !ready} maxLength={8000} value={session.prompt} onChange={event => update({ prompt: event.target.value })} placeholder={session.mode === "discuss" ? "我喜欢图1的构图，但想往更轻盈的方向走…" : "补充这次方案的具体要求…"} onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && session.mode === "discuss") { event.preventDefault(); void run("discuss"); } }} />
            <div className="discussion-composer-controls">
                <button aria-label="上传参考图片" disabled={busy || uploading || !ready} onClick={() => imageInput.current.click()}><ImagePlus size={17} /></button>
                <button aria-label="添加 PDF 或文档，单份上限 20 MB" title="PDF / 文档 · 单份上限 20 MB" disabled={busy || uploading || !ready} onClick={() => materialInput.current.click()}>{uploading ? <LoaderCircle size={17} className="spin" /> : <Paperclip size={17} />}</button>
                <details className="discussion-settings" open={session.mode === "direct" || undefined}><summary>出图设置 · {chosenModel?.label || "选择模型"} · {session.generationCount || 1}{video ? " 个视频" : " 张"}</summary><div className="studio-composer-tools">
                <label>生成类型<select aria-label="生成类型" disabled={busy || !ready} value={session.outputKind || "image"} onChange={event => update({ outputKind: event.target.value, modelId: "" })}><option value="image">图片</option><option value="video">视频</option></select></label>
                <label>{video ? "视频模型" : "出图模型"}<select aria-label="出图模型" disabled={busy || !ready} value={chosenModel?.id || session.modelId || ""} onChange={event => update({ modelId: event.target.value })}>{!chosenModel && <option value="">请选择可用模型</option>}<ModelOptions models={models} video={video} /></select></label>
                <label>可选方案<select aria-label="方案数量" value={session.proposalCount} disabled={busy || !ready} onChange={event => update({ proposalCount: Number(event.target.value) })}>{[1, 2, 3, 4, 5, 6].map(count => <option key={count} value={count}>{count}</option>)}</select></label>
                <label>生成数量<select aria-label="生成数量" value={session.generationCount || 1} disabled={busy || !ready} onChange={event => update({ generationCount: Number(event.target.value) })}>{Array.from({ length: 15 }, (_, index) => index + 1).map(count => <option key={count} value={count}>{count}</option>)}</select></label>
                {video && <label>时长（秒）<select aria-label="视频时长" disabled={busy || !ready} value={session.videoSeconds || 6} onChange={event => update({ videoSeconds: Number(event.target.value) })}>{[4, 5, 6, 8, 10, 15].map(seconds => <option key={seconds} value={seconds}>{seconds}</option>)}</select></label>}
                </div></details>
            </div>
            {video && <p className="studio-help">视频默认 720p、无生成音轨；单图作首帧，多图作参考。实际规格按所选模型核验，素材不符合时不会提交。</p>}
            <div className="studio-send"><small>对话、图片及视频均可能计费<br />{session.mode === "discuss" ? "Enter 只讨论 · 选方案后才出图" : "点击后整理方案并提交图片任务"}</small><div>{session.mode === "discuss" ? <><button disabled={busy || uploading || !ready} onClick={() => void run("propose")}>给我方案</button><button className="studio-primary" disabled={busy || uploading || !ready} onClick={() => void run("discuss")}>{busy ? <LoaderCircle size={15} className="spin" /> : <ArrowUp size={16} />}发送讨论</button></> : <button className="studio-primary" disabled={busy || uploading || !ready || !chosenModel} onClick={() => void run("direct")}>{busy ? <LoaderCircle size={15} className="spin" /> : <Sparkles size={16} />}生成 {session.generationCount || 1} {video ? "个方案视频" : "张方案图"}</button>}</div></div>
        </footer>
        <input ref={imageInput} disabled={busy || uploading || !ready} hidden type="file" multiple accept="image/png,image/jpeg,image/webp" onChange={event => { const files = Array.from(event.target.files || []); event.target.value = ""; if (files.length) onImport(files).catch(failure => setError(failure.message)); }} />
        <input ref={materialInput} disabled={busy || uploading || !ready} hidden type="file" aria-label="上传设计资料" accept=".pdf,.docx,.xlsx,.xls,.txt,.md,.csv" onChange={importMaterial} />
        {pickerOpen && ready && <ReferencePicker open items={items} currentIds={session.references.map(ref => ref.id)} api={api} onChoose={onChoose} onClose={() => setPickerOpen(false)} />}
        {proposalOpen && batch && <ProposalDialog batch={batch} selected={chosenProposals} onSelect={ids => { setChosenProposals(ids); if (ids.length > (session.generationCount || 1)) update({ generationCount: ids.length }); }} onClose={() => setProposalOpen(false)} onGenerate={generateSelected} busy={busy} ready={ready} error={error || (!ready ? "正在恢复讨论与连接服务，请稍候再编辑。" : "")} stale={stale} models={models} modelId={chosenModel?.id} onModel={modelId => update({ modelId })} count={session.generationCount || 1} onCount={generationCount => update({ generationCount })} video={video} />}
    </aside>;
}
