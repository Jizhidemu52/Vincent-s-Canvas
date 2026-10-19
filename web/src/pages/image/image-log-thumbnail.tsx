import { useEffect, useRef, useState } from "react";
import { useImagePreview, type PreviewImage } from "@/hooks/use-image-preview";

/** History thumbnails do not open original image blobs until they enter the scroller. */
export function ImageLogThumbnail({ image }: { image: PreviewImage }) {
    const ref = useRef<HTMLSpanElement>(null);
    const source = `${image.storageKey || ""}\n${image.dataUrl}`;
    const [visibleSource, setVisibleSource] = useState<string | null>(null);
    const url = useImagePreview(image, 256, !image.storageKey || visibleSource === source);
    useEffect(() => {
        if (!image.storageKey) return;
        if (typeof IntersectionObserver === "undefined") { setVisibleSource(source); return; }
        const observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) { observer.disconnect(); setVisibleSource(source); } }, { rootMargin: "100px" });
        if (ref.current) observer.observe(ref.current);
        return () => observer.disconnect();
    }, [image.storageKey, source]);
    return <span ref={ref} className="block size-9 shrink-0 overflow-hidden rounded-md bg-muted">{url ? <img src={url} alt="" loading="lazy" decoding="async" className="h-full w-full object-cover" /> : null}</span>;
}
