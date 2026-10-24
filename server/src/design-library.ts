import { createHash, randomUUID } from "node:crypto";
import { z, ZodError } from "zod";
import { detectReferenceImage } from "./reference-import";
import { createAssetThumbnailBytes } from "./asset-thumbnails";

export type DesignLibraryStatus = "published" | "withdrawn" | "taken_down";
export type DesignLibraryAction = "view" | "download" | "reuse" | "prompt_copy";
export type DesignLibraryActor = {
    id: string; name: string; departmentId: string | null; departmentName: string | null;
    role: "designer" | "department_admin" | "super_admin";
    /** Set by trusted route/session integration, never parsed from request JSON. */
    kind: "employee" | "admin";
};
export type DesignLibraryImage = {
    id: string; filename: string; mimeType: string; byteSize: number;
    width: number | null; height: number | null; contentUrl: string; thumbnailUrl?: string;
};
export type DesignLibraryEntry = {
    id: string; title: string; thought: string; prompt: string; tags: string[];
    author: { id: string; name: string; departmentId: string | null; departmentName: string | null };
    status: DesignLibraryStatus; createdAt: string; updatedAt: string;
    images: DesignLibraryImage[]; canWithdraw: boolean; canModerate: boolean; canViewStats: boolean;
};
export type DesignLibraryMetric = { count: number; people: number };
export type DesignLibraryCounts = Record<DesignLibraryAction, DesignLibraryMetric>;
export type DesignLibraryStats = {
    entryId: string; totals: DesignLibraryCounts;
    images: { imageId: string; filename: string; counts: DesignLibraryCounts }[];
    activity: { id: string; action: "download" | "reuse"; imageId: string | null; filename: string | null;
        actor: { id: string; name: string; departmentName: string | null }; createdAt: string }[];
    activityTotal: number; page: number; pageSize: number;
};
export type DesignLibraryList = { items: DesignLibraryEntry[]; total: number; page: number; pageSize: number };
export type DesignLibraryReuse = { assetId: string; image: DesignLibraryImage;
    source: { entryId: string; imageId: string; title: string; authorName: string } };

export type LibraryImageRecord = Omit<DesignLibraryImage, "contentUrl" | "thumbnailUrl"> & { objectKey: string };
export type LibraryMediaStat = { byteSize: number; mimeType: string | null; etag: string };
export type DesignLibraryMediaResponse = { status: 200 | 304; bytes: Uint8Array | null; image: LibraryImageRecord; etag: string };
export type LibraryPublication = Omit<DesignLibraryEntry, "images" | "canWithdraw" | "canModerate" | "canViewStats"> & {
    images: LibraryImageRecord[]; requestId: string; payloadHash: string;
    moderationReason: string | null; moderatedBy: string | null;
};
export type LibrarySourceAsset = {
    id: string; ownerId: string; objectKey: string; filename: string; mimeType: string;
    byteSize: number; kind: string; status: string; deleted: boolean;
};
export type LibraryPrivateAsset = LibrarySourceAsset & {
    departmentId: string | null; createdAt: string;
    metadata: { designLibrarySource: { entryId: string; imageId: string; title: string; authorName: string }; width: number | null; height: number | null };
};
export type LibraryDelivery = {
    key: string; actorId: string; entryId: string; imageId: string; action: "download" | "reuse";
    requestId: string; assetId: string | null; createdAt: string;
};
export type LibraryReceipt = {
    id: string; key: string; entryId: string; imageId: string | null; action: DesignLibraryAction;
    actorId: string; actorName: string; departmentName: string | null; requestId: string; createdAt: string;
};
export type LibraryMetricRow = {
    level: "entry" | "image"; imageId: string | null; action: DesignLibraryAction; count: number; people: number;
};
export type LibraryListFilter = {
    authorId?: string; departmentId?: string; statuses?: DesignLibraryStatus[];
    query: string; tag: string; page: number; pageSize: number;
};

/** Adapters persist state only. External media preparation happens before short commit transactions.
 * lock() is transaction-scoped (PG advisory lock / serialized SQLite transaction).
 * getPublication(id,true) locks status while issuing a delivery or changing publication state.
 * getSourceAsset must return only the requested owner; service rechecks ready/deleted/kind.
 */
