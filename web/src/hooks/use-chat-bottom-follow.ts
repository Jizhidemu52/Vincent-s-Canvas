import { useCallback, useLayoutEffect, useRef, useState } from "react";

/** Follow new content only while the reader stays near the bottom. */
export function useChatBottomFollow(content: unknown, scope: string | undefined) {
    const listRef = useRef<HTMLDivElement>(null);
    const following = useRef(true);
    const [hasNewMessages, setHasNewMessages] = useState(false);
    const scrollToBottom = useCallback(() => {
        const list = listRef.current;
        if (list) list.scrollTop = list.scrollHeight;
        following.current = true;
        setHasNewMessages(false);
    }, []);
    const onScroll = useCallback(() => {
        const list = listRef.current;
        if (!list) return;
        following.current = list.scrollHeight - list.scrollTop - list.clientHeight <= 80;
        if (following.current) setHasNewMessages(false);
    }, []);
    useLayoutEffect(() => { following.current = true; setHasNewMessages(false); }, [scope]);
    useLayoutEffect(() => {
        if (following.current) scrollToBottom();
        else setHasNewMessages(true);
    }, [content, scope, scrollToBottom]);
    useLayoutEffect(() => {
        const list = listRef.current;
        if (!list || typeof ResizeObserver === "undefined") return;
        const observer = new ResizeObserver(() => { if (following.current) scrollToBottom(); });
        for (const child of list.children) observer.observe(child);
        return () => observer.disconnect();
    }, [content, scrollToBottom]);
    return { listRef, onScroll, hasNewMessages, scrollToBottom };
}
