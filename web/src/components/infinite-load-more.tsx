import { Button } from "antd";
import { useCallback, useEffect, useRef, useState } from "react";

type InfiniteLoadMoreProps = {
    hasMore: boolean;
    loading: boolean;
    error?: unknown;
    disabled?: boolean;
    /** Changes when the account or filters change, not on ordinary refetches. */
    resetKey: string;
    pageKey?: string | null;
    label: string;
    endLabel?: string;
    onLoadMore: () => Promise<unknown>;
};

/** A failed page is retried only by a deliberate button click, never by re-observation. */
export function InfiniteLoadMore(props: InfiniteLoadMoreProps) {
    const sentinel = useRef<HTMLDivElement>(null);
    const mounted = useRef(false);
    const inFlight = useRef(false);
    const attempted = useRef<string | null>(null);
    const latest = useRef(props);
    latest.current = props;
    const [busy, setBusy] = useState(false);
    const [failure, setFailure] = useState("");

    useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
    useEffect(() => { attempted.current = null; setFailure(""); }, [props.resetKey]);
    const load = useCallback(async (manual: boolean) => {
        const current = latest.current;
        const key = JSON.stringify([current.resetKey, current.pageKey]);
        if (!mounted.current || !current.hasMore || current.disabled || current.loading || inFlight.current) return;
        if (!manual && (current.error || attempted.current === key)) return;
        inFlight.current = true;
        attempted.current = key;
        setBusy(true);
        if (manual) setFailure("");
        try {
            const result = await current.onLoadMore();
            // TanStack fetchNextPage resolves error results unless throwOnError is requested.
            if (result && typeof result === "object" && "error" in result && result.error) throw result.error;
        } catch (error) {
            if (mounted.current && latest.current.resetKey === current.resetKey) {
                setFailure(error instanceof Error ? error.message : "下一页加载失败");
            }
        } finally {
            inFlight.current = false;
            if (mounted.current) setBusy(false);
        }
    }, []);

    useEffect(() => {
        if (!props.hasMore || props.disabled || props.loading || props.error || busy || failure
            || typeof IntersectionObserver === "undefined" || !sentinel.current) return;
        const observer = new IntersectionObserver(entries => {
            if (entries.some(entry => entry.isIntersecting)) void load(false);
        }, { rootMargin: "160px 0px" });
        observer.observe(sentinel.current);
        return () => observer.disconnect();
    }, [props.hasMore, props.disabled, props.loading, props.error, props.resetKey, props.pageKey, busy, failure, load]);

    if (!props.hasMore) return props.endLabel ? <p className="text-center text-sm text-muted-foreground">{props.endLabel}</p> : null;
    const failed = Boolean(props.error || failure);
    return <div ref={sentinel} data-infinite-load-more={props.label} className="flex flex-col items-center gap-2 py-3">
        <Button loading={props.loading || busy} disabled={props.disabled || props.loading || busy} onClick={() => void load(true)}>
            {failed ? `重试${props.label}` : props.label}
        </Button>
        {failed ? <p role="alert" className="text-sm text-red-600">自动加载已暂停，请点击按钮重试。{failure}</p> : null}
    </div>;
}
