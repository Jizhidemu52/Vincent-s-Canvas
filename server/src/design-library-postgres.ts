import type { PoolClient } from "pg";
import type { Database } from "./db";
import type { ObjectStorage } from "./object-storage";
import { DesignLibraryError } from "./design-library";
import type {
    DesignLibraryMediaStore, DesignLibraryRepository, DesignLibraryStatus, LibraryDelivery, LibraryImageRecord,
    LibraryListFilter, LibraryMetricRow, LibraryPrivateAsset, LibraryPublication, LibraryReceipt, LibrarySourceAsset,
} from "./design-library";

type PublicationRow = {
    id: string; authorId: string; authorName: string; departmentId: string | null; departmentName: string | null;
    title: string; thought: string; prompt: string; tags: string[]; status: DesignLibraryStatus;
    requestId: string; payloadHash: string; moderationReason: string | null; moderatedBy: string | null; createdAt: string | Date; updatedAt: string | Date;
};
const publicationColumns = `id,author_id AS "authorId",author_name AS "authorName",department_id AS "departmentId",department_name AS "departmentName",
    title,thought,prompt,tags,status,request_id AS "requestId",payload_hash AS "payloadHash",moderation_reason AS "moderationReason",
    moderated_by AS "moderatedBy",created_at AS "createdAt",updated_at AS "updatedAt"`;
const imageColumns = `id,entry_id AS "entryId",object_key AS "objectKey",filename,mime_type AS "mimeType",byte_size AS "byteSize",width,height`;
const deliveryColumns = `operation_key AS key,actor_id AS "actorId",entry_id AS "entryId",image_id AS "imageId",action,request_id AS "requestId",asset_id AS "assetId",created_at AS "createdAt"`;
const receiptColumns = `id,receipt_key AS key,entry_id AS "entryId",image_id AS "imageId",action,actor_id AS "actorId",actor_name AS "actorName",department_name AS "departmentName",request_id AS "requestId",created_at AS "createdAt"`;
const iso = (value: string | Date) => value instanceof Date ? value.toISOString() : new Date(value).toISOString();

export class PostgresDesignLibraryRepository implements DesignLibraryRepository {
    constructor(private db: Database, private client?: PoolClient) {}
    private get connection() { return this.client ?? this.db; }

    async transaction<T>(work: (repository: DesignLibraryRepository) => Promise<T>): Promise<T> {
        if (this.client) return work(this);
        const client = await this.db.connect();
        try {
            await client.query("BEGIN");
            const result = await work(new PostgresDesignLibraryRepository(this.db, client));
            await client.query("COMMIT");
            return result;
        } catch (error) {
            await client.query("ROLLBACK").catch(() => undefined);
            throw error;
        } finally { client.release(); }
    }