export interface DesignLibraryRepository {
    transaction<T>(work: (repository: DesignLibraryRepository) => Promise<T>): Promise<T>;
    lock(key: string): Promise<void>;
    findPublication(authorId: string, requestId: string): Promise<LibraryPublication | null>;
    getPublication(id: string, lock?: boolean): Promise<LibraryPublication | null>;
    listPublications(filter: LibraryListFilter): Promise<{ items: LibraryPublication[]; total: number }>;
    insertPublication(publication: LibraryPublication): Promise<void>;
    setPublicationStatus(id: string, status: DesignLibraryStatus, updatedAt: string, reason: string | null, moderatorId: string | null): Promise<void>;
    getSourceAsset(id: string, ownerId: string): Promise<LibrarySourceAsset | null>;
    insertPrivateAsset(asset: LibraryPrivateAsset): Promise<void>;
    getDelivery(key: string): Promise<LibraryDelivery | null>;
    insertDelivery(delivery: LibraryDelivery): Promise<void>;
    hasReceipt(key: string): Promise<boolean>;
    insertReceipt(receipt: LibraryReceipt): Promise<void>;
    /** entry view counts only imageId=null; other entry actions count DISTINCT actor across all images. */
    getMetricRows(entryId: string): Promise<LibraryMetricRow[]>;
    /** Download/reuse receipts only; newest first. Never include private canvas identifiers. */
    listActivity(entryId: string, page: number, pageSize: number): Promise<{ items: LibraryReceipt[]; total: number }>;
}
export interface DesignLibraryMediaStore {
    read(key: string, expectedBytes?: number, options?: { ifMatch?: string }): Promise<Uint8Array>;
    /** Metadata only. Null means a missing object, not a failed read or missing permission. */
    stat?(key: string): Promise<LibraryMediaStat | null>;
    write(key: string, bytes: Uint8Array, mimeType: string): Promise<void>;
    remove(key: string): Promise<void>;
    /** External stores copy outside SQL transactions, conditionally against the validated source version.
     * Embedded stores may omit this: their BLOB writes remain atomic with their SQL records. */
    copy?(sourceKey: string, destinationKey: string, options: { byteSize: number; validate?: (bytes: Uint8Array) => void | Promise<void> }): Promise<void>;
}

export class DesignLibraryError extends Error {
    constructor(readonly code: string, message: string, readonly status = 400) { super(message); }
}
const requestId = z.string().trim().min(8).max(160);
const recordId = z.string().uuid();
export const designLibraryPublishSchema = z.object({
    title: z.string().trim().min(1).max(120), thought: z.string().trim().max(12000), prompt: z.string().trim().max(12000),
    tags: z.array(z.string().trim().min(1).max(32)).max(8), assetIds: z.array(recordId).max(12), requestId,
}).strict().superRefine((value, context) => {
    if (!value.thought && !value.prompt && !value.assetIds.length) context.addIssue({ code: "custom", message: "请填写设计思路、提示词或选择图片" });
    if (new Set(value.assetIds).size !== value.assetIds.length) context.addIssue({ code: "custom", message: "请勿重复选择同一图片" });
}).transform(value => ({ ...value, tags: [...new Set(value.tags)] }));
export type DesignLibraryPublishInput = z.infer<typeof designLibraryPublishSchema>;
export const designLibraryReceiptSchema = z.object({
    action: z.enum(["view", "download", "reuse", "prompt_copy"]), requestId,
    imageId: recordId.optional(), reusedAssetId: recordId.optional(),
}).strict();
export type DesignLibraryReceiptInput = z.infer<typeof designLibraryReceiptSchema>;
export const designLibraryOperationSchema = z.object({ requestId }).strict();
export const designLibraryModerateSchema = z.object({ reason: z.string().trim().min(1).max(1000) }).strict();
export const designLibraryListSchema = z.object({
    scope: z.enum(["company", "mine", "all"]).default("company"), q: z.string().trim().max(200).default(""),
    tag: z.string().trim().max(32).default(""), page: z.coerce.number().int().min(1).max(100000).default(1),
    pageSize: z.coerce.number().int().min(1).max(60).default(24),
}).strict();
export const designLibraryPageSchema = z.object({
    page: z.coerce.number().int().min(1).max(100000).default(1), pageSize: z.coerce.number().int().min(1).max(60).default(20),
}).strict();

export function designLibraryFailure(error: unknown) {
    const status = error instanceof DesignLibraryError ? error.status : error instanceof ZodError ? 400 : 500;
    return { status, body: { code: status, error: error instanceof DesignLibraryError ? error.code : error instanceof ZodError ? "VALIDATION_ERROR" : "INTERNAL_ERROR",
        msg: error instanceof DesignLibraryError ? error.message : error instanceof ZodError ? "灵感库请求格式不正确" : "灵感库暂时不可用，请稍后重试" } };
}

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_PUBLICATION_BYTES = 100 * 1024 * 1024;
const MAX_THUMBNAIL_BYTES = 1024 * 1024;
const thumbnailKey = (image: Pick<LibraryImageRecord, "objectKey">) => `${image.objectKey}.library-thumb-256-v1.webp`;
export const designLibraryMediaCacheControl = "private, no-cache, must-revalidate";
export const designLibraryMediaVary = "Cookie, Authorization, X-Canvas-Owner-Id";
let activeThumbnailJobs = 0;
const mimeExtensions: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const operationKey = (actorId: string, entryId: string, action: DesignLibraryAction, imageId: string | null, operationId: string) => digest([actorId, entryId, action, imageId, operationId]);
const missing = () => new DesignLibraryError("NOT_FOUND", "分享不存在或无权访问", 404);
const emptyCounts = (): DesignLibraryCounts => ({ view: { count: 0, people: 0 }, download: { count: 0, people: 0 }, reuse: { count: 0, people: 0 }, prompt_copy: { count: 0, people: 0 } });

