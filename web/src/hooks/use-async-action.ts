import { useState } from "react";
import { App } from "antd";
import { workbenchSubmissions } from "@/lib/submission-gate";
import { useUserStore } from "@/stores/use-user-store";

/** One in-flight mutation per user/resource, including clicks before the next render. */
export function useAsyncAction(scope: string) {
    const { message } = App.useApp();
    const ownerId = useUserStore((state) => state.user?.id || "anonymous");
    const [pending, setPending] = useState(false);
    const run = async (action: () => unknown | Promise<unknown>) => {
        const release = workbenchSubmissions.acquire(`${ownerId}:${scope}`);
        if (!release) return;
        setPending(true);
        try { await action(); }
        catch (error) {
            // Ant Design already shows validation failures beside the fields.
            if (!(error && typeof error === "object" && "errorFields" in error)) {
                message.error(error instanceof Error ? error.message : "操作失败，请重试");
            }
        } finally { release(); setPending(false); }
    };
    return { pending, run };
}
