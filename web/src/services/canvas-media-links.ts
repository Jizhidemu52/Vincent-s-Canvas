import { createWorkspaceStorage } from "@/lib/workspace-storage";

const links = createWorkspaceStorage("cloud_media_links");
export function serverMediaId(url: string) { return url.match(/^\/api\/assets\/([0-9a-f-]{36})\/content$/i)?.[1] || ""; }
export async function rememberMediaSource(storageKey: string, url: string) {
    if (serverMediaId(url)) await links.setItem(`source:${storageKey}`, url);
}
export const readMediaSource = (storageKey: string) => links.getItem<string>(`source:${storageKey}`);
export const readUploadedMedia = (owner: string, key: string) => links.getItem<string>(JSON.stringify([owner, key]));
export const rememberUploadedMedia = (owner: string, key: string, url: string) => links.setItem(JSON.stringify([owner, key]), url);