function requireActor(actor: DesignLibraryActor, employee = false) {
    const trusted = actor?.id && ((actor.kind === "employee" && actor.role === "designer") || (actor.kind === "admin" && ["super_admin", "department_admin"].includes(actor.role)));
    if (!trusted) throw new DesignLibraryError("OA_IDENTITY_REQUIRED", "请通过公司 OA 员工入口登录", 401);
    if (employee && actor.kind !== "employee") throw new DesignLibraryError("EMPLOYEE_REQUIRED", "此操作仅限 OA 设计师", 403);
}
export function canManageDesignLibrary(actor: DesignLibraryActor, publication: LibraryPublication) {
    return actor.kind === "admin" && (actor.role === "super_admin" || (actor.role === "department_admin" && Boolean(actor.departmentId) && actor.departmentId === publication.author.departmentId));
}
function entryDto(publication: LibraryPublication, actor: DesignLibraryActor): DesignLibraryEntry {
    const manages = canManageDesignLibrary(actor, publication);
    const owns = publication.author.id === actor.id;
    return {
        id: publication.id, title: publication.title, thought: publication.thought, prompt: publication.prompt, tags: publication.tags,
        author: publication.author, status: publication.status, createdAt: publication.createdAt, updatedAt: publication.updatedAt,
        images: publication.images.map(({ objectKey: _key, ...image }) => {
            const base = `/api/${actor.kind === "admin" ? "admin/" : ""}design-library/${publication.id}/images/${image.id}`;
            return { ...image, contentUrl: `${base}/content`, thumbnailUrl: `${base}/thumbnail` };
        }),
        canWithdraw: owns && publication.status === "published", canModerate: manages && publication.status !== "taken_down", canViewStats: owns || manages,
    };
}
function readable(publication: LibraryPublication | null, actor: DesignLibraryActor) {
    if (!publication || (publication.status !== "published" && publication.author.id !== actor.id && !canManageDesignLibrary(actor, publication))) throw missing();
    return publication;
}
function published(publication: LibraryPublication | null) {
    if (!publication) throw missing();
    if (publication.status !== "published") throw new DesignLibraryError("PUBLICATION_UNAVAILABLE", "这份分享已撤回或下架，不能继续下载或复用", 409);
    return publication;
}
function selectedImage(publication: LibraryPublication, imageId: string) {
    const image = publication.images.find(item => item.id === recordId.parse(imageId));
    if (!image) throw missing();
    return image;
}
function checkedSource(source: LibrarySourceAsset | null, actor: DesignLibraryActor) {
    if (!source || source.ownerId !== actor.id || source.deleted || source.status !== "ready" || source.kind !== "image") {
        throw new DesignLibraryError("SOURCE_ASSET_FORBIDDEN", "只能发布本人已保存且可用的图片", 403);
    }
    if (!Number.isSafeInteger(source.byteSize) || source.byteSize < 1 || source.byteSize > MAX_IMAGE_BYTES) {
        throw new DesignLibraryError("IMAGE_TOO_LARGE", "每张图片必须非空且不超过 20 MiB", 413);
    }
    return source;
}

/** Byte signatures and bounded container headers, never metadata/client-provided dimensions.
 * This is format validation, not re-encoding: snapshot and reuse retain every original byte.
 */
export function inspectDesignLibraryImage(value: Uint8Array, declaredMime: string) {
    const bytes = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw new DesignLibraryError("IMAGE_TOO_LARGE", "每张图片必须非空且不超过 20 MiB", 413);
    const mimeType = detectReferenceImage(bytes);
    const invalid = () => new DesignLibraryError("UNSUPPORTED_IMAGE", "图片内容必须为有效的 PNG、JPEG、WebP 或 GIF，不支持 SVG", 415);
    if (!mimeType || mimeType !== declaredMime.toLowerCase().split(";")[0]?.trim()) throw invalid();
    let width: number | null = null;
    let height: number | null = null;
    if (mimeType === "image/png") {
        if (bytes.length < 45 || bytes.readUInt32BE(8) !== 13 || bytes.toString("ascii", 12, 16) !== "IHDR") throw invalid();
        width = bytes.readUInt32BE(16); height = bytes.readUInt32BE(20);
        let offset = 8; let data = false; let ended = false;
        while (offset + 12 <= bytes.length) {
            const length = bytes.readUInt32BE(offset);
            if (length > bytes.length - offset - 12) throw invalid();
            const kind = bytes.toString("ascii", offset + 4, offset + 8);
            if (kind === "IDAT" && length > 0) data = true;
            offset += length + 12;
            if (kind === "IEND") { ended = length === 0 && offset === bytes.length; break; }
        }
        if (!data || !ended) throw invalid();
    } else if (mimeType === "image/gif") {
        if (bytes.length < 14 || bytes[bytes.length - 1] !== 0x3b) throw invalid();
        width = bytes.readUInt16LE(6); height = bytes.readUInt16LE(8);
    } else if (mimeType === "image/jpeg") {
        if (bytes.length < 20 || bytes[bytes.length - 2] !== 0xff || bytes[bytes.length - 1] !== 0xd9) throw invalid();
        let offset = 2; let scan = false;
        while (offset + 3 < bytes.length) {
            if (bytes[offset++] !== 0xff) throw invalid();
            while (bytes[offset] === 0xff) offset++;
            const marker = bytes[offset++]!;
            if (marker === 0xda) { scan = true; break; }
            if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) continue;
            const length = bytes.readUInt16BE(offset);
            if (length < 2 || offset + length > bytes.length) throw invalid();
            if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
                if (length < 8) throw invalid();
                height = bytes.readUInt16BE(offset + 3); width = bytes.readUInt16BE(offset + 5);
            }
            offset += length;
        }
        if (!scan) throw invalid();
    } else {
        if (bytes.length < 26 || bytes.readUInt32LE(4) + 8 !== bytes.length) throw invalid();
        let offset = 12;
        while (offset + 8 <= bytes.length) {
            const kind = bytes.toString("ascii", offset, offset + 4);
            const length = bytes.readUInt32LE(offset + 4);
            const start = offset + 8;
            if (length > bytes.length - start) throw invalid();
            if (kind === "VP8X" && length >= 10) {
                width = 1 + bytes.readUIntLE(start + 4, 3); height = 1 + bytes.readUIntLE(start + 7, 3);
            } else if (kind === "VP8 " && length >= 10 && bytes[start + 3] === 0x9d && bytes[start + 4] === 0x01 && bytes[start + 5] === 0x2a) {
                width ??= bytes.readUInt16LE(start + 6) & 0x3fff; height ??= bytes.readUInt16LE(start + 8) & 0x3fff;
            } else if (kind === "VP8L" && length >= 5 && bytes[start] === 0x2f) {
                const packed = bytes.readUInt32LE(start + 1);
                width ??= (packed & 0x3fff) + 1; height ??= ((packed >>> 14) & 0x3fff) + 1;
            }
            offset = start + length + (length & 1);
        }
        if (offset !== bytes.length) throw invalid();
    }
    if (!width || !height || width > 100000 || height > 100000) throw invalid();
    return { mimeType, width, height };
}

