import { Router } from "express";
import { z } from "zod";

import { writeAudit } from "../audit";
import type { Database } from "../db";
import { makeCursorPage, parseCursorPage } from "../cursor-pagination";
import { requireRole } from "../rbac";
import type { AuthenticatedRequest, SessionUser } from "../types";

const select = `h.id,h.task_id AS "taskId",h.user_id AS "userId",u.display_name AS "userName",h.department_id AS "departmentId",d.name AS "departmentName",h.project_id AS "projectId",h.operation_type AS "operationType",h.model_config_id AS "modelConfigId",m.name AS "modelName",h.prompt,h.parameters,h.source_urls AS "sourceUrls",h.result_urls AS "resultUrls",h.credits,h.rmb_cost::float8 AS "rmbCost",h.status,h.failure_reason AS "failureReason",h.created_at AS "createdAt"`;
const joins = `FROM generation_history h JOIN users u ON u.id=h.user_id LEFT JOIN departments d ON d.id=h.department_id LEFT JOIN model_configs m ON m.id=h.model_config_id`;
const summarySelect = `h.id,h.task_id AS "taskId",h.user_id AS "userId",u.display_name AS "userName",h.department_id AS "departmentId",d.name AS "departmentName",h.project_id AS "projectId",h.operation_type AS "operationType",h.model_config_id AS "modelConfigId",m.name AS "modelName",left(h.prompt,240) AS prompt,h.credits,h.rmb_cost::float8 AS "rmbCost",h.status,h.failure_reason AS "failureReason",h.created_at AS "createdAt",to_char(h.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "cursorCreatedAt"`;
const exportLimit = 50_000;

const adminHistoryQuerySchema = z
  .object({
    userId: z.string().uuid().optional(),
    projectId: z.string().trim().min(1).max(200).optional(),
    modelId: z.string().uuid().optional(),
    operationType: z.string().trim().min(1).max(80).optional(),
    from: z.string().datetime({ offset: true }).optional(),
    to: z.string().datetime({ offset: true }).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(60),
    cursor: z.string().max(1200).optional(),
  })
  .refine(
    (value) =>
      !value.from || !value.to || new Date(value.from) <= new Date(value.to),
    {
      message: "开始时间不能晚于结束时间",
      path: ["from"],
    },
  );

export type AdminHistoryQuery = z.infer<typeof adminHistoryQuerySchema>;

export function createHistoryRouter(db: Database) {
  const router = Router();
  router.get("/", async (request, response, next) => {
    try {
      const actor = (request as unknown as AuthenticatedRequest).auth;
      const page = await readHistoryPage(db, request.query, { where: "WHERE h.user_id=$1", values: [actor.id] });
      response.json({ history: page.items, nextCursor: page.nextCursor, hasMore: page.hasMore });
    } catch (error) {
      next(error);
    }
  });
  router.get("/:id", async (request, response, next) => {
    try {
      const actor = (request as unknown as AuthenticatedRequest).auth;
      const id = z.string().uuid().parse(request.params.id);
      const result = await db.query(`SELECT ${select} ${joins} WHERE h.id=$1 AND h.user_id=$2`, [id, actor.id]);
      if (!result.rows[0]) { response.status(404).json({ error: "NOT_FOUND", message: "历史不存在或无权访问" }); return; }
      response.json({ history: result.rows[0] });
    } catch (error) { next(error); }
  });
  return router;
}

