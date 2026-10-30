import { test, expect, type BrowserContext } from "@playwright/test";
import { moduleDefinitions } from "../../shared/feature-catalog";
import { IMAGE } from "./fixtures";

const owner = "71000000-0000-4000-8000-000000000001";
const project = "73000000-0000-4000-8000-000000000001";
const sample = (id: string, title: string, createdAt = "2026-10-01T00:00:00.000001Z") => ({
    id, ownerUserId: owner, ownerName: "隔离验证员工", departmentId: "72000000-0000-4000-8000-000000000001", departmentName: "设计部", projectId: project, projectName: "服装项目",
    filename: `${title}.png`, mimeType: "image/png", byteSize: IMAGE.length, kind: "image", source: "upload", status: "ready", visibilityScope: "private", metadata: { title, tags: ["服装"] },
    createdAt, contentUrl: `/api/assets/${id}/content`, thumbnailUrl: `/api/assets/${id}/thumb?w=256`, previewUrl: `/api/assets/${id}/thumb?w=1024`,
    resultStatus: "unused", usabilityScore: 0, downloadCount: 0, firstDownloadedAt: null, eventCount: 0,
});

async function setup(context: BrowserContext, baseURL: string) {
    const assets = [sample("asset-a", "首张参考"), sample("asset-b", "第二张参考", "2026-10-01T00:00:00.000002Z")];
    const deleted = [{ ...sample("asset-deleted", "待恢复参考"), deletedAt: new Date().toISOString(), purgeAfter: new Date(Date.now() + 30 * 86_400_000).toISOString() }];
    const lists: URL[] = [], uploads: Array<{ filename: string; clientReferenceId: string }> = [], unexpected: string[] = [], pageErrors: string[] = [];
    let failUpload = true, failReceipt = false, receipts = 0, shares = 0;
    context.on("page", page => page.on("pageerror", error => pageErrors.push(error.message)));
    for (const page of context.pages()) page.on("pageerror", error => pageErrors.push(error.message));
    await context.routeWebSocket("**/*", socket => socket.close());
    await context.route("**/*", async route => {
        const request = route.request(), url = new URL(request.url()), path = url.pathname;
        const json = (value: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(value) });
        if (url.origin !== baseURL) { unexpected.push(request.url()); return route.abort(); }
        if (!path.startsWith('/api/')) return route.continue();
        if (path === '/api/deployment') return json({ authenticationEnabled: true, creditsEnabled: false, rolePortalsEnabled: false, oaLoginEnabled: false });
        if (path === '/api/auth/session') return json({ user: { id: owner, displayName: '隔离验证员工', username: 'asset-e2e', role: 'designer', departmentId: '72000000-0000-4000-8000-000000000001', status: 'active', mustChangePassword: false } });
        if (path === '/api/modules') return json({ modules: moduleDefinitions.map(item => ({ moduleKey: item.moduleKey, enabled: true })) });
        if (path === '/api/models') return json({ models: [], tools: [], prices: [] });
        if (path === '/api/canvas-documents') return json({ documents: [] });
        if (path === '/api/usage/events') return json({ code: 0, data: [] });
        if (path === '/api/projects') return json({ projects: [{ id: project, name: '服装项目' }] });
        if (path === '/api/assets' || path === '/api/assets/trash') {
            lists.push(url);
            const source = path.endsWith('/trash') ? deleted : assets;
            const filtered = source.filter(asset => !url.searchParams.get('tag') || asset.metadata.tags.includes(url.searchParams.get('tag')!));
            const sorted = [...filtered].sort((a, b) => (url.searchParams.get('sort') === 'oldest' ? 1 : -1) * a.createdAt.localeCompare(b.createdAt));
            return json({ assets: sorted, hasMore: false, nextCursor: null });
        }
        if (path.endsWith('/restore')) { const asset = deleted.shift()!; assets.push(asset); return route.fulfill({ status: 204 }); }
        if (path === '/api/assets/upload-request') {
            const input = request.postDataJSON(); uploads.push(input);
            if (input.filename === 'failed.png' && failUpload) return json({ message: '测试上传中断' }, 503);
            return json({ assetId: `upload-${uploads.length}`, uploadUrl: null }, 201);
        }
        if (path.endsWith('/download-receipts')) { receipts++; if (failReceipt) return json({ message: '记录服务暂不可用' }, 503); return json({ eventId: 'receipt-a', projection: { resultStatus: 'downloaded', usabilityScore: 1, downloadCount: receipts, firstDownloadedAt: new Date().toISOString(), eventCount: receipts } }); }
        if (path.endsWith('/share')) { shares++; return route.fulfill({ status: 204 }); }
        if (/^\/api\/assets\/[^/]+\/(content|thumb)$/.test(path)) return route.fulfill({ contentType: 'image/png', body: IMAGE });
        if (/^\/api\/assets\/[^/]+$/.test(path)) return json({ asset: assets.find(asset => asset.id === path.split('/')[3]) });
        unexpected.push(`${request.method()} ${path}`); return json({ message: 'Unmocked test request' }, 501);
    });
    return { lists, uploads, unexpected, pageErrors, succeedUploads: () => { failUpload = false; }, failReceipts: () => { failReceipt = true; }, receipts: () => receipts, shares: () => shares };
}