function safeFilename(filename: string, mimeType: string) {
    const clean = filename.split(/[\\/]/).at(-1)!.replace(/[\u0000-\u001f\u007f]/g, "").replace(/\.[^.]*$/, "").trim().slice(0, 110);
    return `${clean || "设计灵感"}.${mimeExtensions[mimeType]}`;
}

function unchangedSource(before: LibrarySourceAsset, after: LibrarySourceAsset) {
    if (before.id !== after.id || before.ownerId !== after.ownerId || before.objectKey !== after.objectKey
        || before.filename !== after.filename || before.mimeType !== after.mimeType || before.byteSize !== after.byteSize) {
        throw new DesignLibraryError("SOURCE_ASSET_CHANGED", "原图保存记录已改变，请重新发布", 409);
    }
}
function unchangedImage(before: LibraryImageRecord, after: LibraryImageRecord) {
    if (before.id !== after.id || before.objectKey !== after.objectKey || before.mimeType !== after.mimeType
        || before.byteSize !== after.byteSize || before.filename !== after.filename || before.width !== after.width || before.height !== after.height) {
        throw new DesignLibraryError("SNAPSHOT_UNAVAILABLE", "分享原图记录已改变，请重试", 409);
    }
}

export class DesignLibraryService {
    private readonly thumbnailJobs = new Map<string, Promise<unknown>>();
    constructor(private repository: DesignLibraryRepository, private media: DesignLibraryMediaStore,
        private options: { createThumbnail?: (bytes: Uint8Array) => Promise<Uint8Array> } = {}) {}

    private async createThumbnail(bytes: Uint8Array) {
        const thumbnail = this.options.createThumbnail ? await this.options.createThumbnail(bytes) : (await createAssetThumbnailBytes(bytes, [256]))[256];
        const inspected = inspectDesignLibraryImage(thumbnail, "image/webp");
        if (thumbnail.byteLength > MAX_THUMBNAIL_BYTES || inspected.width > 256 || inspected.height > 256) throw new Error("Invalid library thumbnail size");
        return thumbnail;
    }

    private thumbnailJob<T>(key: string, work: () => Promise<T>): Promise<T> {
        const existing = this.thumbnailJobs.get(key) as Promise<T> | undefined;
        if (existing) return existing;
        // No waiting queue: a busy preview falls back to the original at the client.
        if (activeThumbnailJobs >= 2) return Promise.reject(new DesignLibraryError("THUMBNAIL_UNAVAILABLE", "预览图处理中，请查看原图", 503));
        activeThumbnailJobs++;
        const promise = Promise.resolve().then(work).finally(() => { activeThumbnailJobs--; this.thumbnailJobs.delete(key); });
        this.thumbnailJobs.set(key, promise);
        return promise;
    }

    async list(actor: DesignLibraryActor, query: unknown): Promise<DesignLibraryList> {
        requireActor(actor);
        const input = designLibraryListSchema.parse(query);
        const filter: LibraryListFilter = { query: input.q, tag: input.tag, page: input.page, pageSize: input.pageSize };
        if (input.scope === "company") filter.statuses = ["published"];
        else if (input.scope === "mine") filter.authorId = actor.id;
        else {
            if (actor.kind !== "admin") throw new DesignLibraryError("FORBIDDEN", "不能查看他人的非公开分享", 403);
            if (actor.role === "department_admin") {
                if (!actor.departmentId) throw new DesignLibraryError("FORBIDDEN", "账号没有可管理的部门", 403);
                filter.departmentId = actor.departmentId;
            }
        }
        const result = await this.repository.listPublications(filter);
        return { items: result.items.map(item => entryDto(readable(item, actor), actor)), total: result.total, page: input.page, pageSize: input.pageSize };
    }

