import { z } from "zod";
import { getToolDefinition, toolDefinitions } from "../../shared/feature-catalog";
import { isQuickImageAction, quickImageTaskTarget } from "../../shared/quick-image-tools";

const historyOperations = new Set(["image_generation", "inpaint", "upscale", "seamless_stitch", "video_generation"]);
export const taskHistoryBoards = [
  ...toolDefinitions.filter(tool => tool.parent !== "canvas" && tool.parent !== "gpt-chat" && tool.operations.every(operation => historyOperations.has(operation)))
    .map(tool => tool.toolKey === "image" ? "image-generation" : tool.toolKey),
  "remove-background", "item-extract", "hd-upscale",
];
const boardSchema = z.string().refine(board => taskHistoryBoards.includes(board), "未知的历史记录板块");

/** Only persisted origin evidence identifies an old board; operation alone is ambiguous. */
export function taskHistoryScope(query: unknown, values: unknown[]) {
  const { board } = z.object({ board: boardSchema }).parse(query);
  const quickAction = isQuickImageAction(board) ? board : null;
  const toolKey = quickAction ? quickImageTaskTarget(quickAction).toolKey : board === "image-generation" ? "image" : board;
  const operations = quickAction ? [quickImageTaskTarget(quickAction).operationType] : [...getToolDefinition(toolKey)!.operations];
  values.push(toolKey === "image" ? ["image", "image-generation"] : [toolKey], operations);
  const clauses = [
    `COALESCE(t.tool_key,CASE WHEN jsonb_typeof(t.parameters->'tool')='string' THEN t.parameters->>'tool' END)=ANY($${values.length - 1}::text[])`,
    `t.operation_type=ANY($${values.length}::text[])`,
  ];
  if (quickAction) {
    values.push(quickAction);
    clauses.push(`t.parameters->>'quickImageAction'=$${values.length}`);
    // The same canonical target is also used by the explicit administrator test route.
    clauses.push("t.project_id<>'admin-quick-image-test' AND COALESCE(t.parameters->'quickImage'->>'adminTest','false')<>'true'");
  } else clauses.push("t.parameters->>'quickImageAction' IS NULL");
  return clauses;
}

// Historical client archives may predate server-owned credentials. Keep restore
// data, never API keys/headers/passwords from those snapshots. Provider rows are
// not queried by this endpoint at all.
const privateKey = /api[_-]?key|secret|password|credentials?|authorization|access[_-]?token|refresh[_-]?token|auth[_-]?token|bearer|private[_-]?key|headers|cookie|^token$|^base[_-]?url$/i;
export function safeTaskHistoryValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(safeTaskHistoryValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !privateKey.test(key)).map(([key, item]) => [key, safeTaskHistoryValue(item)]));
}