export function createAdminHistoryRouter(db: Database) {
  const router = Router();
  router.use(requireRole("super_admin", "department_admin"));

  router.get("/", async (request, response, next) => {
    try {
      const actor = (request as unknown as AuthenticatedRequest).auth;
      const query = parseAdminHistoryQuery(request.query);
      const filter = buildAdminHistoryFilter(actor, query);
      const summary = await db.query<{
        total: number;
        totalCredits: number;
        totalRmbCost: number;
      }>(
        `SELECT count(*)::int AS total,coalesce(sum(h.credits),0)::int AS "totalCredits",coalesce(sum(h.rmb_cost),0)::float8 AS "totalRmbCost" ${joins} ${filter.where}`,
        filter.values,
      );
      const total = summary.rows[0]?.total ?? 0;
      const page = await readHistoryPage(db, query, filter);
      response.json({
        history: page.items,
        nextCursor: page.nextCursor,
        hasMore: page.hasMore,
        total,
        totalCredits: summary.rows[0]?.totalCredits ?? 0,
        totalRmbCost: summary.rows[0]?.totalRmbCost ?? 0,
        limit: query.limit,
      });
    } catch (error) {
      next(error);
    }
  });

  router.get("/options", async (request, response, next) => {
    try {
      const actor = (request as unknown as AuthenticatedRequest).auth;
      const scope = buildAdminHistoryFilter(actor, parseAdminHistoryQuery({}));
      const modelWhere = scope.where
        ? `${scope.where} AND h.model_config_id IS NOT NULL`
        : "WHERE h.model_config_id IS NOT NULL";
      const [users, models, operations] = await Promise.all([
        db.query(
          `SELECT DISTINCT h.user_id AS value,u.display_name AS label ${joins} ${scope.where} ORDER BY label`,
          scope.values,
        ),
        db.query(
          `SELECT DISTINCT h.model_config_id AS value,m.name AS label ${joins} ${modelWhere} ORDER BY label`,
          scope.values,
        ),
        db.query(
          `SELECT DISTINCT h.operation_type AS value,h.operation_type AS label ${joins} ${scope.where} ORDER BY label`,
          scope.values,
        ),
      ]);
      response.json({
        users: users.rows,
        models: models.rows,
        operations: operations.rows,
      });
    } catch (error) {
      next(error);
    }
  });

  router.get("/export", async (request, response, next) => {
    try {
      const actor = (request as unknown as AuthenticatedRequest).auth;
      const query = parseAdminHistoryQuery(request.query);
      const filter = buildAdminHistoryFilter(actor, query);
      const count = await db.query<{ total: number }>(
        `SELECT count(*)::int AS total ${joins} ${filter.where}`,
        filter.values,
      );
      const total = count.rows[0]?.total ?? 0;
      if (total > exportLimit) {
        response.status(413).json({
          error: "EXPORT_TOO_LARGE",
          message: `当前筛选结果有 ${total} 条，请缩小时间范围后再导出（单次最多 ${exportLimit} 条）`,
        });
        return;
      }
      const result = await db.query(
        `SELECT ${select} ${joins} ${filter.where} ORDER BY h.created_at DESC`,
        filter.values,
      );
      const csv = historyCsv(result.rows);
      await writeAudit(db, {
        actor,
        action: "history.exported",
        targetType: "history",
        departmentId:
          actor.role === "department_admin" ? actor.departmentId : null,
        result: "success",
        detail: {
          filters: historyFilterDetail(query),
          rowCount: result.rows.length,
        },
        ip: request.ip,
      });
      response.setHeader(
        "content-disposition",
        `attachment; filename="wireless-canvas-history-${Date.now()}.csv"`,
      );
      response.setHeader("content-type", "text/csv; charset=utf-8");
      response.send(`\uFEFF${csv}`);
    } catch (error) {
      next(error);
    }
  });

  router.get("/:id", async (request, response, next) => {
    try {
      const actor = (request as unknown as AuthenticatedRequest).auth;
      const id = z.string().uuid().parse(request.params.id);
      const values: unknown[] = [id];
      const scope = actor.role === "department_admin" ? (values.push(actor.departmentId), "AND h.department_id=$2") : "";
      const result = await db.query(`SELECT ${select} ${joins} WHERE h.id=$1 ${scope}`, values);
      if (!result.rows[0]) { response.status(404).json({ error: "NOT_FOUND", message: "历史不存在或无权访问" }); return; }
      response.json({ history: result.rows[0] });
    } catch (error) { next(error); }
  });
  return router;
}

async function readHistoryPage(db: Database, query: unknown, filter: { where: string; values: unknown[] }) {
  const { cursor, limit } = parseCursorPage(query);
  const values = [...filter.values];
  let where = filter.where;
  if (cursor) {
    values.push(cursor.createdAt, z.string().uuid().parse(cursor.id));
    where += `${where ? " AND" : "WHERE"} (h.created_at,h.id)<($${values.length - 1}::timestamptz,$${values.length}::uuid)`;
  }
  values.push(limit + 1);
  const result = await db.query(`SELECT ${summarySelect} ${joins} ${where} ORDER BY h.created_at DESC,h.id DESC LIMIT $${values.length}`, values);
  const page = makeCursorPage(result.rows, limit, (row) => ({ createdAt: row.cursorCreatedAt as string, id: row.id as string }));
  return { ...page, items: page.items.map(({ cursorCreatedAt: _cursor, ...row }) => row) };
}

export function parseAdminHistoryQuery(value: unknown) {
  return adminHistoryQuerySchema.parse(value);
}

export function buildAdminHistoryFilter(
  actor: Pick<SessionUser, "role" | "departmentId">,
  query: AdminHistoryQuery,
) {
  const values: unknown[] = [];
  const clauses: string[] = [];
  const add = (column: string, value: unknown, suffix = "") => {
    values.push(value);
    clauses.push(`${column}=$${values.length}${suffix}`);
  };
  if (actor.role === "department_admin")
    add("h.department_id", actor.departmentId);
  if (query.userId) add("h.user_id", query.userId);
  if (query.projectId) add("h.project_id", query.projectId);
  if (query.modelId) add("h.model_config_id", query.modelId);
  if (query.operationType) add("h.operation_type", query.operationType);
  if (query.from) add("h.created_at>", query.from, "::timestamptz");
  if (query.to) add("h.created_at<", query.to, "::timestamptz");
  return {
    where: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "",
    values,
  };
}

function historyFilterDetail(query: AdminHistoryQuery) {
  const { limit: _limit, cursor: _cursor, ...filters } = query;
  return filters;
}

function historyCsv(rows: Array<Record<string, unknown>>) {
  const headers = [
    "时间",
    "设计师",
    "部门",
    "项目",
    "操作",
    "模型",
    "提示词",
    "积分",
    "人民币成本",
    "状态",
    "失败原因",
    "原图",
    "结果图",
  ];
  const body = rows.map((row) =>
    [
      row.createdAt,
      row.userName,
      row.departmentName,
      row.projectId,
      row.operationType,
      row.modelName,
      row.prompt,
      row.credits,
      row.rmbCost,
      row.status,
      row.failureReason,
      Array.isArray(row.sourceUrls) ? row.sourceUrls.join(" ") : "",
      Array.isArray(row.resultUrls) ? row.resultUrls.join(" ") : "",
    ]
      .map(csvCell)
      .join(","),
  );
  return [headers.map(csvCell).join(","), ...body].join("\r\n");
}

export function csvCell(value: unknown) {
  let text =
    value instanceof Date
      ? value.toISOString()
      : value === null || value === undefined
        ? ""
        : String(value);
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}
