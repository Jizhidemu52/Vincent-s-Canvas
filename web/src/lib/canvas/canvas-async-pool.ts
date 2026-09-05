/**
 * Runs independent local media imports with a small bounded pool. Results keep
 * their input order, while a slow file no longer blocks every other result.
 */
export async function mapCanvasAsyncPool<T, R>(
    values: readonly T[],
    concurrency: number,
    map: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
    if (!values.length) return [];
    const results = new Array<R>(values.length);
    let nextIndex = 0;
    const workerCount = Math.min(values.length, Math.max(1, concurrency | 0));

    const worker = async () => {
        while (nextIndex < values.length) {
            const index = nextIndex++;
            results[index] = await map(values[index], index);
        }
    };

    await Promise.all(Array.from({ length: workerCount }, worker));
    return results;
}