    async detail(actor: DesignLibraryActor, id: string): Promise<DesignLibraryEntry> {
        requireActor(actor);
        return entryDto(readable(await this.repository.getPublication(recordId.parse(id)), actor), actor);
    }

    async publish(actor: DesignLibraryActor, body: unknown): Promise<DesignLibraryEntry> {
        requireActor(actor, true);
        const input = designLibraryPublishSchema.parse(body);
        const payloadHash = digest(input);
        const copied: string[] = [];
        let commitMayHaveRun = false;
        const existingEntry = (publication: LibraryPublication) => {
            if (publication.payloadHash !== payloadHash) throw new DesignLibraryError("IDEMPOTENCY_CONFLICT", "同一发布请求不能更换内容，请重新发布", 409);
            return entryDto(publication, actor);
        };
        try {
            const previous = await this.repository.findPublication(actor.id, input.requestId);
            if (previous) return existingEntry(previous);
            const sources: LibrarySourceAsset[] = [];
            let total = 0;
            for (const id of input.assetIds) {
                const source = checkedSource(await this.repository.getSourceAsset(id, actor.id), actor);
                total += source.byteSize;
                if (total > MAX_PUBLICATION_BYTES) throw new DesignLibraryError("PUBLICATION_TOO_LARGE", "一次分享的图片总量不能超过 100 MiB", 413);
                sources.push(source);
            }
            const id = randomUUID();
            const images: LibraryImageRecord[] = [];
            const embeddedBytes: Uint8Array[] = [];
            const embeddedThumbnails = new Map<string, Uint8Array>();
            for (const source of sources) {
                let inspected: ReturnType<typeof inspectDesignLibraryImage> | undefined;
                let thumbnail: Uint8Array | undefined;
                const validate = async (bytes: Uint8Array) => {
                    if (bytes.byteLength !== source.byteSize) throw new DesignLibraryError("SOURCE_SIZE_MISMATCH", "原图内容与保存记录不一致，请重新保存后发布", 409);
                    inspected = inspectDesignLibraryImage(bytes, source.mimeType);
                    // A preview is optional. Encoder failure must not block a valid original.
                    thumbnail = await this.thumbnailJob(`publish:${objectKey}`, () => this.createThumbnail(bytes)).catch(() => undefined);
                };
                const imageId = randomUUID();
                const objectKey = `design-library/${id}/${imageId}.${mimeExtensions[source.mimeType.toLowerCase().split(";")[0]!.trim()] ?? "image"}`;
                if (this.media.copy) {
                    copied.push(objectKey);
                    await this.media.copy(source.objectKey, objectKey, { byteSize: source.byteSize, validate });
                } else {
                    const bytes = await this.media.read(source.objectKey, source.byteSize);
                    await validate(bytes);
                    embeddedBytes.push(bytes);
                }
                if (!inspected) throw new Error("Image copy did not validate its source");
                images.push({ id: imageId, filename: safeFilename(source.filename, inspected.mimeType), objectKey, byteSize: source.byteSize, ...inspected });
                if (thumbnail) {
                    const key = thumbnailKey({ objectKey });
                    if (this.media.copy) {
                        copied.push(key);
                        await this.media.write(key, thumbnail, "image/webp").catch(() => this.media.remove(key).catch(() => undefined));
                    } else embeddedThumbnails.set(key, thumbnail);
                }
            }
            const now = new Date().toISOString();
            const publication: LibraryPublication = {
                id, title: input.title, thought: input.thought, prompt: input.prompt, tags: input.tags,
                author: { id: actor.id, name: actor.name, departmentId: actor.departmentId, departmentName: actor.departmentName },
                images, status: "published", createdAt: now, updatedAt: now, requestId: input.requestId, payloadHash,
                moderationReason: null, moderatedBy: null,
            };
            const result = await this.repository.transaction(async repository => {
                await repository.lock(`publish:${actor.id}:${input.requestId}`);
                const existing = await repository.findPublication(actor.id, input.requestId);
                if (existing) return existingEntry(existing);
                for (const source of sources) {
                    unchangedSource(source, checkedSource(await repository.getSourceAsset(source.id, actor.id), actor));
                }
                for (const [index, bytes] of embeddedBytes.entries()) {
                    const image = images[index]!;
                    copied.push(image.objectKey);
                    await this.media.write(image.objectKey, bytes, image.mimeType);
                }
                for (const [key, bytes] of embeddedThumbnails) {
                    copied.push(key);
                    await this.media.write(key, bytes, "image/webp").catch(() => this.media.remove(key).catch(() => undefined));
                }
                await repository.insertPublication(publication);
                commitMayHaveRun = true;
                return entryDto(publication, actor);
            });
            if (result.id !== id) await this.removeCopies(copied);
            return result;
        } catch (error) {
            // A lost COMMIT acknowledgement must never delete an already-published snapshot.
            const committed = await this.repository.findPublication(actor.id, input.requestId).catch(() => null);
            if (committed) {
                await this.removeCopies(copied.filter(key => !committed.images.some(image => image.objectKey === key || thumbnailKey(image) === key)));
                if (committed.payloadHash === payloadHash) return entryDto(committed, actor);
            } else if (!commitMayHaveRun) await this.removeCopies(copied);
            throw error;
        }
    }

