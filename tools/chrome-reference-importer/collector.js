import { canvasOrigin, cleanUrl, readImage, deliverToReview, MAX_TOTAL_BYTES } from "./protocol.js";
const el = id => document.getElementById(id);
const sourceTab = Number(new URLSearchParams(location.search).get("sourceTab"));
let candidates = [], sourcePage = "", pageTitle = "", controller = null, target = null;
const status = text => { el("status").textContent = text; };
const selected = () => candidates.filter(item => item.checkbox.checked);
const refresh = () => { el("send").disabled = Boolean(controller) || !selected().length || selected().length > 20; status(`发现 ${candidates.length} 张候选，已勾选 ${selected().length}/20 张。`); };

const saved = await chrome.storage.local.get("canvasOrigin");
el("origin").value = saved.canvasOrigin || "";
el("cancel").addEventListener("click", () => { controller?.abort(); status("已取消；送达审核页的草稿仍需在那里决定是否导入。"); });
el("revoke").addEventListener("click", async () => {
    const { origins = [] } = await chrome.permissions.getAll();
    if (origins.length) await chrome.permissions.remove({ origins });
    status("已撤销扩展所有可选站点权限；下次发送会重新请求。");
});
el("scan").addEventListener("click", scan);
async function scan() {
    el("errors").textContent = "";
    try {
        const [injection] = await chrome.scripting.executeScript({ target: { tabId: sourceTab }, func: () => {
            const urls = new Map();
            const add = (value, label, width = 0, height = 0) => {
                if (!value || urls.size >= 500) return;
                try { const url = new URL(value, document.baseURI); if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.href.length > 16384) return; if (!urls.has(url.href)) urls.set(url.href, { url: url.href, label: String(label || "参考图片").slice(0, 150), width, height }); } catch { /* unsupported URL */ }
            };
            document.querySelectorAll("img").forEach(img => add(img.currentSrc || img.src, img.alt, img.naturalWidth, img.naturalHeight));
            for (const node of Array.from(document.querySelectorAll("*")).slice(0, 5000)) {
                const background = getComputedStyle(node).backgroundImage;
                for (const match of background.matchAll(/url\(["']?([^"')]+)["']?\)/g)) add(match[1], "背景参考图");
            }
            return { images: [...urls.values()], page: location.href, title: document.title.slice(0, 300) };
        } });
        sourcePage = injection.result.page; pageTitle = injection.result.title;
        candidates = injection.result.images.map(image => ({ ...image, id: crypto.randomUUID() }));
        el("images").replaceChildren();
        for (const item of candidates) {
            const tile = document.createElement("article"); tile.className = "tile";
            const img = document.createElement("img"); img.src = item.url; img.alt = item.label; img.loading = "lazy"; img.referrerPolicy = "no-referrer";
            const label = document.createElement("label"); const checkbox = document.createElement("input"); checkbox.type = "checkbox"; checkbox.addEventListener("change", refresh); item.checkbox = checkbox;
            label.append(checkbox, document.createTextNode(item.label));
            const info = document.createElement("p"); info.textContent = `${item.width || "?"} × ${item.height || "?"} · ${new URL(item.url).hostname}`;
            const result = document.createElement("p"); result.className = "result"; item.result = result;
            tile.append(img, label, info, result); el("images").append(tile);
        }
        refresh();
    } catch { el("errors").textContent = "无法扫描该页。请回到普通 HTTP/HTTPS 网页重新点击扩展；Chrome 内部页、商店页、已关闭或已跳转的网页不能读取。"; }
}

async function sendMessage(type, image) {
    const [result] = await chrome.scripting.executeScript({ target: { tabId: target.id }, func: deliverToReview, args: [target.origin, target.nonce, type, image || null, crypto.randomUUID()] });
    if (!result?.result?.ok) throw new Error(result?.result?.error || "审核页未确认接收");
}

