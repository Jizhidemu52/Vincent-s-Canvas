export function isCanvasPerformanceModeEnabled(isDevelopment: boolean, isExplicitlyEnabled: boolean, performanceQuery: string | null) {
    return (isDevelopment || isExplicitlyEnabled) && performanceQuery === "1";
}

const performanceFixtureSizes = {
    "1": 500,
    "500": 500,
    "2000": 2000,
    "5000": 5000,
} as const;

/**
 * Keep stress fixtures opt-in and bounded, so a query parameter can never
 * accidentally allocate an unbounded synthetic project in a browser tab.
 */
export function canvasPerformanceFixtureSize(performanceModeEnabled: boolean, fixtureQuery: string | null): 500 | 2000 | 5000 | null {
    if (!performanceModeEnabled || !fixtureQuery) return null;
    return performanceFixtureSizes[fixtureQuery as keyof typeof performanceFixtureSizes] ?? null;
}

export function shouldUseCanvasPerformanceScenario(performanceModeEnabled: boolean, fixtureQuery: string | null) {
    return canvasPerformanceFixtureSize(performanceModeEnabled, fixtureQuery) !== null;
}
