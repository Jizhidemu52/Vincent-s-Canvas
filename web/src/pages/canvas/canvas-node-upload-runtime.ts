import { NODE_DEFAULT_SIZE } from "@/constant/canvas";
import { assertCanvasImageUploadSize, isLargeCanvasImage } from "@/lib/canvas/canvas-image-upload-limit";
import { fitNodeSize } from "@/lib/canvas/canvas-node-size";
import { uiText } from "@/lib/i18n";
import { uploadMediaFile } from "@/services/file-storage";
import { uploadImage } from "@/services/image-storage";
import { CanvasNodeType, type CanvasNodeData, type Position } from "@/types/canvas";
import { audioMetadata, replaceCanvasNodeImage, videoMetadata } from "./canvas-project-utils";
import { isCanvasAudioFile } from "./use-canvas-clipboard-drop";
import type { InsertAssetPayload } from "@/components/canvas/asset-picker-modal";
import type { CanvasAssistantImage } from "@/types/canvas";
import { readImageMeta } from "@/lib/image-utils";
import { resolveImageUrl } from "@/services/image-storage";
import { resolveMediaUrl } from "@/services/file-storage";
import { imageMetadata } from "./canvas-project-utils";
import { createClientUuid } from "@/lib/client-uuid";

export async function assistantImageNode(image:CanvasAssistantImage,center:()=>Position):Promise<CanvasNodeData>{
    const stored=image.storageKey?{url:image.dataUrl,storageKey:image.storageKey,width:1,height:1,bytes:0,mimeType:image.mimeType||"image/png"}:await uploadImage(image.dataUrl);
    const actual=stored.width===1&&stored.height===1?await readImageMeta(stored.url):stored;
    const size=fitNodeSize(actual.width,actual.height),p=center();
    return {id:"image-"+createClientUuid(),type:CanvasNodeType.Image,title:image.prompt.slice(0,32)||"Generated Image",...size,
        position:{x:p.x-size.width/2,y:p.y-size.height/2},metadata:{...imageMetadata({...stored,width:actual.width,height:actual.height}),prompt:image.prompt,imageName:image.imageName,imageVersion:image.imageVersion||1}};
}
export async function pickedMediaNode(payload:Exclude<InsertAssetPayload,{kind:"text"}>,center:()=>Position){
    if(payload.kind==="video"){
        const content=payload.storageKey?await resolveMediaUrl(payload.storageKey,payload.url):payload.url,spec=NODE_DEFAULT_SIZE[CanvasNodeType.Video];
        const size=fitNodeSize(payload.width||spec.width,payload.height||spec.height,420,420),p=center();
        return {id:"video-"+createClientUuid(),type:CanvasNodeType.Video,title:payload.title,...size,position:{x:p.x-size.width/2,y:p.y-size.height/2},metadata:{content,storageKey:payload.storageKey,status:"success",naturalWidth:payload.width,naturalHeight:payload.height}} satisfies CanvasNodeData;
    }
    const dataUrl=payload.storageKey?await resolveImageUrl(payload.storageKey,payload.dataUrl):payload.dataUrl;
    return assistantImageNode({id:"asset-"+createClientUuid(),prompt:payload.title,dataUrl,storageKey:payload.storageKey,mimeType:payload.mimeType,imageName:payload.imageName,imageVersion:payload.imageVersion},center);
}

export { prepareCanvasMediaNode } from "./canvas-import-media";

export function selectCanvasUploadFiles(selected: File[], imageOnly = false) {
    const files = selected.filter(file => file.type.startsWith("image/") || (!imageOnly && (file.type.startsWith("video/") || isCanvasAudioFile(file))));
    const first = files[0];
    const kind = first && isCanvasAudioFile(first) ? "audio" : first?.type.startsWith("video/") ? "video" : "image";
    return { files, kind: kind as "image" | "video" | "audio", warning: files.length === selected.length ? "" : uiText(imageOnly ? "参考款原图仅支持图片，其他文件已跳过" : "仅支持图片、视频和音频，其他文件已跳过") };
}

/** Read media only after selection; the caller applies the replacement to its latest graph synchronously. */
export async function prepareCanvasNodeUpload(file: File, kind: "image" | "video" | "audio") {
    if (kind === "image") {
        assertCanvasImageUploadSize(file);
        const image = await uploadImage(file);
        return { replace: (node: CanvasNodeData) => replaceCanvasNodeImage(node, image, file.name), openDialog: true, largeImage: isLargeCanvasImage(image) };
    }
    const media = await uploadMediaFile(file, kind);
    const audio = kind === "audio";
    const size = audio ? NODE_DEFAULT_SIZE[CanvasNodeType.Audio] : fitNodeSize(media.width || 1280, media.height || 720, 420, 420);
    return {
        replace: (node: CanvasNodeData): CanvasNodeData => ({
            ...node, type: audio ? CanvasNodeType.Audio : CanvasNodeType.Video, title: file.name,
            position: { x: node.position.x + node.width / 2 - size.width / 2, y: node.position.y + node.height / 2 - size.height / 2 },
            width: size.width, height: size.height,
            metadata: { ...node.metadata, ...(audio ? audioMetadata(media) : videoMetadata(media)), errorDetails: undefined },
        }),
        openDialog: !audio,
        largeImage: false,
    };
}

export async function createCanvasUploadedNode(file: File, kind: "image" | "video" | "audio", position: Position) {
    const upload = await prepareCanvasNodeUpload(file, kind);
    const node = upload.replace({ id: `${kind}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, type: CanvasNodeType.Image, title: file.name, position, width: 0, height: 0 });
    node.position = { x: position.x - node.width / 2, y: position.y - node.height / 2 };
    return { node, largeImage: upload.largeImage };
}
export { placeCanvasImportedNodes } from "./canvas-import-placement";