el("send").addEventListener("click", async () => {
    let origin, images;
    try {
        origin = canvasOrigin(el("origin").value.trim()); images = selected();
        if (!images.length || images.length > 20) throw new Error("请选择 1–20 张图片");
        // This API must execute directly within the click gesture, before any await.
        const origins = [...new Set([origin, ...images.map(item => new URL(item.url).origin)])].map(value => `${value}/*`);
        if (!await chrome.permissions.request({ origins })) throw new Error("未授予所选域名权限，没有读取或发送图片");
    } catch (error) { el("errors").textContent = error.message; return; }
    controller = new AbortController(); const signal = controller.signal;
    el("send").disabled = true; el("scan").disabled = true; el("cancel").disabled = false; el("revoke").disabled = true; el("origin").disabled = true;
    for (const item of candidates) item.checkbox.disabled = true;
    el("errors").textContent = "";
    let total = 0, accepted = 0;
    try {
        await chrome.storage.local.set({ canvasOrigin: origin });
        if (target) {
            try {
                const tab = await chrome.tabs.get(target.id);
                const current = new URL(tab.url);
                if (current.origin !== target.origin || current.pathname !== "/reference-import") target = null;
            } catch { target = null; }
        }
        if (!target || target.origin !== origin) {
            const nonce = crypto.randomUUID(); const tab = await chrome.tabs.create({ url: `${origin}/reference-import#referenceNonce=${nonce}`, active: false });
            target = { id: tab.id, nonce, origin };
        }
        let ready = false;
        for (let attempt = 0; attempt < 12 && !signal.aborted; attempt++) {
            try { await sendMessage("hello"); ready = true; break; } catch { await new Promise(resolve => setTimeout(resolve, 500)); }
        }
        signal.throwIfAborted();
        if (!ready) { await chrome.tabs.update(target.id, { active: true }); target = null; throw new Error("审核页未就绪。请先登录画布网站，再返回此采集页重试（OA 用户从 OA 进入同一浏览器）。"); }
        const hashes = new Set();
        for (const item of images) {
            signal.throwIfAborted(); item.result.textContent = "正在读取原图…";
            let timer;
            const request = new AbortController();
            const cancelRequest = () => request.abort();
            signal.addEventListener("abort", cancelRequest, { once: true });
            try {
                timer = setTimeout(() => request.abort(), 30000);
                // No cookies, no page referrer, no credentialed redirects or server-side URL fetch.
                const response = await fetch(item.url, { credentials: "omit", referrerPolicy: "no-referrer", redirect: "error", signal: request.signal });
                const { bytes, mime } = await readImage(response, signal, MAX_TOTAL_BYTES - total);
                const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), byte => byte.toString(16).padStart(2, "0")).join("");
                if (hashes.has(digest)) { item.result.textContent = "内容重复，已跳过"; continue; }
                hashes.add(digest); total += bytes.length;
                let binary = "";
                for (let offset = 0; offset < bytes.length; offset += 32768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
                signal.throwIfAborted();
                await sendMessage("image", { id: item.id, name: new URL(item.url).pathname.split("/").pop() || item.label, mime, base64: btoa(binary), sourcePage: cleanUrl(sourcePage), sourceImage: cleanUrl(item.url), pageTitle });
                item.result.textContent = "已送达审核页（尚未入库）"; accepted++;
            } catch (error) { item.result.textContent = signal.aborted ? "已取消" : `失败：${error.message || "读取失败，可能是防盗链/跨域/登录限制"}`; }
            finally { clearTimeout(timer); signal.removeEventListener("abort", cancelRequest); }
        }
        status(`已送达 ${accepted} 张。请到画布审核标签页确认导入，失败项可在本页重试。`);
        if (accepted) await chrome.tabs.update(target.id, { active: true });
    } catch (error) { el("errors").textContent = signal.aborted ? "已取消发送。已送达的图片未自动入库。" : error.message; }
    finally { controller = null; el("scan").disabled = false; el("cancel").disabled = true; el("send").disabled = !selected().length; el("revoke").disabled = false; el("origin").disabled = false; for (const item of candidates) item.checkbox.disabled = false; }
});
await scan();
