import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";
import { deploymentFeatures } from "@/lib/deployment-features";
import { readImageMeta } from "@/lib/image-utils";
import { useUserStore } from "@/stores/use-user-store";
import { uploadServerAsset } from "./api/server-assets";
import { uploadImage, type UploadedImage } from "./image-storage";
import { rememberMediaSource, rememberUploadedMedia, serverMediaId } from "./canvas-media-links";

export type UserUploadedImage = UploadedImage & { sourceAssetId?: string; sourceUrl?: string };
type UploadOptions = { source: string; ownerId?: string; name?: string; signal?: AbortSignal; validate?: (image: { width: number; height: number; mimeType: string }) => void };

export async function uploadUserImage(input: Blob, options: UploadOptions): Promise<UserUploadedImage> {
    const enterprise = deploymentFeatures.authenticationEnabled;
    const ownerId = options.ownerId || useUserStore.getState().user?.id;
    const assertCurrent = () => {
        options.signal?.throwIfAborted();
        const { user, status } = useUserStore.getState();
        if (enterprise && (!ownerId || user?.id !== ownerId || status !== "authenticated" || user.status !== "active")) throw new Error("员工会话已变化，已停止添加图片；已上传的原件仍归原账号保存。");
    };
    assertCurrent();
    if (!input.size || !input.type.startsWith("image/")) throw new Error("请选择有效的图片文件");
    const preview = URL.createObjectURL(input);
    let meta: Awaited<ReturnType<typeof readImageMeta>>;
    try { meta = await readImageMeta(preview); }
    finally { URL.revokeObjectURL(preview); }
    assertCurrent();
    options.validate?.(meta);
    if (!enterprise) return uploadImage(input);
    const name = options.name || (input instanceof File ? input.name : `image.${input.type.split("/")[1] || "png"}`);
    const contentSha256 = bytesToHex(sha256(new Uint8Array(await input.arrayBuffer())));
    assertCurrent();
    const file = input instanceof File && input.name === name ? input : new File([input], name, { type: input.type });
    const assetId = await uploadServerAsset(file, { title: name, originalFileName: name, source: options.source, contentSha256, naturalWidth: meta.width, naturalHeight: meta.height },
        { expectedOwnerId: ownerId, clientReferenceId: `user-image:${contentSha256}`, signal: options.signal });
    assertCurrent();
    const url = `/api/assets/${assetId}/content`;
    if (!serverMediaId(url)) throw new Error("服务器返回了无效的图片编号，原件保存状态需要核查。");
    const durable: UserUploadedImage = { url, sourceUrl: url, sourceAssetId: assetId, storageKey: "", width: meta.width, height: meta.height, bytes: input.size, mimeType: input.type, originalFileName: name };
    try {
        const local = await uploadImage(input);
        assertCurrent();
        await rememberMediaSource(local.storageKey, url);
        assertCurrent();
        await rememberUploadedMedia(ownerId!, local.storageKey, url);
        assertCurrent();
        return { ...local, url, sourceUrl: url, sourceAssetId: assetId, originalFileName: name };
    } catch {
        assertCurrent();
        return durable;
    }
}
