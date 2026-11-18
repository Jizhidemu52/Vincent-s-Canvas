import React from "react";
import { LocateFixed, MessageCircle } from "lucide-react";
import { ownedAsset, taskLabel } from "./task-model.mjs";

export function DiscussionResults({ tasks, onDiscuss, onLocate, disabled }) {
    if (!tasks.length) return null;
    return <section className="discussion-results" aria-label="本轮生成结果">
        <p>这一轮的结果 · 可以选一张接着聊</p>
        <div>{tasks.map(task => <figure key={task.id} data-discussion-task={task.id}>
            {task.status === "success" ? task.resultUrls.filter(ownedAsset).map((url, index) => <div key={url}>
                {task.mediaKind === "video" ? <video src={url} controls preload="metadata" aria-label={`${task.proposal?.title || "生成结果"}视频`} /> : <button className="discussion-result-image" aria-label={`查看生成图：${task.proposal?.title || "生成结果"}`} onClick={() => onLocate(task, index)}><img src={url} alt={`${task.proposal?.title || "设计方案"}生成结果`} loading="lazy" /></button>}
                <div className="discussion-result-actions"><button disabled={disabled} onClick={() => onLocate(task, index)}><LocateFixed size={13} />画布定位</button>{task.mediaKind !== "video" && <button disabled={disabled} onClick={() => onDiscuss(task, index)}><MessageCircle size={13} />围绕这张聊</button>}</div>
            </div>) : <div className="discussion-result-waiting" role="status">{taskLabel(task)}</div>}
            <figcaption><strong>{task.proposal?.title || "设计方案"}</strong><small>{task.model}</small></figcaption>
        </figure>)}</div>
    </section>;
}
