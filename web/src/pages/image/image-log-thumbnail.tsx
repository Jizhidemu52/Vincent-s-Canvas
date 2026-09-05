import { useEffect, useRef, useState } from "react";
import { resolveImageUrl } from "@/services/image-storage";

/** History thumbnails do not open original image blobs until they enter the scroller. */
export function ImageLogThumbnail({ image }: { image: { storageKey?: string; dataUrl: string } }) {
    const ref = useRef<HTMLSpanElement>(null);
    const [url, setUrl] = useState(image.storageKey ? "" : image.dataUrl);
    useEffect(() => {
        let active = true;
        setUrl(image.storageKey ? "" : image.dataUrl);
        const load = () => void resolveImageUrl(image.storageKey, image.dataUrl).then(value => { if (active) setUrl(value); }).catch(() => undefined);
        if (!image.storageKey) return;
        if (typeof IntersectionObserver === "undefined") { load(); return () => { active = false; }; }
        const observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) { observer.disconnect(); load(); } }, { rootMargin: "100px" });
        if (ref.current) observer.observe(ref.current);
        return () => { active = false; observer.disconnect(); };
    }, [image.storageKey, image.dataUrl]);
    return <span ref={ref} className="block size-9 shrink-0 overflow-hidden rounded-md bg-muted">{url ? <img src={url} alt="" loading="lazy" decoding="async" className="h-full w-full object-cover" /> : null}</span>;
}
