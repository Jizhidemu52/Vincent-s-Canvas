import { useState, type ImgHTMLAttributes } from "react";

/** Keep the reserved image box neutral until the browser has decoded the image. */
export function WorkbenchImage({ src, className = "", onLoad, ...props }: ImgHTMLAttributes<HTMLImageElement>) {
    const [loadedSource, setLoadedSource] = useState<string>();
    return <img {...props} src={src} className={`wb-preview-image ${className}`} data-loaded={Boolean(src && loadedSource === src)} onLoad={event => {
        setLoadedSource(src);
        onLoad?.(event);
    }} />;
}
