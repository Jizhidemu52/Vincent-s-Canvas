import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { AppConfig } from "./config";

export class ObjectStorage {
    private client: S3Client;
    constructor(private config: AppConfig) {
        this.client = new S3Client({ endpoint: config.S3_ENDPOINT, region: config.S3_REGION, forcePathStyle: config.S3_FORCE_PATH_STYLE === "true", credentials: config.S3_ACCESS_KEY_ID && config.S3_SECRET_ACCESS_KEY ? { accessKeyId: config.S3_ACCESS_KEY_ID, secretAccessKey: config.S3_SECRET_ACCESS_KEY } : undefined });
    }
    get configured() { return Boolean(this.config.S3_ENDPOINT && this.config.S3_ACCESS_KEY_ID && this.config.S3_SECRET_ACCESS_KEY); }
    async put(key: string, body: Uint8Array, contentType: string) { if (!this.configured) throw new Error("公司对象存储尚未配置"); await this.client.send(new PutObjectCommand({ Bucket: this.config.S3_BUCKET, Key: key, Body: body, ContentType: contentType })); }
    async head(key: string) { return this.client.send(new HeadObjectCommand({ Bucket: this.config.S3_BUCKET, Key: key })); }
    async get(key: string) { return this.client.send(new GetObjectCommand({ Bucket: this.config.S3_BUCKET, Key: key })); }
    async signedDownloadUrl(key: string, expiresIn = 3600) {
        if (!this.configured) throw new Error("公司对象存储尚未配置");
        const url = await getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.config.S3_BUCKET, Key: key }), { expiresIn });
        if (!url.startsWith("https://")) throw new Error("视频参考图需要上游可访问的 HTTPS 对象存储地址");
        return url;
    }
}
