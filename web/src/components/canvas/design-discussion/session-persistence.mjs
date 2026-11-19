import { createClientUuid } from "../../../lib/client-uuid.ts";

const sessionKey = "session:media-v1";

export function createDesignSessionPersistence(storage, mediaStorage, onError, delay = 250) {
    const media = new Map();
    let pending = null;
    let running = null;
    let timer;
    let disposed = false;
    const encode = value => {
        if (typeof value === "string" && value.startsWith("data:image/")) {
            let record = media.get(value);
            if (!record) { record = { key: `media:${createClientUuid()}`, value, saved: false }; media.set(value, record); }
            return { designDiscussionMedia: record.key };
        }
        if (Array.isArray(value)) return value.map(encode);
        if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, encode(item)]));
        return value;
    };
    const decode = async value => {
        if (value && typeof value === "object" && Object.hasOwn(value, "designDiscussionMedia")) {
            const key = value.designDiscussionMedia;
            if (Object.keys(value).length !== 1 || typeof key !== "string" || !/^media:[a-f0-9-]{36}$/.test(key)) throw new Error("讨论资料引用无效，未覆盖原会话。");
            const image = await mediaStorage.getItem(key);
            if (typeof image !== "string" || !image.startsWith("data:image/")) throw new Error("讨论资料图片暂不可用，未覆盖原会话。");
            media.set(image, { key, value: image, saved: true });
            return image;
        }
        if (Array.isArray(value)) return Promise.all(value.map(decode));
        if (value && typeof value === "object") return Object.fromEntries(await Promise.all(Object.entries(value).map(async ([key, item]) => [key, await decode(item)])));
        return value;
    };
    const flush = () => {
        clearTimeout(timer);
        if (running) return running;
        if (!pending) return Promise.resolve();
        running = (async () => {
            while (pending) {
                const draft = pending;
                pending = null;
                try {
                    const snapshot = encode(draft);
                    for (const record of media.values()) if (!record.saved) {
                        await mediaStorage.setItem(record.key, record.value);
                        record.saved = true;
                    }
                    await storage.setItem(sessionKey, snapshot);
                } catch (error) { pending ||= draft; throw error; }
            }
        })().finally(() => { running = null; });
        return running;
    };
    return {
        async load() {
            const saved = await storage.getItem(sessionKey);
            if (saved === null) return decode(await storage.getItem("session"));
            if (!saved || typeof saved !== "object" || typeof saved.id !== "string" || !Array.isArray(saved.references) || !Array.isArray(saved.history) || typeof saved.prompt !== "string") throw new Error("新版讨论记录格式异常，未回退或覆盖原会话。");
            return decode(saved);
        },
        schedule(session) {
            if (disposed) return;
            pending = session;
            clearTimeout(timer);
            timer = setTimeout(() => { void flush().catch(onError); }, delay);
        },
        flush,
        dispose() { disposed = true; return flush(); },
    };
}
