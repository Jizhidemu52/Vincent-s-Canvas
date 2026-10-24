import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFile } from 'node:child_process';
import { DemoOaStore } from '../src/demo-oa-store';

test('isolated demo serves light cursor pages, original bytes, authorized cache and atomic persisted batches', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'asset-library-http-'));
  const statePath = join(directory, 'state.sqlite');
  const identities = new DemoOaStore(statePath);
  const a = identities.login({ id: 'asset-employee-a', name: '素材甲' });
  const b = identities.login({ id: 'asset-employee-b', name: '素材乙' });
  identities.close();
  const probe = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response() });
  const port = probe.port!; await probe.stop(true);
  const base = `http://127.0.0.1:${port}`;
  const start = () => Bun.spawn([process.execPath, '--no-env-file', 'src/demo-server.ts'], {
    cwd: join(import.meta.dir, '..'), stdout: 'ignore', stderr: 'pipe',
    env: { ...process.env, DEMO_STATE_PATH: statePath, DEMO_RECOVERY_FILE: '', DEMO_PORT: String(port), DEMO_HOST: '127.0.0.1', OA_LOGIN_ENABLED: 'true', AUTH_ENABLED: 'true', CREDITS_ENABLED: 'false', LOCAL_STANDALONE: 'false', STANDALONE_WEB_DIR: '', OPENTOKEN_API_KEY: '', APIMART_API_KEY: '', GPT_IMAGE_2_API_KEY: '', MARK_IMAGE_API_KEY: '' },
  });
  let handle = start();
  const ready = async () => {
    for (let count = 0; count < 100; count++) {
      if (await fetch(base + '/api/health').then(response => response.ok).catch(() => false)) return;
      if (handle.exitCode !== null) throw new Error(await new Response(handle.stderr).text());
      await Bun.sleep(50);
    }
    throw new Error('isolated asset server did not start');
  };
  const request = (path: string, employee = a, init: RequestInit = {}) => fetch(base + path, { ...init,
    headers: { cookie: `wireless_canvas_demo_session=${employee.token}`, 'content-type': 'application/json', 'x-canvas-owner-id': employee.user.id, ...init.headers } });
  const post = (path: string, body: unknown, employee = a) => request(path, employee, { method: 'POST', body: JSON.stringify(body) });
  const upload = async (name: string, bytes: Uint8Array, mimeType: string, employee = a) => {
    const input = await post('/api/assets/upload-request', { filename: name, mimeType, byteSize: bytes.length, metadata: { note: '完整详情'.repeat(500), title: name } }, employee).then(response => response.json()) as any;
    expect((await request(input.uploadUrl, employee, { method: 'PUT', body: Uint8Array.from(bytes).buffer })).status).toBe(204);
    return input.assetId as string;
  };
  try {
    await ready();
    const text = new TextEncoder().encode('完整文本内容');
    const ids: string[] = [];
    for (let index = 0; index < 61; index++) ids.push(await upload(`text-${index}.txt`, text, 'text/plain'));
    const other = await upload('other.txt', text, 'text/plain', b);
    const first = await request('/api/assets').then(response => response.json()) as any;
    expect(first.assets).toHaveLength(60); expect(first.hasMore).toBe(true);
    expect(first.assets[0].metadata.note).toBeUndefined(); expect(first.assets[0].metadata.content).toBeUndefined();
    expect(first.assets[0].canRecreate).toBe(true);
    const second = await request(`/api/assets?cursor=${encodeURIComponent(first.nextCursor)}`).then(response => response.json()) as any;
    expect(second.assets).toHaveLength(1); expect(second.hasMore).toBe(false);
    expect(new Set([...first.assets, ...second.assets].map(item => item.id)).size).toBe(61);
    const detail = await request(`/api/assets/${ids[0]}`).then(response => response.json()) as any;
    expect(detail.asset.metadata.content).toBe('完整文本内容'); expect(detail.asset.metadata.note.length).toBeGreaterThan(1000);
    const original = await request(`/api/assets/${ids[0]}/content`);
    expect(await original.bytes()).toEqual(text); expect(original.headers.get('x-content-type-options')).toBe('nosniff');
    const etag = original.headers.get('etag')!;
    expect((await request(`/api/assets/${ids[0]}/content`, a, { headers: { 'if-none-match': etag } })).status).toBe(304);
    expect((await request(`/api/assets/${ids[0]}/content`, b, { headers: { 'if-none-match': etag } })).status).toBe(404);
    expect((await post('/api/assets/batch', { action: 'delete', assetIds: [ids[0], other] })).status).toBe(403);
    expect((await request(`/api/assets/${ids[0]}`)).status).toBe(200);
    const project = await post('/api/projects/sync', { externalId: 'asset-canvas', name: '测试项目' }).then(response => response.json()) as any;
    expect(project.project.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(await request('/api/projects', b).then(response => response.json())).toEqual({ projects: [] });
    expect((await post('/api/assets/batch', { action: 'move-project', assetIds: ids.slice(0, 2), projectId: project.project.id })).status).toBe(200);
    const moved = await request(`/api/assets?projectId=${project.project.id}`).then(response => response.json()) as any;
    expect(moved.assets).toHaveLength(2);
    const downloaded = await post('/api/assets/batch', { action: 'download', assetIds: ids.slice(0, 2) }).then(response => response.json()) as any;
    expect(downloaded.count).toBe(2); expect(downloaded.assets[0].contentUrl).toContain('/content');
    expect((await post('/api/assets/batch', { action: 'delete', assetIds: ids.slice(0, 2) })).status).toBe(200);
    expect((await request(`/api/assets/${ids[0]}/content`)).status).toBe(404);
    const png = await new Promise<Buffer>((resolve, reject) => execFile(process.env.FFMPEG_PATH || 'ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=1600x900', '-frames:v', '1', '-f', 'image2pipe', '-c:v', 'png', 'pipe:1'], { windowsHide: true, encoding: 'buffer', timeout: 30_000 }, (error, stdout) => error ? reject(error) : resolve(stdout)));
    const picture = await upload('original.jpg', png, 'image/jpeg');
    let thumbnail: Response | undefined;
    for (let attempt = 0; attempt < 100; attempt++) {
      thumbnail = await request(`/api/assets/${picture}/thumb?w=256`);
      if (thumbnail.headers.get('content-type') === 'image/webp') break;
      await thumbnail.arrayBuffer(); await Bun.sleep(50);
    }
    expect(thumbnail!.headers.get('content-type')).toBe('image/webp');
    expect((await thumbnail!.bytes()).length).toBeLessThan(png.length);
    expect(await request(`/api/assets/${picture}/content`).then(response => response.bytes())).toEqual(new Uint8Array(png));
    handle.kill(); await handle.exited; handle = start(); await ready();
    const restored = await request('/api/projects').then(response => response.json()) as any;
    expect(restored.projects[0].id).toBe(project.project.id);
    expect((await request(`/api/assets/${ids[0]}`)).status).toBe(404);
    expect(await request(`/api/assets/${picture}/content`).then(response => response.bytes())).toEqual(new Uint8Array(png));
    const trash = await request('/api/assets/trash').then(response => response.json()) as any;
    expect(trash.assets.map((asset: any) => asset.id).sort()).toEqual(ids.slice(0, 2).sort());
    expect(trash.assets[0].contentUrl).toBeNull();
    expect(await request('/api/assets/trash', b).then(response => response.json())).toMatchObject({ assets: [] });
    expect((await post(`/api/assets/${ids[0]}/restore`, {}, b)).status).toBe(404);
    expect((await post(`/api/assets/${ids[0]}/restore`, {})).status).toBe(204);
    expect(await request(`/api/assets/${ids[0]}/content`).then(response => response.bytes())).toEqual(text);
    expect(await request(`/api/assets/${ids[0]}`).then(response => response.json())).toMatchObject({ asset: { projectId: project.project.id, metadata: { title: 'text-0.txt' } } });
    handle.kill(); await handle.exited; handle = start(); await ready();
    expect((await request(`/api/assets/${ids[0]}`)).status).toBe(200);
    expect(await request('/api/assets/trash').then(response => response.json())).toMatchObject({ assets: [{ id: ids[1] }] });
    const oldest = await request('/api/assets?sort=oldest&limit=1').then(response => response.json()) as any;
    expect(oldest.assets[0].id).toBe(ids[0]);
  } finally {
    handle.kill(); await handle.exited;
    const resolved = realpathSync(directory);
    if (dirname(resolved) !== realpathSync(tmpdir()) || !resolved.includes('asset-library-http-')) throw new Error('Refusing unsafe test cleanup');
    rmSync(resolved, { recursive: true, force: true });
  }
}, 30_000);