    async lock(key: string) {
        if (!this.client) throw new Error("Design library lock requires a transaction");
        await this.client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [key]);
    }

    private async publications(rows: PublicationRow[]): Promise<LibraryPublication[]> {
        if (!rows.length) return [];
        const placeholders = rows.map((_row, index) => `$${index + 1}`).join(",");
        const images = await this.connection.query<LibraryImageRecord & { entryId: string }>(`SELECT ${imageColumns} FROM design_library_images WHERE entry_id IN (${placeholders}) ORDER BY position`, rows.map(row => row.id));
        return rows.map(row => ({
            id: row.id, title: row.title, thought: row.thought, prompt: row.prompt, tags: row.tags, status: row.status,
            author: { id: row.authorId, name: row.authorName, departmentId: row.departmentId, departmentName: row.departmentName },
            requestId: row.requestId, payloadHash: row.payloadHash, moderationReason: row.moderationReason, moderatedBy: row.moderatedBy,
            createdAt: iso(row.createdAt), updatedAt: iso(row.updatedAt),
            images: images.rows.filter(image => image.entryId === row.id).map(({ entryId: _id, ...image }) => ({ ...image, byteSize: Number(image.byteSize) })),
        }));
    }

    async findPublication(authorId: string, requestId: string) {
        const result = await this.connection.query<PublicationRow>(`SELECT ${publicationColumns} FROM design_library_publications WHERE author_id=$1 AND request_id=$2`, [authorId, requestId]);
        return (await this.publications(result.rows))[0] ?? null;
    }
    async getPublication(id: string, lock = false) {
        const result = await this.connection.query<PublicationRow>(`SELECT ${publicationColumns} FROM design_library_publications WHERE id=$1${lock ? " FOR UPDATE" : ""}`, [id]);
        return (await this.publications(result.rows))[0] ?? null;
    }
    async listPublications(filter: LibraryListFilter) {
        const values: unknown[] = [];
        const clauses: string[] = [];
        const parameter = (value: unknown) => { values.push(value); return `$${values.length}`; };
        if (filter.authorId) clauses.push(`author_id=${parameter(filter.authorId)}`);
        if (filter.departmentId) clauses.push(`department_id=${parameter(filter.departmentId)}`);
        if (filter.statuses?.length) clauses.push(`status IN (${filter.statuses.map(parameter).join(",")})`);
        if (filter.query) clauses.push(`lower(title || ' ' || thought || ' ' || prompt) LIKE ${parameter(`%${filter.query.toLowerCase().replace(/[\\%_]/g, value => `\\${value}`)}%`)} ESCAPE '\\'`);
        if (filter.tag) clauses.push(`tags ? ${parameter(filter.tag)}`);
        const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
        const total = await this.connection.query<{ total: number }>(`SELECT count(*)::int AS total FROM design_library_publications${where}`, values);
        const limit = parameter(filter.pageSize); const offset = parameter((filter.page - 1) * filter.pageSize);
        const result = await this.connection.query<PublicationRow>(`SELECT ${publicationColumns} FROM design_library_publications${where} ORDER BY created_at DESC,id DESC LIMIT ${limit} OFFSET ${offset}`, values);
        return { items: await this.publications(result.rows), total: Number(total.rows[0]?.total ?? 0) };
    }
    async insertPublication(publication: LibraryPublication) {
        await this.connection.query(`INSERT INTO design_library_publications(id,author_id,author_name,department_id,department_name,title,thought,prompt,tags,status,request_id,payload_hash,moderation_reason,moderated_by,created_at,updated_at)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,$14,$15,$16)`, [publication.id, publication.author.id, publication.author.name, publication.author.departmentId, publication.author.departmentName,
            publication.title, publication.thought, publication.prompt, JSON.stringify(publication.tags), publication.status, publication.requestId, publication.payloadHash, publication.moderationReason, publication.moderatedBy, publication.createdAt, publication.updatedAt]);
        for (const [position, image] of publication.images.entries()) {
            await this.connection.query(`INSERT INTO design_library_images(id,entry_id,position,object_key,filename,mime_type,byte_size,width,height) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
                [image.id, publication.id, position, image.objectKey, image.filename, image.mimeType, image.byteSize, image.width, image.height]);
        }
    }
    async setPublicationStatus(id: string, status: DesignLibraryStatus, updatedAt: string, reason: string | null, moderatorId: string | null) {
        await this.connection.query(`UPDATE design_library_publications SET status=$2,updated_at=$3,moderation_reason=$4,moderated_by=$5 WHERE id=$1`, [id, status, updatedAt, reason, moderatorId]);
        if (status === "taken_down" && moderatorId) await this.connection.query(`INSERT INTO audit_logs(actor_user_id,actor_role,action,target_type,target_id,department_id,result,detail)
            SELECT u.id,u.role,'design_library.taken_down','design_library_publication',$1,u.department_id,'success',$3::jsonb FROM users u WHERE u.id=$2`, [id, moderatorId, JSON.stringify({ reason })]);
    }
    async getSourceAsset(id: string, ownerId: string) {
        const result = await this.connection.query<LibrarySourceAsset>(`SELECT id,owner_user_id AS "ownerId",object_key AS "objectKey",filename,mime_type AS "mimeType",byte_size AS "byteSize",kind,status,(deleted_at IS NOT NULL) AS deleted
            FROM assets WHERE id=$1 AND owner_user_id=$2${this.client ? " FOR SHARE" : ""}`, [id, ownerId]);
        const row = result.rows[0];
        return row ? { ...row, byteSize: Number(row.byteSize), deleted: Boolean(row.deleted) } : null;
    }
    async insertPrivateAsset(asset: LibraryPrivateAsset) {
        await this.connection.query(`INSERT INTO assets(id,owner_user_id,department_id,object_key,filename,mime_type,byte_size,kind,source,status,visibility_scope,metadata,created_at,updated_at)
            VALUES($1,$2,$3,$4,$5,$6,$7,'image','import','ready','private',$8::jsonb,$9,$9)`,
            [asset.id, asset.ownerId, asset.departmentId, asset.objectKey, asset.filename, asset.mimeType, asset.byteSize, JSON.stringify(asset.metadata), asset.createdAt]);
    }
    async getDelivery(key: string) {
        const result = await this.connection.query<LibraryDelivery>(`SELECT ${deliveryColumns} FROM design_library_deliveries WHERE operation_key=$1`, [key]);
        return result.rows[0] ? { ...result.rows[0], createdAt: iso(result.rows[0].createdAt) } : null;
    }
    async insertDelivery(delivery: LibraryDelivery) {
        await this.connection.query(`INSERT INTO design_library_deliveries(operation_key,actor_id,entry_id,image_id,action,request_id,asset_id,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
            [delivery.key, delivery.actorId, delivery.entryId, delivery.imageId, delivery.action, delivery.requestId, delivery.assetId, delivery.createdAt]);
    }
    async hasReceipt(key: string) {
        return Boolean((await this.connection.query("SELECT 1 FROM design_library_receipts WHERE receipt_key=$1", [key])).rows[0]);
    }
    async insertReceipt(receipt: LibraryReceipt) {
        await this.connection.query(`INSERT INTO design_library_receipts(id,receipt_key,entry_id,image_id,action,actor_id,actor_name,department_name,request_id,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
            [receipt.id, receipt.key, receipt.entryId, receipt.imageId, receipt.action, receipt.actorId, receipt.actorName, receipt.departmentName, receipt.requestId, receipt.createdAt]);
    }
    async getMetricRows(entryId: string): Promise<LibraryMetricRow[]> {
        const result = await this.connection.query<LibraryMetricRow>(`SELECT 'entry' AS level,NULL::text AS "imageId",action,count(*)::int AS count,count(DISTINCT actor_id)::int AS people
            FROM design_library_receipts WHERE entry_id=$1 AND (action<>'view' OR image_id IS NULL) GROUP BY action
            UNION ALL
            SELECT 'image' AS level,image_id::text AS "imageId",action,count(*)::int AS count,count(DISTINCT actor_id)::int AS people
            FROM design_library_receipts WHERE entry_id=$1 AND image_id IS NOT NULL GROUP BY image_id,action`, [entryId]);
        return result.rows.map(row => ({ ...row, count: Number(row.count), people: Number(row.people) }));
    }
    async listActivity(entryId: string, page: number, pageSize: number) {
        const total = await this.connection.query<{ total: number }>("SELECT count(*)::int AS total FROM design_library_receipts WHERE entry_id=$1 AND action IN ('download','reuse')", [entryId]);
        const result = await this.connection.query<LibraryReceipt>(`SELECT ${receiptColumns} FROM design_library_receipts WHERE entry_id=$1 AND action IN ('download','reuse') ORDER BY created_at DESC,id DESC LIMIT $2 OFFSET $3`, [entryId, pageSize, (page - 1) * pageSize]);
        return { items: result.rows.map(row => ({ ...row, createdAt: iso(row.createdAt) })), total: Number(total.rows[0]?.total ?? 0) };
    }
}

export function designLibraryObjectStorage(storage: ObjectStorage): DesignLibraryMediaStore {
    return {
        read: async key => {
            if (!storage.configured) throw new DesignLibraryError("STORAGE_NOT_CONFIGURED", "公司对象存储尚未配置，无法读取分享图片", 503);
            const object = await storage.get(key);
            const bytes = await object.Body?.transformToByteArray();
            if (!bytes) throw new Error("Image object is empty");
            return bytes;
        },
        write: async (key, bytes, mimeType) => {
            if (!storage.configured) throw new DesignLibraryError("STORAGE_NOT_CONFIGURED", "公司对象存储尚未配置，无法保存分享图片", 503);
            await storage.put(key, bytes, mimeType);
        },
        remove: key => storage.remove(key),
    };
}
