import { test, expect } from "@playwright/test";
import { resolve } from "node:path";

const fixture = `<!doctype html><html><head><script type="module">import RefreshRuntime from '/@react-refresh';RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script></head><body><div id="root"></div><script type="module" src="/e2e/canvas-video-poster-fixture.tsx"></script></body></html>`;

test('authorized poster resolves pending state without loading original video; hover preview pauses and low quality uses only static poster', async ({ context, page }, info) => {
    let posterRequests = 0, originalRequests = 0;
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await context.route('**/*', route => {
        const url = new URL(route.request().url());
        if (url.hostname !== '127.0.0.1') return route.abort();
        if (url.pathname === '/__video') return route.fulfill({ contentType: 'text/html', body: fixture });
        if (/\/api\/assets\/[^/]+\/thumb$/.test(url.pathname)) {
            posterRequests++;
            return posterRequests === 1 ? route.fulfill({ status: 202, headers: { 'Retry-After': '1' } }) : route.fulfill({ contentType: 'image/png', path: resolve(import.meta.dirname, 'media/reference.png'), headers: { 'X-Canvas-Media-Duration-Ms': '280' } });
        }
        if (/\/api\/assets\/[^/]+\/content$/.test(url.pathname)) { originalRequests++; return route.fulfill({ contentType: 'video/mp4', path: resolve(import.meta.dirname, 'media/video.mp4') }); }
        return route.continue();
    });
    await page.goto('/__video');
    const video = page.getByLabel('播放视频', { exact: true });
    await expect(video).toHaveAttribute('poster', /^blob:/);
    await expect(page.getByText('0:01', { exact: true })).toBeVisible();
    expect(posterRequests).toBe(2); expect(originalRequests).toBe(0);
    await page.locator("[data-canvas-video-drag-surface]").hover();
    await expect.poll(() => video.evaluate(element => ({ paused: (element as HTMLVideoElement).paused, muted: (element as HTMLVideoElement).muted }))).toEqual({ paused: false, muted: true });
    expect(originalRequests).toBeGreaterThan(0);
    await page.getByRole('button', { name: 'full', exact: true }).hover();
    await expect.poll(() => video.evaluate(element => (element as HTMLVideoElement).paused)).toBe(true);
    await page.getByRole('button', { name: 'moving', exact: true }).click();
    await expect(video).toHaveCount(0); await expect(page.getByAltText('视频封面', { exact: true })).toBeVisible();
    await page.screenshot({ path: info.outputPath('video-moving-static-poster.png') });
    await page.getByRole('button', { name: 'overview', exact: true }).click();
    await expect(video).toHaveCount(0); await expect(page.getByAltText('视频封面', { exact: true })).toBeVisible();
    const beforeLocal = posterRequests;
    const previousPoster = await page.getByAltText('视频封面', { exact: true }).getAttribute('src');
    await page.getByRole('button', { name: 'local', exact: true }).click();
    await expect(page.getByAltText('视频封面', { exact: true })).not.toHaveAttribute('src', previousPoster!);
    await expect.poll(() => page.getByAltText('视频封面', { exact: true }).evaluate(element => (element as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    expect(posterRequests).toBe(beforeLocal);
    await page.screenshot({ path: info.outputPath('video-local-first-frame.png') });
    await page.getByRole('button', { name: 'toggle', exact: true }).click();
    await expect(page.locator('[data-canvas-video-content]')).toHaveCount(0);
    expect(errors).toEqual([]);
});

test('denied poster does not retry or block the existing video controls', async ({ context, page }) => {
    let requests = 0;
    await context.route('**/*', route => {
        const url = new URL(route.request().url());
        if (url.hostname !== '127.0.0.1') return route.abort();
        if (url.pathname === '/__video') return route.fulfill({ contentType: 'text/html', body: fixture });
        if (url.pathname.endsWith('/thumb')) { requests++; return route.fulfill({ status: 404 }); }
        return route.continue();
    });
    await page.goto('/__video');
    await expect(page.getByLabel('播放视频', { exact: true })).toBeVisible();
    await expect.poll(() => requests).toBe(1);
    await page.getByRole('button', { name: 'moving', exact: true }).click();
    await page.getByRole('button', { name: 'full', exact: true }).click();
    expect(requests).toBe(1);
    await expect(page.getByLabel('播放视频', { exact: true })).toHaveAttribute('controls', '');
});
