import localforage from "localforage";
import { createWorkspaceStorage } from "@/lib/workspace-storage";
import { useUserStore } from "@/stores/use-user-store";
import { createWorkbenchProjectStorage } from "./project-storage";
import { imageToDataUrl } from "@/services/image-storage";
import { uploadServerAsset } from "@/services/api/server-assets";
import type { InsertAssetPayload } from "@/components/canvas/asset-picker-modal";

/** Page-owned resources: never share image data, pending imports, or toasts across owners. */
export function createLocalWorkbenchServices(root: HTMLElement, ownerId: string | null, signal: AbortSignal, setDirty: (dirty: boolean) => void = () => {}, chooseAsset?: () => Promise<InsertAssetPayload | null>) {
    const persistence = createWorkbenchProjectStorage(
        createWorkspaceStorage("design_workbench_projects", { driver: localforage.INDEXEDDB }),
        ownerId,
        () => useUserStore.getState().user?.id || null,
        () => !signal.aborted,
    );
    const urls = new Map<string, ReturnType<typeof setTimeout>>();
    let toastTimer: ReturnType<typeof setTimeout> | undefined;
    let toast: HTMLDivElement | undefined;
    const abortError = () => new DOMException("工作台已关闭", "AbortError");

    function loadImage(src: string): Promise<HTMLImageElement> {
        persistence.assertCurrent();
        return new Promise((resolve, reject) => {
            const image = new Image();
            const finish = () => {
                image.onload = null;
                image.onerror = null;
                signal.removeEventListener("abort", abort);
            };
            const abort = () => {
                finish();
                image.src = "";
                reject(abortError());
            };
            image.onload = () => {
                finish();
                try {
                    persistence.assertCurrent();
                    if (!image.naturalWidth || !image.naturalHeight || image.naturalWidth > 8192 || image.naturalHeight > 8192 || image.naturalWidth * image.naturalHeight > 32_000_000)
                        throw new Error("图片每边不能超过 8192 像素，总量不能超过 3200 万像素");
                    resolve(image);
                } catch (error) {
                    reject(error);
                }
            };
            image.onerror = () => {
                finish();
                reject(new Error("无法读取图片，请使用有效的 PNG、JPG 或 WebP"));
            };
            signal.addEventListener("abort", abort, { once: true });
            image.src = src;
        });
    }

    async function readImageFile(file: File) {
        persistence.assertCurrent();
        if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) throw new Error("请选择 PNG、JPG 或 WebP 图片；透明图案建议使用 PNG");
        if (file.size > 15 * 1024 * 1024) throw new Error("图片超过 15 MB，请先缩小后再试");
        const result = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            const finish = () => {
                reader.onload = null;
                reader.onerror = null;
                reader.onabort = null;
                signal.removeEventListener("abort", abort);
            };
            const abort = () => {
                finish();
                reader.abort();
                reject(abortError());
            };
            reader.onload = () => {
                finish();
                resolve(String(reader.result));
            };
            reader.onerror = () => {
                finish();
                reject(new Error("文件读取失败"));
            };
            signal.addEventListener("abort", abort, { once: true });
            reader.readAsDataURL(file);
        });
        persistence.assertCurrent();
        await loadImage(result);
        return result;
    }

    function downloadBlob(blob: Blob, name: string) {
        persistence.assertCurrent();
        if (!(blob instanceof Blob) || !blob.size) throw new Error("导出内容为空，请重试");
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = name;
        anchor.hidden = true;
        root.append(anchor);
        anchor.click();
        anchor.remove();
        urls.set(
            url,
            setTimeout(() => {
                URL.revokeObjectURL(url);
                urls.delete(url);
            }, 30_000),
        );
    }

    function notify(message: string, tone = "success") {
        if (signal.aborted || useUserStore.getState().user?.id !== (ownerId || undefined)) return;
        if (tone === "error" && /quota|disk space|storage.*full/i.test(message)) message = "浏览器本地存储空间不足，请先导出工程文件。";
        if (!toast) {
            toast = document.createElement("div");
            root.append(toast);
        }
        toast.setAttribute("role", tone === "error" ? "alert" : "status");
        toast.className = `local-workbench-toast ${tone}`;
        toast.textContent = message;
        toast.hidden = false;
        clearTimeout(toastTimer);
        toastTimer = setTimeout(
            () => {
                if (toast) toast.hidden = true;
            },
            tone === "error" ? 6500 : 3500,
        );
    }

    signal.addEventListener(
        "abort",
        () => {
            clearTimeout(toastTimer);
            toast?.remove();
            toast = undefined;
            for (const [url, timer] of urls) {
                clearTimeout(timer);
                URL.revokeObjectURL(url);
            }
            urls.clear();
        },
        { once: true },
    );
    async function pickImage() {
        persistence.assertCurrent();
        const asset = await chooseAsset?.();
        persistence.assertCurrent();
        if (!asset || asset.kind !== "image") return null;
        const src = await imageToDataUrl(asset);
        persistence.assertCurrent();
        if (!/^data:image\/(png|jpeg|webp);base64,/i.test(src) || src.length > 21_000_000) throw new Error("请选择 15 MB 以内的 PNG、JPG 或 WebP 素材");
        await loadImage(src);
        return { src, name: asset.title.slice(0, 80) || "素材库图片" };
    }
    async function saveAsset(blob: Blob, name: string) {
        persistence.assertCurrent();
        const assetId = await uploadServerAsset(
            new File([blob], name, { type: blob.type }),
            { title: name, source: "design-workbench", module: "设计工作台", tags: ["工作台导出"] },
            { expectedOwnerId: ownerId || undefined, signal, clientReferenceId: crypto.randomUUID() },
        );
        persistence.assertCurrent();
        notify("已保存到素材库，可继续用于画布或生成参考图。");
        return assetId;
    }
    return { ...persistence, signal, loadImage, readImageFile, downloadBlob, notify, setDirty, pickImage, saveAsset };
}

export type LocalWorkbenchServices = ReturnType<typeof createLocalWorkbenchServices>;
