import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const dir = path.dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(await fs.readFile(path.join(dir, 'package.json'), 'utf8'));
const dependencies = {};
for (const [name, requested] of Object.entries(manifest.dependencies)) {
  const actual = JSON.parse(await fs.readFile(path.join(dir, 'node_modules', name, 'package.json'), 'utf8'));
  dependencies[name] = { requested, installed: actual.version };
}
const sourceFiles = ['src/App.vue', 'src/main.ts', 'src/views/home/index.vue', 'packages/core/Editor.ts', 'packages/core/ServersPlugin.ts', 'packages/core/plugin/LayerPlugin.ts', 'packages/core/plugin/LockPlugin.ts', 'packages/core/plugin/HistoryPlugin.ts', 'packages/core/plugin/ControlsPlugin.ts', 'src/components/importFile.vue', 'src/components/importJSON.vue', 'src/components/save.vue', 'LICENSE'];
const hashes = {};
for (const file of sourceFiles) hashes[file] = crypto.createHash('sha256').update(await fs.readFile(path.join(dir, 'upstream', file))).digest('hex');
const git = args => execFileSync('git', ['-C', path.join(dir, 'upstream'), ...args], { encoding: 'utf8' }).trim();
const report = { repository: 'https://github.com/ikuaitu/vue-fabric-editor', commit: git(['rev-parse', 'HEAD']), commitDate: git(['log', '-1', '--format=%aI']), upstreamWorkingTreeStatus: git(['status', '--short']), originalSourceUnmodified: git(['status', '--porcelain']) === '', node: process.version, packageManager: 'pnpm 8.4.0 via npm exec (not globally installed)', installedPackages: 475, packageScriptsDisabled: true, dependencies, sourceSHA256: hashes, sourceRootLicense: 'MIT, Copyright (c) 2022 秦少卫; preserved upstream/LICENSE', corePackageMetadataLicense: 'ISC (upstream packages/core/package.json metadata)', hostAdapters: ['runtime-only dependency manifest with pnpm-lock.yaml', 'Vite @kuaitu/core alias to untouched upstream/packages/core/index.ts', 'ESM default.default compatibility for vite-plugin-vue-setup-extend-plus', 'local offline API fixtures explicitly marked offline/localAdapter; external writes denied', 'Chinese presentation transforms in offline-host-adapter.ts; no core transforms', 'HTTP Content-Security-Policy denies external connections; data/blob permitted for local SVG loading', 'host-only offline notice and Chinese title'], actualSourcePaths: sourceFiles };
await fs.writeFile(path.join(dir, 'qa', 'provenance.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ commit: report.commit, originalSourceUnmodified: report.originalSourceUnmodified, runtimePackages: Object.keys(dependencies).length, node: report.node }, null, 2));
