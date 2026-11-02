import { nanoid } from "nanoid";
import { NODE_DEFAULT_SIZE } from "@/constant/canvas";
import { assertCanvasImageUploadSize } from "@/lib/canvas/canvas-image-upload-limit";
import { fitNodeSize } from "@/lib/canvas/canvas-node-size";
import { uploadImage } from "@/services/image-storage";
import { uploadMediaFile } from "@/services/file-storage";
import { CanvasNodeType, type CanvasNodeData, type Position } from "@/types/canvas";
import { audioMetadata, imageMetadata, videoMetadata } from "./canvas-project-utils";

/** Prepare uploads concurrently, then the caller inserts the entire batch as one edit. */
export async function prepareCanvasMediaNode(file: File, center: Position): Promise<CanvasNodeData> {
    const audio = file.type.startsWith("audio/") || /\.(mp3|wav)$/i.test(file.name), video = file.type.startsWith("video/");
    const type = audio ? CanvasNodeType.Audio : video ? CanvasNodeType.Video : CanvasNodeType.Image;
    if (!audio && !video) assertCanvasImageUploadSize(file);
    const media = audio ? await uploadMediaFile(file, "audio") : video ? await uploadMediaFile(file, "video") : await uploadImage(file);
    const size = audio ? NODE_DEFAULT_SIZE[CanvasNodeType.Audio] : fitNodeSize(media.width || (video ? 1280 : 256), media.height || (video ? 720 : 256), video ? 420 : undefined, video ? 420 : undefined);
    const metadata = audio ? audioMetadata(media as Awaited<ReturnType<typeof uploadMediaFile>>) : video ? videoMetadata(media as Awaited<ReturnType<typeof uploadMediaFile>>) : imageMetadata(media as Awaited<ReturnType<typeof uploadImage>>);
    return { id: `${type}-${nanoid()}`, type, title: file.name, position: { x: center.x - size.width / 2, y: center.y - size.height / 2 }, width: size.width, height: size.height, metadata };
}
