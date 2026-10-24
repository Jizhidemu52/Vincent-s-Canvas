import { useState } from "react";

/** Thumbnail failures never change the original image used by detail/download/reuse. */
export function LibraryImage({ thumbnailUrl, contentUrl, alt, className }: {
    thumbnailUrl?: string | null; contentUrl: string; alt: string; className?: string;
}) {
    const [failedThumbnail, setFailedThumbnail] = useState("");
    const source = thumbnailUrl && thumbnailUrl !== failedThumbnail ? thumbnailUrl : contentUrl;
    return <img src={source} alt={alt} loading="lazy" decoding="async" className={className}
        onError={() => { if (source !== contentUrl) setFailedThumbnail(source); }} />;
}
