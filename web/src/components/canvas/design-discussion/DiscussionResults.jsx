import React from "react";
import { Copy, LocateFixed, MessageCircle } from "lucide-react";
import { ownedAsset, taskLabel } from "./task-model.mjs";
import { resultDiscussionReference } from "./discussion-thread.mjs";
import { CanvasPersistedMediaPreview } from "@/components/canvas/canvas-persisted-media-preview";

export function DiscussionResults({ tasks, onDiscuss, onLocate, onPreview, onCopy, disabled, previewDisabled }) {
    if (!tasks.length) return null;
    return (
        <section className="discussion-results" aria-label="本轮生成结果">
            <p>这一轮的结果 · 可以选一张接着聊</p>
            <div>
                {tasks.map((task) => (
                    <figure key={task.id} data-discussion-task={task.id}>
                        {task.status === "success" ? (
                            task.resultUrls.map(
                                (url, index) =>
                                    ownedAsset(url) && (
                                        <div key={url}>
                                            {task.mediaKind === "video" ? (
                                                <video
                                                    src={url}
                                                    controls
                                                    preload="metadata"
                                                    aria-label={`${task.proposal?.title || "生成结果"}视频`}
                                                />
                                            ) : (
                                                <button
                                                    className="discussion-result-image"
                                                    disabled={previewDisabled}
                                                    aria-label={`查看生成图：${task.proposal?.title || "生成结果"}`}
                                                    onClick={() => onPreview(resultDiscussionReference(task, index))}
                                                >
                                                    <CanvasPersistedMediaPreview
                                                        kind="image"
                                                        url={url}
                                                        alt={`${task.proposal?.title || "设计方案"}生成结果`}
                                                        className=""
                                                    />
                                                </button>
                                            )}
                                            <div className="discussion-result-actions">
                                                <button disabled={disabled} onClick={() => onLocate(task, index)}>
                                                    <LocateFixed size={13} />
                                                    画布定位
                                                </button>
                                                {task.mediaKind !== "video" && (
                                                    <>
                                                        <button
                                                            disabled={disabled}
                                                            onClick={() => onDiscuss(task, index)}
                                                        >
                                                            基于此图修改
                                                        </button>
                                                        <button
                                                            disabled={previewDisabled}
                                                            onClick={() =>
                                                                onCopy(resultDiscussionReference(task, index))
                                                            }
                                                        >
                                                            <Copy size={13} />
                                                            复制图片
                                                        </button>
                                                        <button
                                                            disabled={disabled}
                                                            onClick={() => onDiscuss(task, index)}
                                                        >
                                                            <MessageCircle size={13} />
                                                            围绕这张聊
                                                        </button>
                                                    </>
                                                )}
                                            </div>
                                        </div>
                                    ),
                            )
                        ) : (
                            <div className="discussion-result-waiting" role="status">
                                {taskLabel(task)}
                            </div>
                        )}
                        <figcaption>
                            <strong>{task.proposal?.title || "设计方案"}</strong>
                            <small>{task.model}</small>
                        </figcaption>
                    </figure>
                ))}
            </div>
        </section>
    );
}
