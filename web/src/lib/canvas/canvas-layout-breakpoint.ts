export const CANVAS_DESKTOP_BREAKPOINT = 1024;
export const CANVAS_DESKTOP_MEDIA_QUERY = `(min-width: ${CANVAS_DESKTOP_BREAKPOINT}px)`;

export function isCanvasDesktopLayout(viewportWidth: number) {
    return viewportWidth >= CANVAS_DESKTOP_BREAKPOINT;
}
