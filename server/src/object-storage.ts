import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
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
}
