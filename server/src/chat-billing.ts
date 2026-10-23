import { BillingError, loadTaskPriceSnapshot, reserveCredits, settleReservation } from "./billing";
import type { Database } from "./db";
import { withTransaction } from "./db-transaction";
import type { ToolConfiguration } from "./tool-configuration";

/** One reservation per model request, not per conversation or client-side tool. */
export async function beginChatBilling(db: Database, input: {
    requestId?: string;
    userId: string;
    anonymous?: boolean;
    enabled: boolean;
    execution: ToolConfiguration & { modelConfigId: string };
}) {
    if (!input.enabled) return null;
    if (input.anonymous) throw new BillingError("LOGIN_REQUIRED", "积分已开启，请登录个人账号后重试");
    const snapshot = await loadTaskPriceSnapshot(db, {
        operationType: "chat", modelConfigId: input.execution.modelConfigId,
        toolConfiguration: input.execution, quantity: 1, creditsEnabled: true,
    });
    if (snapshot.totalCredits === 0) return null;
    if (!input.requestId) throw new BillingError("CHAT_REQUEST_ID_REQUIRED", "计费对话需要请求编号，请刷新后重试");
    // Namespace IDs by actor and operation: another account/task can never supply
    // an existing reservation to run a new provider request without paying.
    const reservationId = `chat:${input.userId}:${input.requestId}`;
    await withTransaction(db, async (client) => {
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [reservationId]);
        const previous = await client.query("SELECT status FROM credit_reservations WHERE request_id=$1", [reservationId]);
        if (previous.rows.length) throw new BillingError("CHAT_REQUEST_ALREADY_SUBMITTED", "此请求已提交，不会重复调用或扣分；如需再次对话，请重新发送");
        await reserveCredits(db, {
            requestId: reservationId, userId: input.userId, operationType: "chat",
            modelConfigId: input.execution.modelConfigId, toolConfiguration: input.execution,
            quantity: 1, priceSnapshot: snapshot, creditsEnabled: true,
        }, client);
    });
    return reservationId;
}

export async function finishChatBilling(db: Database, reservationId: string | null, success: boolean) {
    if (reservationId) await settleReservation(db, reservationId, success ? "capture" : "release");
}

/** Validate Anthropic SSE completion across arbitrary byte/chunk boundaries. */
export class ChatStreamOutcome {
    private decoder = new TextDecoder();
    private pending = "";
    private stopped = false;
    private failed = false;
    private rejected = false;
    private output = false;
    private terminalPending = false;
    private ended = false;

    push(chunk: Uint8Array) {
        this.pending += this.decoder.decode(chunk, { stream: true });
        let newline: number;
        while ((newline = this.pending.indexOf("\n")) >= 0) {
            const line = this.pending.slice(0, newline).trimEnd();
            this.pending = this.pending.slice(newline + 1);
            // A data line is not a complete SSE event: its final blank line
            // may arrive in a later chunk, including split CRLF bytes.
            if (!line) {
                this.ended ||= this.terminalPending;
                this.terminalPending = false;
                continue;
            }
            if (!line.startsWith("data:")) continue;
            try {
                const event = JSON.parse(line.slice(5).trim());
                if (event.type === "message_stop") { this.stopped = true; this.terminalPending = true; }
                if (event.type === "error") { this.failed = true; this.rejected = true; this.terminalPending = true; }
                if (event.type === "content_block_start" && event.content_block?.type === "tool_use") this.output = true;
                if (event.type === "content_block_start" && event.content_block?.type === "text" && event.content_block.text?.trim()) this.output = true;
                if (event.type === "content_block_delta" && event.delta?.type === "text_delta" && event.delta.text?.trim()) this.output = true;
            } catch { this.failed = true; }
        }
        // A corrupt upstream must not buffer an unbounded line in our process.
        if (this.pending.length > 1_000_000) throw new BillingError("CHAT_STREAM_INVALID", "对话流格式无效");
    }

    get terminal() { return this.ended; }
    // A disconnected client or a missing terminal event does not erase useful
    // output already returned by the provider (including a client-side tool plan).
    get hasOutput() { return this.output; }
    get confirmedEmpty() { return this.ended && !this.output && (this.rejected || (this.stopped && !this.failed)); }
    get successful() { return this.ended && this.stopped && this.output && !this.failed; }
}