    private async removeCopies(keys: string[]) {
        await Promise.all(keys.map(key => this.media.remove(key).catch(() => undefined)));
    }

    async withdraw(actor: DesignLibraryActor, id: string): Promise<DesignLibraryEntry> {
        requireActor(actor, true);
        return this.repository.transaction(async repository => {
            const publication = await repository.getPublication(recordId.parse(id), true);
            if (!publication || publication.author.id !== actor.id) throw missing();
            if (publication.status === "taken_down") throw new DesignLibraryError("PUBLICATION_TAKEN_DOWN", "管理员已下架此分享，不能由作者更改状态", 409);
            if (publication.status === "published") {
                publication.status = "withdrawn"; publication.updatedAt = new Date().toISOString();
                await repository.setPublicationStatus(id, publication.status, publication.updatedAt, null, null);
            }
            return entryDto(publication, actor);
        });
    }

    async moderate(actor: DesignLibraryActor, id: string, body: unknown): Promise<DesignLibraryEntry> {
        requireActor(actor);
        const { reason } = designLibraryModerateSchema.parse(body);
        return this.repository.transaction(async repository => {
            const publication = await repository.getPublication(recordId.parse(id), true);
            if (!publication || !canManageDesignLibrary(actor, publication)) throw new DesignLibraryError("FORBIDDEN", "无权下架该员工的分享", 403);
            if (publication.status !== "taken_down") {
                publication.status = "taken_down"; publication.updatedAt = new Date().toISOString();
                publication.moderationReason = reason; publication.moderatedBy = actor.id;
                await repository.setPublicationStatus(id, publication.status, publication.updatedAt, reason, actor.id);
            }
            return entryDto(publication, actor);
        });
    }

    async image(actor: DesignLibraryActor, id: string, imageId: string) {
        requireActor(actor);
        const publication = readable(await this.repository.getPublication(recordId.parse(id)), actor);
        const image = selectedImage(publication, imageId);
        return { bytes: await this.media.read(image.objectKey, image.byteSize), image };
    }