test('asset library filters, sort and deleted restore work through the visible UI', async ({ page, context, baseURL }) => {
    const fixture = await setup(context, baseURL!);
    await page.goto('/assets');
    await expect(page.getByRole('heading', { name: '素材库', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '更多筛选', exact: true }).click();
    await page.getByRole('combobox', { name: '按标签筛选' }).click();
    await page.locator('.ant-select-item-option-content').getByText('服装', { exact: true }).click();
    await expect.poll(() => fixture.lists.at(-1)?.searchParams.get('tag')).toBe('服装');
    await page.getByRole('combobox', { name: '按项目筛选' }).click();
    await page.getByText('服装项目', { exact: true }).last().click();
    await expect.poll(() => fixture.lists.at(-1)?.searchParams.get('projectId')).toBe(project);
    await page.getByRole('combobox', { name: '素材排序' }).click();
    await page.getByText('最早创建优先', { exact: true }).last().click();
    await expect.poll(() => fixture.lists.at(-1)?.searchParams.get('sort')).toBe('oldest');
    await page.getByPlaceholder('创建开始日期').fill('2026-10-01');
    await page.getByPlaceholder('创建开始日期').press('Enter');
    await page.getByPlaceholder('创建结束日期').fill('2026-10-03');
    await page.getByPlaceholder('创建结束日期').press('Enter');
    await page.getByRole('heading', { name: '素材库', exact: true }).click();
    await expect.poll(() => Boolean(fixture.lists.at(-1)?.searchParams.get('createdFrom'))).toBe(true);
    await page.getByText('最近删除', { exact: true }).click();
    await expect(page.getByRole('heading', { name: '最近删除', exact: true })).toBeVisible();
    await expect(page.getByText('待恢复参考', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '恢复素材', exact: true }).click();
    await expect(page.getByText('暂无可恢复素材')).not.toBeVisible(); // Active filters keep the filtered-empty wording.
    await expect(page.getByText('没有找到匹配素材')).toBeVisible();
    await page.getByText('我的素材', { exact: true }).click();
    await expect(page.getByText('待恢复参考', { exact: true }).first()).toBeVisible();
    expect(fixture.unexpected).toEqual([]); expect(fixture.pageErrors).toEqual([]);
});

test('failed uploads retain per-file errors and retry references while download and share refresh the right state', async ({ page, context, baseURL }) => {
    const fixture = await setup(context, baseURL!);
    await page.goto('/assets');
    await expect(page.getByText('首张参考', { exact: true }).first()).toBeVisible();
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: '上传图片', exact: true }).first().click();
    await (await chooser).setFiles([{ name: 'success.png', mimeType: 'image/png', buffer: IMAGE }, { name: 'failed.png', mimeType: 'image/png', buffer: IMAGE }]);
    await expect(page.getByText('failed.png：测试上传中断')).toBeVisible();
    expect(await page.locator('input[type=file][multiple]').inputValue()).toBe('');
    fixture.succeedUploads();
    await page.getByRole('button', { name: '重试失败项' }).click();
    await expect(page.getByText('1 张图片上传失败')).not.toBeVisible();
    expect(fixture.uploads.filter(input => input.filename === 'failed.png').map(input => input.clientReferenceId)).toEqual([fixture.uploads.find(input => input.filename === 'failed.png')!.clientReferenceId, fixture.uploads.find(input => input.filename === 'failed.png')!.clientReferenceId]);
    await page.getByText('首张参考', { exact: true }).first().click();
    const drawer = page.getByRole('dialog');
    await expect(drawer).toBeVisible();
    const beforeDownload = fixture.lists.length;
    await drawer.getByRole('button', { name: '下载图片', exact: true }).click();
    await expect.poll(fixture.receipts).toBe(1);
    await expect(page.getByText('下载已开始，下载记录已更新')).toBeVisible();
    expect(fixture.lists).toHaveLength(beforeDownload);
    fixture.failReceipts();
    const secondDownload = page.waitForEvent('download');
    await drawer.getByRole('button', { name: '下载图片', exact: true }).click();
    expect((await secondDownload).suggestedFilename()).toBe('首张参考.png');
    await expect(page.getByText('下载已开始，但下载记录暂未更新；无需重复下载')).toBeVisible();
    await expect(page.getByText('记录服务暂不可用', { exact: true })).not.toBeVisible();
    expect(fixture.receipts()).toBe(2);
    expect(fixture.lists).toHaveLength(beforeDownload);
    await drawer.getByRole('button', { name: '共享到部门', exact: true }).click();
    await expect.poll(fixture.shares).toBe(1);
    await expect.poll(() => fixture.lists.length).toBeGreaterThan(beforeDownload);
    expect(fixture.unexpected).toEqual([]); expect(fixture.pageErrors).toEqual([]);
});
