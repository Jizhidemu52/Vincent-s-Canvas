import { AbortMultipartUploadCommand, CopyObjectCommand, DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { Upload } from "@aws-sdk/lib-storage";
import { createReadStream } from "node:fs";
import type { AppConfig } from "./config";
import { isPublicHttpsUrl } from "./apimart-upload";

export interface ObjectReadOptions {
    range?: string;
    ifMatch?: string;
    abortSignal?: AbortSignal;
}

export class ObjectStorage {
    private client: S3Client;
    private publicClient: S3Client;
    constructor(private config: AppConfig) {
        this.client = new S3Client({ endpoint: config.S3_ENDPOINT, region: config.S3_REGION, forcePathStyle: config.S3_FORCE_PATH_STYLE === "true", credentials: config.S3_ACCESS_KEY_ID && config.S3_SECRET_ACCESS_KEY ? { accessKeyId: config.S3_ACCESS_KEY_ID, secretAccessKey: config.S3_SECRET_ACCESS_KEY } : undefined });
        this.publicClient = new S3Client({ endpoint: config.S3_PUBLIC_ENDPOINT || config.S3_ENDPOINT, region: config.S3_REGION, forcePathStyle: config.S3_FORCE_PATH_STYLE === "true", credentials: config.S3_ACCESS_KEY_ID && config.S3_SECRET_ACCESS_KEY ? { accessKeyId: config.S3_ACCESS_KEY_ID, secretAccessKey: config.S3_SECRET_ACCESS_KEY } : undefined });
    }
    get configured() { return Boolean(this.config.S3_ENDPOINT && this.config.S3_ACCESS_KEY_ID && this.config.S3_SECRET_ACCESS_KEY); }
    async put(key: string, body: Uint8Array, contentType: string, options: Pick<ObjectReadOptions, "abortSignal"> & { ifNoneMatch?: "*" } = {}) { if (!this.configured) throw new Error("公司对象存储尚未配置"); await this.client.send(new PutObjectCommand({ Bucket: this.config.S3_BUCKET, Key: key, Body: body, ContentType: contentType, IfNoneMatch: options.ifNoneMatch }), { abortSignal: options.abortSignal }); }
    /** Internal, same-bucket copy. The condition pins the bytes already inspected by the caller. */
    async copy(sourceKey: string, destinationKey: string, ifMatch: string) {
        if (!this.configured) throw new Error("公司对象存储尚未配置");
        if (!ifMatch) throw new Error("Object copy requires a source ETag");
        const copySource = [this.config.S3_BUCKET, ...sourceKey.split("/")].map(value => encodeURIComponent(value)).join("/");
        await this.client.send(new CopyObjectCommand({ Bucket: this.config.S3_BUCKET, Key: destinationKey, CopySource: copySource, CopySourceIfMatch: ifMatch, MetadataDirective: "COPY" }));
    }
    /** Bound upload memory independently of the generated video's total size. */
    async putFile(key: string, path: string, byteSize: number, contentType: string, options: Pick<ObjectReadOptions, "abortSignal"> = {}) {
        if (!this.configured) throw new Error("公司对象存储尚未配置");
        options.abortSignal?.throwIfAborted();
        const body = createReadStream(path);
        const cancel = () => { body.destroy(options.abortSignal?.reason instanceof Error ? options.abortSignal.reason : new Error("媒体上传已取消")); };
        options.abortSignal?.addEventListener("abort", cancel, { once: true });
        try {
            options.abortSignal?.throwIfAborted();
            // Upload.abort() only rejects its public promise; it does not pass
            // cancellation into S3 requests. Scope a send adapter to this upload
            // and let done() await worker failure + multipart rollback normally.
            const client = options.abortSignal ? new Proxy(this.client, { get: (target, property, receiver) => property === "send"
                ? (command: Parameters<S3Client["send"]>[0], requestOptions?: { abortSignal?: AbortSignal }) => target.send(command, { ...requestOptions,
                    abortSignal: command instanceof AbortMultipartUploadCommand ? AbortSignal.timeout(10_000) : options.abortSignal })
                : Reflect.get(target, property, receiver) }) : this.client;
            await new Upload({ client, params: { Bucket: this.config.S3_BUCKET, Key: key, Body: body, ContentType: contentType, ContentLength: byteSize }, queueSize: 2, partSize: 5 * 1024 * 1024, leavePartsOnError: false }).done();
            options.abortSignal?.throwIfAborted();
        } finally { options.abortSignal?.removeEventListener("abort", cancel); body.destroy(); }
    }
    async head(key: string, options: Pick<ObjectReadOptions, "abortSignal"> = {}) {
        return this.client.send(new HeadObjectCommand({ Bucket: this.config.S3_BUCKET, Key: key }), { abortSignal: options.abortSignal });
    }
    async get(key: string, options: ObjectReadOptions = {}) {
        return this.client.send(new GetObjectCommand({ Bucket: this.config.S3_BUCKET, Key: key, Range: options.range, IfMatch: options.ifMatch }), { abortSignal: options.abortSignal });
    }
    /** Used for owned rollback objects and precisely-scoped, recomputable previews. */
    async remove(key: string, options: Pick<ObjectReadOptions, "abortSignal"> = {}) { await this.client.send(new DeleteObjectCommand({ Bucket: this.config.S3_BUCKET, Key: key }), { abortSignal: options.abortSignal }); }
    async listKeys(prefix: string, options: Pick<ObjectReadOptions, "abortSignal"> & { continuationToken?: string; maxKeys?: number } = {}) {
        const result = await this.client.send(new ListObjectsV2Command({ Bucket: this.config.S3_BUCKET, Prefix: prefix, ContinuationToken: options.continuationToken, MaxKeys: Math.max(1, Math.min(100, options.maxKeys ?? 100)) }), { abortSignal: options.abortSignal });
        return { keys: (result.Contents || []).flatMap(object => object.Key ? [object.Key] : []), nextToken: result.IsTruncated ? result.NextContinuationToken : undefined };
    }
    async signedDownloadUrl(key: string, expiresIn = 3600) {
        if (!this.configured) throw new Error("公司对象存储尚未配置");
        if (!isPublicHttpsUrl(this.config.S3_PUBLIC_ENDPOINT || this.config.S3_ENDPOINT || "")) throw new Error("视频/音频素材需要配置上游可访问的 S3_PUBLIC_ENDPOINT（公开 HTTPS）；内部存储端口无需公开");
        const url = await getSignedUrl(this.publicClient, new GetObjectCommand({ Bucket: this.config.S3_BUCKET, Key: key }), { expiresIn });
        return url;
    }
}
