import { Router, type ErrorRequestHandler } from "express";
import { z } from "zod";
import type { AdminReleaseNote, PublicReleaseNote } from "../../../shared/release-notes";
import { writeAudit } from "../audit";
import type { Database } from "../db";
import { withTransaction } from "../db-transaction";
import { requireRole } from "../rbac";
import type { AuthenticatedRequest } from "../types";

const versionSchema = z.string().regex(/^v[0-9]+\.[0-9]+\.[0-9]+$/);
const revisionSchema = z.number().int().positive().max(2147483647);
const text = (max: number) => z.string().trim().max(max).refine(value => !value.includes("\0"), "内容不得包含空字符");
const draftSchema = z.object({ title: text(80), content: text(4000), expectedRevision: revisionSchema.nullable() }).strict();
const publishSchema = z.object({ expectedRevision: revisionSchema }).strict();
const pageSchema = (defaultLimit: number) => z.object({
  limit: z.coerce.number().int().min(1).max(100).default(defaultLimit),
  offset: z.coerce.number().int().min(0).max(2147483646).default(0),
});
const adminColumns = `version,title,content,revision,created_at AS "createdAt",updated_at AS "updatedAt",published_at AS "publishedAt"`;
type NoteRow = Omit<AdminReleaseNote, "createdAt" | "updatedAt" | "publishedAt"> & {
  createdAt: Date | string; updatedAt: Date | string; publishedAt: Date | string | null;
};
const timestamp = (value: Date | string) => new Date(value).toISOString();
const adminNote = (row: NoteRow): AdminReleaseNote => ({
  version: row.version, title: row.title, content: row.content, revision: row.revision,
  createdAt: timestamp(row.createdAt), updatedAt: timestamp(row.updatedAt),
  publishedAt: row.publishedAt === null ? null : timestamp(row.publishedAt),
});

class ReleaseNoteError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
const conflict = () => new ReleaseNoteError(409, "RELEASE_NOTE_CONFLICT", "更新日志已被修改，请刷新后重新编辑");
const releaseNoteErrors: ErrorRequestHandler = (error, _request, response, next) => {
  if (!(error instanceof ReleaseNoteError)) { next(error); return; }
  response.status(error.status).json({ error: error.code, message: error.message });
};

export function createReleaseNotesRouter(db: Database) {
  const router = Router();
  router.get("/", async (request, response, next) => {
    try {
      const { limit, offset } = pageSchema(20).parse(request.query);
      // Select the public contract explicitly: drafts and authoring metadata never cross this boundary.
      const result = await db.query<Omit<PublicReleaseNote, "publishedAt"> & { publishedAt: Date | string }>(
        `SELECT version,title,content,published_at AS "publishedAt" FROM release_notes
         WHERE published_at IS NOT NULL ORDER BY published_at DESC,version DESC LIMIT $1 OFFSET $2`, [limit + 1, offset],
      );
      const notes: PublicReleaseNote[] = result.rows.slice(0, limit).map(row => ({
        version: row.version, title: row.title, content: row.content, publishedAt: timestamp(row.publishedAt),
      }));
      response.set("Cache-Control", "no-store").json({ notes, hasMore: result.rows.length > limit });
    } catch (error) { next(error); }
  });
  return router;
}

export function createAdminReleaseNotesRouter(db: Database) {
  const router = Router();
  router.use(requireRole("super_admin"));
  router.use((_request, response, next) => { response.set("Cache-Control", "no-store"); next(); });
  router.get("/", async (request, response, next) => {
    try {
      const { limit, offset } = pageSchema(50).parse(request.query);
      const result = await db.query<NoteRow>(
        `SELECT ${adminColumns} FROM release_notes ORDER BY updated_at DESC,version DESC LIMIT $1 OFFSET $2`, [limit + 1, offset],
      );
      response.json({ notes: result.rows.slice(0, limit).map(adminNote), hasMore: result.rows.length > limit });
    } catch (error) { next(error); }
  });
  router.put("/:version/draft", async (request, response, next) => {
    try {
      const version = versionSchema.parse(request.params.version);
      const input = draftSchema.parse(request.body);
      const actor = (request as unknown as AuthenticatedRequest).auth;
      const note = await withTransaction(db, async client => {
        let result;
        if (input.expectedRevision === null) {
          result = await client.query<NoteRow>(
            `INSERT INTO release_notes(version,title,content) VALUES($1,$2,$3)
             ON CONFLICT(version) DO NOTHING RETURNING ${adminColumns}`, [version, input.title, input.content],
          );
          if (!result.rows[0]) throw conflict();
        } else {
          const existing = await client.query<NoteRow>(`SELECT ${adminColumns} FROM release_notes WHERE version=$1 FOR UPDATE`, [version]);
          const current = existing.rows[0];
          if (!current || current.revision !== input.expectedRevision) throw conflict();
          if (current.publishedAt !== null) throw new ReleaseNoteError(409, "RELEASE_NOTE_PUBLISHED", "已发布的更新日志不可修改");
          result = await client.query<NoteRow>(
            `UPDATE release_notes SET title=$2,content=$3,revision=revision+1,updated_at=now()
             WHERE version=$1 RETURNING ${adminColumns}`, [version, input.title, input.content],
          );
        }
        const saved = adminNote(result.rows[0]!);
        await writeAudit(client, { actor, action: "release_note.draft_saved", targetType: "release_note", targetId: version,
          result: "success", detail: { revision: saved.revision }, ip: request.ip });
        return saved;
      });
      response.json({ note });
    } catch (error) { next(error); }
  });
  router.post("/:version/publish", async (request, response, next) => {
    try {
      const version = versionSchema.parse(request.params.version);
      const input = publishSchema.parse(request.body);
      const actor = (request as unknown as AuthenticatedRequest).auth;
      const note = await withTransaction(db, async client => {
        const existing = await client.query<NoteRow>(`SELECT ${adminColumns} FROM release_notes WHERE version=$1 FOR UPDATE`, [version]);
        const current = existing.rows[0];
        if (!current) throw new ReleaseNoteError(404, "RELEASE_NOTE_NOT_FOUND", "请先保存更新日志草稿");
        if (current.revision !== input.expectedRevision) throw conflict();
        // Keep the published revision stable so a lost HTTP response is safe to retry.
        if (current.publishedAt !== null) return adminNote(current);
        if (!current.title.trim() || !current.content.trim()) throw new ReleaseNoteError(400, "RELEASE_NOTE_EMPTY", "请填写更新标题和内容后再发布");
        const result = await client.query<NoteRow>(
          `UPDATE release_notes SET published_at=now(),updated_at=now() WHERE version=$1 RETURNING ${adminColumns}`, [version],
        );
        await writeAudit(client, { actor, action: "release_note.published", targetType: "release_note", targetId: version,
          result: "success", detail: { revision: current.revision }, ip: request.ip });
        return adminNote(result.rows[0]!);
      });
      response.json({ note });
    } catch (error) { next(error); }
  });
  router.use(releaseNoteErrors);
  return router;
}
