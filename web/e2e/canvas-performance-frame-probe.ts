// Self-contained so Playwright serializes exactly this probe into the page.
// No application state, imported helper, or product timing is used to calibrate it.
export function startPerformanceFrameProbe(busyMs: number): Promise<void> {
    return new Promise((ready, reject) => {
        const state = { frames: [] as number[], timestamps: [] as number[], startupTimestamps: [] as number[],
            hiddenCount: document.hidden ? 1 : 0, active: true, started: false, last: undefined as number | undefined };
        let frameRequest = 0;
        let startupTimeout: number;
        const visibility = () => { if (document.hidden) state.hiddenCount++; };
        const stop = () => {
            state.active = false;
            cancelAnimationFrame(frameRequest);
            window.clearTimeout(startupTimeout);
            document.removeEventListener("visibilitychange", visibility);
        };
        document.addEventListener("visibilitychange", visibility);
        (window as any).__performanceFrames = { state, stop };
        startupTimeout = window.setTimeout(() => { stop(); reject(new Error("RAF clock did not advance before the gesture")); }, 15_000);
        const sample = (now: number) => {
            if (!state.active) return;
            if (!state.started) {
                // The first two callbacks can carry the same startup timestamp.
                // Keep that evidence, and do not start the mouse gesture until
                // the clock has advanced. Never filter measured gesture frames.
                state.startupTimestamps.push(now);
                if (!Number.isFinite(now) || (state.last !== undefined && now < state.last)) {
                    stop(); reject(new Error("Invalid RAF clock during probe startup")); return;
                }
                if (state.last !== undefined && now - state.last >= 750) {
                    stop(); reject(new Error("RAF clock stalled during probe startup")); return;
                }
                if (state.last === undefined || now === state.last) {
                    state.last = now; frameRequest = requestAnimationFrame(sample); return;
                }
                state.started = true;
                window.clearTimeout(startupTimeout);
                ready();
            } else state.frames.push(now - state.last!);
            state.timestamps.push(now);
            state.last = now;
            // Fixed test-only negative control, unchanged from the old probe.
            const end = performance.now() + busyMs;
            while (performance.now() < end) Math.sqrt(Math.random());
            frameRequest = requestAnimationFrame(sample);
        };
        frameRequest = requestAnimationFrame(sample);
    });
}
