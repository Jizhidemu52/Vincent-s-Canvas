/** Prevent older searches (including their errors/loading flags) replacing a newer list. */
export function createPromptListLoader() {
    let revision = 0;
    return {
        invalidate() { revision += 1; },
        async load<T>(read: () => Promise<T>, accept: (value: T) => void, fail: (error: unknown) => void, loading: (value: boolean) => void) {
            const current = ++revision;
            loading(true);
            try {
                const value = await read();
                if (current === revision) accept(value);
            } catch (error) {
                if (current === revision) fail(error);
            } finally {
                if (current === revision) loading(false);
            }
        },
    };
}
