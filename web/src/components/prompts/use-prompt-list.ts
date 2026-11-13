import { useEffect, useMemo, useState } from "react";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";

import { ALL_PROMPTS_OPTION, fetchPrompts, type PromptLibraryScope } from "@/services/api/prompts";
import { deploymentFeatures } from "@/lib/deployment-features";
import { useUiLocale } from "@/lib/i18n";
import { createPromptActionGuard, promptActionIdentity } from "@/lib/prompt-template-reuse";
import { subscribeWorkspaceIdentity } from "@/lib/workspace-session-events";
import { useUserStore } from "@/stores/use-user-store";
import { generalPromptOptions } from "./prompt-library-data";

export const PROMPT_PAGE_SIZE = 20;

export function usePromptList({ keyword, tags, category, scope = "all", enabled = true }: { keyword: string; tags: string[]; category: string; scope?: PromptLibraryScope; enabled?: boolean }) {
    const locale = useUiLocale();
    const identity = useUserStore(promptActionIdentity);
    const user = useUserStore(state => state.user);
    const status = useUserStore(state => state.status);
    const client = useQueryClient();
    const [blockedIdentity, setBlockedIdentity] = useState<string | null>(null);
    const authorized = (!deploymentFeatures.authenticationEnabled || status === "authenticated") && blockedIdentity !== identity;
    useEffect(() => subscribeWorkspaceIdentity(owner => {
        if (owner === (user?.id || null)) return;
        setBlockedIdentity(identity);
        void client.cancelQueries({ queryKey: ["prompts", identity] });
        client.removeQueries({ queryKey: ["prompts", identity] });
    }), [client, identity, user?.id]);
    const query = useInfiniteQuery({
        queryKey: ["prompts", identity, scope, keyword, tags, category],
        queryFn: async ({ pageParam, signal }) => {
            const guard = createPromptActionGuard(identity, () => !signal.aborted);
            try {
                guard.assert();
                const result = await fetchPrompts({ keyword, tag: tags, category, scope: scope === "general" ? "all" : scope, page: pageParam, pageSize: PROMPT_PAGE_SIZE }, signal);
                guard.assert();
                return result;
            } finally { guard.dispose(); }
        },
        initialPageParam: 1,
        getNextPageParam: (lastPage, pages) => (pages.reduce((total, page) => total + page.items.length, 0) < lastPage.total ? pages.length + 1 : undefined),
        enabled: enabled && authorized && scope !== "general",
        staleTime: 0,
        gcTime: 0,
        refetchOnMount: "always",
    });
    const firstPage = query.data?.pages[0];
    const general = useMemo(() => scope === "all" || scope === "general" ? generalPromptOptions(keyword, tags, category) : [], [scope, keyword, tags, category, locale]);
    const remote = useMemo(() => authorized && !query.isError && scope !== "general" ? query.data?.pages.flatMap(page => page.items) || [] : [], [authorized, query.data?.pages, query.isError, scope]);
    const items = useMemo(() => [...general, ...remote], [general, remote]);
    return {
        query,
        identity,
        authorized,
        items,
        tags: useMemo(() => [ALL_PROMPTS_OPTION, ...new Set(items.flatMap(item => item.tags))], [items]),
        categories: useMemo(() => [ALL_PROMPTS_OPTION, ...new Set(items.map(item => item.category).filter(Boolean))], [items]),
        total: general.length + (authorized && scope !== "general" ? firstPage?.total || 0 : 0),
    };
}
