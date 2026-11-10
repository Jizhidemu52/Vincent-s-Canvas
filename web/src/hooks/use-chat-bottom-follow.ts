import { useCallback, useLayoutEffect, useRef, useState } from "react";

/** Follow new content only while the reader stays near the bottom. */
export function useChatBottomFollow(content: unknown, scope: string | undefined) {
    const listRef = useRef<HTMLDivElement>(null);
    const contentRef = useRef<HTMLDivElement>(null);
    const following = useRef(true);
    const frame = useRef<number | null>(null);
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
    const scheduleFollow = useCallback(() => {
        if (frame.current !== null) return;
        frame.current = requestAnimationFrame(() => {
            frame.current = null;
            if (following.current) scrollToBottom();
        });
    }, [scrollToBottom]);
    useLayoutEffect(() => { following.current = true; setHasNewMessages(false); }, [scope]);
    useLayoutEffect(() => {
        if (following.current) scheduleFollow();
        else setHasNewMessages(true);
    }, [content, scope, scheduleFollow]);
    useLayoutEffect(() => {
        const list = listRef.current;
        if (!list || typeof ResizeObserver === "undefined") return;
        // One stable content wrapper covers streamed text and late image loads.
        // Do not recreate an observer for every streamed token or history row.
        const observer = new ResizeObserver(() => { if (following.current) scheduleFollow(); });
        observer.observe(list);
        if (contentRef.current) observer.observe(contentRef.current);
        return () => observer.disconnect();
    }, [scope, scheduleFollow]);
    useLayoutEffect(() => () => {
        if (frame.current !== null) cancelAnimationFrame(frame.current);
        frame.current = null;
    }, []);
    return { listRef, contentRef, onScroll, hasNewMessages, scrollToBottom };
}
