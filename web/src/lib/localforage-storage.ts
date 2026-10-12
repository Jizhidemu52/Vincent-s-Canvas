import localforage from "localforage";
import type { StateStorage } from "zustand/middleware";
import { createStorageAccess } from "./storage-access";

localforage.config({
    name: "wireless-canvas",
    storeName: "app_state",
});

const access = createStorageAccess("wireless-canvas", () => localforage.ready());
export const readyLocalForageStorage = access.ready;
export const runLocalForageStorage = access.run;

export const localForageStorage: StateStorage = {
    getItem: async (name) => {
        if (typeof window === "undefined") return null;
        try {
            return (await access.run(() => localforage.getItem<string>(name))) || null;
        } catch {
            return window.localStorage.getItem(name);
        }
    },
    setItem: async (name, value) => {
        if (typeof window === "undefined") return;
        try {
            await access.run(() => localforage.setItem(name, value));
        } catch {
            window.localStorage.setItem(name, value);
        }
    },
    removeItem: async (name) => {
        if (typeof window === "undefined") return;
        try {
            await access.run(() => localforage.removeItem(name));
        } catch {
            window.localStorage.removeItem(name);
        }
    },
};
