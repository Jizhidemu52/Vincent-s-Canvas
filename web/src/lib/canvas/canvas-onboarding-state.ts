export type CanvasOnboardingOutcome = "completed" | "skipped" | "later";
export type CanvasOnboardingPreference = { version: 1; outcome: CanvasOnboardingOutcome; step: number };
type PreferenceStorage = { getItem<T>(key: string): Promise<T | null>; setItem<T>(key: string, value: T): Promise<T> };

/** The caller supplies the existing employee-scoped workspace storage. */
export function createCanvasOnboardingPreference(storage: PreferenceStorage) {
    const key = "canvas:onboarding:v1";
    return {
        async read(): Promise<CanvasOnboardingPreference | null> {
            const value = await storage.getItem<CanvasOnboardingPreference>(key);
            return value?.version === 1 && ["completed", "skipped", "later"].includes(value.outcome) && Number.isInteger(value.step) && value.step >= 0 && value.step < 4 ? value : null;
        },
        async save(outcome: CanvasOnboardingOutcome, step: number) {
            return storage.setItem<CanvasOnboardingPreference>(key, { version: 1, outcome, step: Math.max(0, Math.min(3, step)) });
        },
    };
}

/** Starting real work interrupts an automatic invitation, not a requested tour. */
export function canvasOnboardingShouldYield(state: { open: boolean; empty: boolean; manuallyOpened: boolean }) {
    return state.open && !state.empty && !state.manuallyOpened;
}

type Rect = { left: number; top: number; width: number; height: number };
type Size = { width: number; height: number };

/** Largest unobstructed horizontal region, in the canvas container's coordinates. */
export function canvasOnboardingAvailableArea(container: Rect, panels: Rect[]) {
    let regions = [{ left: 0, right: container.width }];
    for (const panel of panels) {
        if (panel.top + panel.height <= container.top || panel.top >= container.top + container.height) continue;
        const left = Math.max(0, panel.left - container.left - 16);
        const right = Math.min(container.width, panel.left + panel.width - container.left + 16);
        if (right <= left) continue;
        regions = regions.flatMap(region => {
            if (right <= region.left || left >= region.right) return [region];
            return [
                ...(left > region.left ? [{ left: region.left, right: left }] : []),
                ...(right < region.right ? [{ left: right, right: region.right }] : []),
            ];
        });
    }
    const largest = regions.sort((a, b) => (b.right - b.left) - (a.right - a.left) || b.left - a.left)[0];
    return largest ? { left: largest.left, width: largest.right - largest.left } : { left: 0, width: 0 };
}

/** Vertical limits reserve the complete top bar and dock, not just the target. */
export function canvasOnboardingCardPosition(target: Rect | null, viewport: Size, card: Size, usable?: { top: number; bottom: number }) {
    const clamp = (value: number, available: number, size: number) => Math.max(12, Math.min(value, available - size - 12));
    const minTop = Math.max(12, usable?.top ?? 12);
    const maxBottom = Math.min(viewport.height - 12, usable?.bottom ?? viewport.height - 12);
    const height = Math.min(card.height, Math.max(0, maxBottom - minTop));
    let left = (viewport.width - card.width) / 2;
    let top = (viewport.height - card.height) / 2;
    if (target) {
        const right = target.left + target.width + 16;
        left = right + card.width <= viewport.width - 12 ? right : target.left - card.width - 16;
        top = target.top;
        if (left < 12) {
            left = target.left;
            top = target.top >= card.height + 28 ? target.top - card.height - 16 : target.top + target.height + 16;
        }
    }
    return { left: clamp(left, viewport.width, card.width), top: Math.max(minTop, Math.min(top, maxBottom - height)) };
}