    /** Every representation, including conditional hits, rechecks current visibility. */
    async imageResponse(actor: DesignLibraryActor, id: string, imageId: string,
        options: { thumbnail?: boolean; ifNoneMatch?: string; head?: boolean } = {}): Promise<DesignLibraryMediaResponse> {
        requireActor(actor);
        const current = () => this.repository.getPublication(recordId.parse(id)).then(value => selectedImage(readable(value, actor), imageId));
        const source = await current();
        let image = source;
        let stat: LibraryMediaStat | null = null;
        if (options.thumbnail) {
            const key = thumbnailKey(source);
            stat = await this.media.stat?.(key) ?? null;
            if (!stat) {
                try {
                    stat = await this.thumbnailJob(`read:${key}`, async () => {
                        const original = await this.media.read(source.objectKey, source.byteSize);
                        if (original.byteLength !== source.byteSize) throw new DesignLibraryError("SNAPSHOT_UNAVAILABLE", "分享原图内容与记录不一致", 503);
                        inspectDesignLibraryImage(original, source.mimeType);
                        const thumbnail = await this.createThumbnail(original);
                        if (this.media.copy) {
                            // Immutable snapshot + versioned derived key; parallel writers derive the same preview.
                            // No database lock is held across either encoder or object storage I/O.
                            await this.media.write(key, thumbnail, "image/webp");
                        } else {
                            await this.repository.transaction(async repository => {
                                const latest = selectedImage(readable(await repository.getPublication(id, true), actor), imageId);
                                unchangedImage(source, latest);
                                if (!await this.media.stat?.(key)) await this.media.write(key, thumbnail, "image/webp");
                            });
                        }
                        return await this.media.stat?.(key) ?? { byteSize: thumbnail.byteLength, mimeType: "image/webp", etag: `"${createHash("sha256").update(thumbnail).digest("hex")}"` };
                    });
                } catch (error) {
                    if (error instanceof DesignLibraryError && error.code === "NOT_FOUND") throw error;
                    throw new DesignLibraryError("THUMBNAIL_UNAVAILABLE", "预览图暂时不可用，请查看原图", 503);
                }
            }
            if (stat.mimeType?.split(";")[0]?.trim().toLowerCase() !== "image/webp" || !Number.isSafeInteger(stat.byteSize) || stat.byteSize < 1 || stat.byteSize > MAX_THUMBNAIL_BYTES) {
                throw new DesignLibraryError("THUMBNAIL_UNAVAILABLE", "预览图暂时不可用，请查看原图", 503);
            }
            image = { ...source, objectKey: key, filename: safeFilename(source.filename, "image/webp"), mimeType: "image/webp", byteSize: stat.byteSize, width: null, height: null };
        } else {
            stat = await this.media.stat?.(source.objectKey) ?? null;
            if (this.media.stat && !stat) throw new DesignLibraryError("SNAPSHOT_UNAVAILABLE", "分享原图暂时不可用", 503);
        }
        if (stat && stat.byteSize !== image.byteSize) throw new DesignLibraryError("SNAPSHOT_UNAVAILABLE", "分享原图内容与记录不一致", 503);
        // A withdrawal may have happened while HEAD or lazy thumbnail generation was in flight.
        unchangedImage(source, await current());
        const matches = (etag: string) => options.ifNoneMatch?.split(",").some(value => value.trim() === "*" || value.trim().replace(/^W\//, "") === etag.replace(/^W\//, ""));
        if (stat && matches(stat.etag)) return { status: 304, bytes: null, image, etag: stat.etag };
        if (stat && options.head) return { status: 200, bytes: null, image, etag: stat.etag };
        const bytes = await this.media.read(image.objectKey, image.byteSize, { ifMatch: stat?.etag });
        if (bytes.byteLength !== image.byteSize) throw new DesignLibraryError("SNAPSHOT_UNAVAILABLE", "图片内容与记录不一致", 503);
        if (options.thumbnail) inspectDesignLibraryImage(bytes, "image/webp");
        unchangedImage(source, await current());
        const etag = stat?.etag ?? `"${createHash("sha256").update(bytes).digest("hex")}"`;
        return { status: matches(etag) ? 304 : 200, bytes: matches(etag) || options.head ? null : bytes, image, etag };
    }

    async download(actor: DesignLibraryActor, id: string, imageId: string, body: unknown) {
        requireActor(actor, true);
        const input = designLibraryOperationSchema.parse(body);
        const key = operationKey(actor.id, recordId.parse(id), "download", recordId.parse(imageId), input.requestId);
        const snapshot = selectedImage(published(await this.repository.getPublication(id)), imageId);
        const bytes = await this.media.read(snapshot.objectKey, snapshot.byteSize);
        if (bytes.byteLength !== snapshot.byteSize) throw new DesignLibraryError("SNAPSHOT_UNAVAILABLE", "分享原图暂时不可用，未记录下载", 503);
        return this.repository.transaction(async repository => {
            const publication = published(await repository.getPublication(id, true));
            const image = selectedImage(publication, imageId);
            unchangedImage(snapshot, image);
            if (!await repository.getDelivery(key)) await repository.insertDelivery({ key, actorId: actor.id, entryId: id, imageId, action: "download", requestId: input.requestId, assetId: null, createdAt: new Date().toISOString() });
            return { bytes, image };
        });
    }

    async reuse(actor: DesignLibraryActor, id: string, imageId: string, body: unknown): Promise<DesignLibraryReuse> {
        requireActor(actor, true);
        const input = designLibraryOperationSchema.parse(body);
        const key = operationKey(actor.id, recordId.parse(id), "reuse", recordId.parse(imageId), input.requestId);
        const copied: string[] = [];
        const assetId = randomUUID();
        let commitMayHaveRun = false;
        try {
            const snapshot = selectedImage(published(await this.repository.getPublication(id)), imageId);
            const objectKey = `users/${actor.id}/${assetId}/library-image.${mimeExtensions[snapshot.mimeType]}`;
            let bytes: Uint8Array | undefined;
            if (!(await this.repository.getDelivery(key))?.assetId) {
                if (this.media.copy) {
                    copied.push(objectKey);
                    await this.media.copy(snapshot.objectKey, objectKey, { byteSize: snapshot.byteSize });
                } else {
                    bytes = await this.media.read(snapshot.objectKey, snapshot.byteSize);
                    if (bytes.byteLength !== snapshot.byteSize) throw new DesignLibraryError("SNAPSHOT_UNAVAILABLE", "分享原图暂时不可用，未创建复用素材", 503);
                }
            }
            const result = await this.repository.transaction(async repository => {
                await repository.lock(`reuse:${key}`);
                const publication = published(await repository.getPublication(id, true));
                const image = selectedImage(publication, imageId);
                unchangedImage(snapshot, image);
                const existing = await repository.getDelivery(key);
                if (existing?.assetId) {
                    checkedSource(await repository.getSourceAsset(existing.assetId, actor.id), actor);
                    commitMayHaveRun = true;
                    return this.reuseDto(publication, image, existing.assetId);
                }
                if (bytes) {
                    copied.push(objectKey);
                    await this.media.write(objectKey, bytes, image.mimeType);
                } else if (!copied.length) throw new DesignLibraryError("SNAPSHOT_UNAVAILABLE", "复用记录已改变，请重试", 409);
                const now = new Date().toISOString();
                const result = this.reuseDto(publication, image, assetId);
                await repository.insertPrivateAsset({
                    id: assetId, ownerId: actor.id, departmentId: actor.departmentId, objectKey,
                    filename: image.filename, mimeType: image.mimeType, byteSize: image.byteSize, kind: "image", status: "ready", deleted: false,
                    createdAt: now, metadata: { designLibrarySource: result.source, width: image.width, height: image.height },
                });
                await repository.insertDelivery({ key, actorId: actor.id, entryId: id, imageId, action: "reuse", requestId: input.requestId, assetId, createdAt: now });
                commitMayHaveRun = true;
                return result;
            });
            if (result.assetId !== assetId) await this.removeCopies(copied);
            return result;
        } catch (error) {
            if (!copied.length) throw error;
            const committed = await this.repository.getDelivery(key).catch(() => null);
            if (committed?.assetId && commitMayHaveRun) {
                if (committed.assetId !== assetId) await this.removeCopies(copied);
                const publication = await this.repository.getPublication(id);
                if (publication) return this.reuseDto(publication, selectedImage(publication, imageId), committed.assetId);
            }
            if (!commitMayHaveRun) await this.removeCopies(copied);
            throw error;
        }
    }

    private reuseDto(publication: LibraryPublication, image: LibraryImageRecord, assetId: string): DesignLibraryReuse {
        const { objectKey: _key, ...safe } = image;
        return { assetId, image: { ...safe, contentUrl: `/api/assets/${assetId}/content` },
            source: { entryId: publication.id, imageId: image.id, title: publication.title, authorName: publication.author.name } };
    }

    async receipt(actor: DesignLibraryActor, id: string, body: unknown): Promise<{ recorded: boolean }> {
        requireActor(actor, true);
        const input = designLibraryReceiptSchema.parse(body);
        recordId.parse(id);
        const imageId = input.imageId ?? null;
        if ((["download", "reuse"].includes(input.action) && !imageId) || (input.action === "prompt_copy" && imageId)
            || (input.action !== "reuse" && input.reusedAssetId) || (input.action === "reuse" && !input.reusedAssetId)) {
            throw new DesignLibraryError("INVALID_RECEIPT", "操作回执与图片不匹配", 400);
        }
        const key = operationKey(actor.id, id, input.action, imageId, input.requestId);
        return this.repository.transaction(async repository => {
            await repository.lock(`receipt:${key}`);
            if (await repository.hasReceipt(key)) return { recorded: false };
            const publication = await repository.getPublication(id, true);
            if (!publication) throw missing();
            if (imageId) selectedImage(publication, imageId);
            if (input.action === "download" || input.action === "reuse") {
                const delivery = await repository.getDelivery(key);
                if (!delivery || delivery.actorId !== actor.id || delivery.entryId !== id || delivery.imageId !== imageId || delivery.action !== input.action) {
                    throw new DesignLibraryError("DELIVERY_REQUIRED", "尚未成功取得这份图片，不能记录操作", 409);
                }
                if (input.action === "reuse") {
                    if (delivery.assetId !== input.reusedAssetId) throw new DesignLibraryError("REUSE_ASSET_MISMATCH", "复用素材与本次操作不匹配", 409);
                    checkedSource(await repository.getSourceAsset(input.reusedAssetId!, actor.id), actor);
                }
                // An already-issued delivery can finish its receipt after withdrawal.
            } else published(publication);
            if (input.action === "prompt_copy" && !publication.prompt) throw new DesignLibraryError("PROMPT_UNAVAILABLE", "这份分享没有可复制的提示词", 409);
            if (actor.id === publication.author.id) return { recorded: false };
            await repository.insertReceipt({ id: randomUUID(), key, entryId: id, imageId, action: input.action,
                actorId: actor.id, actorName: actor.name, departmentName: actor.departmentName, requestId: input.requestId, createdAt: new Date().toISOString() });
            return { recorded: true };
        });
    }

    async stats(actor: DesignLibraryActor, id: string, query: unknown): Promise<DesignLibraryStats> {
        requireActor(actor);
        const page = designLibraryPageSchema.parse(query);
        const publication = await this.repository.getPublication(recordId.parse(id));
        if (!publication || (publication.author.id !== actor.id && !canManageDesignLibrary(actor, publication))) {
            throw new DesignLibraryError("FORBIDDEN", "只有作者或有管理权限的管理员可以查看统计", 403);
        }
        const [metrics, activity] = await Promise.all([this.repository.getMetricRows(id), this.repository.listActivity(id, page.page, page.pageSize)]);
        const totals = emptyCounts();
        const images = publication.images.map(image => ({ imageId: image.id, filename: image.filename, counts: emptyCounts() }));
        for (const row of metrics) {
            const target = row.level === "entry" ? totals : images.find(image => image.imageId === row.imageId)?.counts;
            if (target && (row.level === "entry" || row.action !== "prompt_copy")) target[row.action] = { count: Number(row.count), people: Number(row.people) };
        }
        return { entryId: id, totals, images, activityTotal: activity.total, ...page,
            activity: activity.items.filter(item => item.action === "download" || item.action === "reuse").map(item => ({
                id: item.id, action: item.action as "download" | "reuse", imageId: item.imageId,
                filename: publication.images.find(image => image.id === item.imageId)?.filename ?? null,
                actor: { id: item.actorId, name: item.actorName, departmentName: item.departmentName }, createdAt: item.createdAt,
            })),
        };
    }
}
