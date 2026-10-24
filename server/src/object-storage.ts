import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
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
    async put(key: string, body: Uint8Array, contentType: string) { if (!this.configured) throw new Error("公司对象存储尚未配置"); await this.client.send(new PutObjectCommand({ Bucket: this.config.S3_BUCKET, Key: key, Body: body, ContentType: contentType })); }
    /** Bound upload memory independently of the generated video's total size. */
    async putFile(key: string, path: string, byteSize: number, contentType: string) {
        if (!this.configured) throw new Error("公司对象存储尚未配置");
        const body = createReadStream(path);
        try {
            await new Upload({ client: this.client, params: { Bucket: this.config.S3_BUCKET, Key: key, Body: body, ContentType: contentType, ContentLength: byteSize }, queueSize: 2, partSize: 5 * 1024 * 1024, leavePartsOnError: false }).done();
        } finally { body.destroy(); }
    }
    async head(key: string, options: Pick<ObjectReadOptions, "abortSignal"> = {}) {
        return this.client.send(new HeadObjectCommand({ Bucket: this.config.S3_BUCKET, Key: key }), { abortSignal: options.abortSignal });
    }
    async get(key: string, options: ObjectReadOptions = {}) {
        return this.client.send(new GetObjectCommand({ Bucket: this.config.S3_BUCKET, Key: key, Range: options.range, IfMatch: options.ifMatch }), { abortSignal: options.abortSignal });
    }
    /** Used only for newly-created snapshot objects when their database transaction failed. */
    async remove(key: string) { await this.client.send(new DeleteObjectCommand({ Bucket: this.config.S3_BUCKET, Key: key })); }
    async signedDownloadUrl(key: string, expiresIn = 3600) {
        if (!this.configured) throw new Error("公司对象存储尚未配置");
        if (!isPublicHttpsUrl(this.config.S3_PUBLIC_ENDPOINT || this.config.S3_ENDPOINT || "")) throw new Error("视频/音频素材需要配置上游可访问的 S3_PUBLIC_ENDPOINT（公开 HTTPS）；内部存储端口无需公开");
        const url = await getSignedUrl(this.publicClient, new GetObjectCommand({ Bucket: this.config.S3_BUCKET, Key: key }), { expiresIn });
        return url;
    }
}
