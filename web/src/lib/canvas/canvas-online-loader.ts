type Network = { isOnline: () => boolean; events: EventTarget };

// Suspend only this optional tool while offline; keep the canvas mounted.
export async function loadCanvasToolWhenOnline<T>(load: () => Promise<T>, network?: Network): Promise<T> {
    if (!network && typeof window === "undefined") return load();
    network ??= { isOnline: () => navigator.onLine, events: window };
    const connection = network;
    for (;;) {
        if (!network.isOnline()) {
            await new Promise<void>(resolve => {
                const online = () => { connection.events.removeEventListener("online", online); resolve(); };
                connection.events.addEventListener("online", online);
                if (connection.isOnline()) online();
            });
        }
        try { return await load(); }
        catch (error) {
            if (network.isOnline()) throw error;
        }
    }
}
