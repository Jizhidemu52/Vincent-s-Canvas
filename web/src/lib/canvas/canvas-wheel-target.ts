export const CANVAS_WHEEL_PASSTHROUGH_SELECTOR = "[data-canvas-no-zoom],.ant-modal,.ant-popover,.ant-dropdown,.ant-select-dropdown,.ant-picker-dropdown";

export function shouldCanvasCaptureWheel(target: Element | null) {
    return !target?.closest(CANVAS_WHEEL_PASSTHROUGH_SELECTOR);
}
