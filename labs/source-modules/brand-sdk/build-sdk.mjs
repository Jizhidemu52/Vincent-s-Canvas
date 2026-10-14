import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { buildPlugin } from './sdk-source/plugins/canvas/sdk/build.mjs';
const root = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(root, 'qa', 'public');
await mkdir(publicDir, { recursive: true });
const sourceRoot = path.join(root, 'sdk-source', 'plugins', 'canvas');
const sdkResolve = { name: 'isolated-source-sdk-resolution', setup(builder) {
  builder.onResolve({ filter: /^@infinite-canvas\/plugin-sdk(?:\/jsx(?:-dev)?-runtime)?$/ }, args => ({
    path: path.join(sourceRoot, 'sdk', 'src', args.path.endsWith('/jsx-runtime') ? 'jsx-runtime.ts' : args.path.endsWith('/jsx-dev-runtime') ? 'jsx-dev-runtime.ts' : 'index.ts'),
  }));
} };
// The checked-out SDK build helper compiles the checked-out sticky-note source unchanged.
// Only its documented publicDir/resolver overrides point output and imports at the test folder.
await buildPlugin(pathToFileURL(path.join(sourceRoot, 'sticky-note', 'build.mjs')).href, { publicDir, plugins: [sdkResolve], esbuild: { metafile: true } });
const built = await build({ entryPoints: [path.join(root, 'sdk-host.tsx')], bundle: true, format: 'esm', platform: 'browser', outfile: path.join(publicDir, 'host.js'), jsx: 'automatic', define: { 'process.env.NODE_ENV': '"development"' }, metafile: true });
await writeFile(path.join(root, 'qa', 'host-build-inputs.json'), JSON.stringify(built.metafile, null, 2));
console.log('Source SDK build helper + original sticky-note source compiled. Browser host is only an adapter.');
