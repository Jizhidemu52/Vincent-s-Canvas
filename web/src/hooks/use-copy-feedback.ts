import { useEffect, useRef, useState } from "react";
import { useCopyText } from "./use-copy-text";

/** Keep successful clipboard feedback beside the action, without a global toast. */
export function useCopyFeedback() {
    const copyText = useCopyText({ notifySuccess: false });
    const [copied, setCopied] = useState(false);
    const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    const mounted = useRef(true);
    useEffect(() => {
        mounted.current = true;
        return () => { mounted.current = false; clearTimeout(timer.current); };
    }, []);
    return {
        copied,
        async copy(value: string) {
            const success = await copyText(value);
            if (!mounted.current) return success;
            clearTimeout(timer.current);
            setCopied(success);
            if (success) timer.current = setTimeout(() => setCopied(false), 1200);
            return success;
        },
    };
}
