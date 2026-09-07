/** Synchronous leases prevent a second click before React renders loading state. */
export function createSubmissionGate() {
    const active = new Set<string>();
    return {
        acquire(key: string) {
            if (active.has(key)) return null;
            active.add(key);
            let released = false;
            return () => {
                if (released) return;
                released = true;
                active.delete(key);
            };
        },
    };
}

export const workbenchSubmissions = createSubmissionGate();
