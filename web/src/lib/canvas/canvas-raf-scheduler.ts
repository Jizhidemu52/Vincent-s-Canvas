type ScheduleFrame = (callback: () => void) => number;
type CancelFrame = (frame: number) => void;

export function createRafLatestScheduler<T>(scheduleFrame: ScheduleFrame, cancelFrame: CancelFrame, onValue: (value: T) => void) {
    let frame: number | undefined;
    let latest: T | undefined;

    const flush = () => {
        if (frame !== undefined) {
            cancelFrame(frame);
            frame = undefined;
        }
        if (latest === undefined) return;
        const value = latest;
        latest = undefined;
        onValue(value);
    };

    return {
        schedule(value: T) {
            latest = value;
            if (frame !== undefined) return;
            frame = scheduleFrame(() => {
                frame = undefined;
                if (latest === undefined) return;
                const next = latest;
                latest = undefined;
                onValue(next);
            });
        },
        flush,
        cancel() {
            if (frame !== undefined) cancelFrame(frame);
            frame = undefined;
            latest = undefined;
        },
    };
}
