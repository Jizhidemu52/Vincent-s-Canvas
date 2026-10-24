import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const originals = [
  'docs/manual/prompt-optimization/无线画布-板块系统提示词（机密）.md',
  'docs/manual/prompt-optimization/无线画布-提示词优化工作流方案.md',
];
export const requiredSource = [...originals, 'server/scripts/import-prompt-recipes.ts', 'server/src/index.ts', 'server/src/migrations/043_prompt_recipes.sql'];
export function assertReleaseName(name) {
  if (!/^canvas-[a-f0-9]{7,40}-[0-9]{8}-prompt$/.test(name)) throw Error('Invalid release name');
  return name;
}
export function assertClean(repo) {
  const changes = execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: repo, encoding: 'utf8', windowsHide: true });
  if (changes.trim()) throw Error('Commit the final release scope and resolve all untracked source before packaging; ignored output is not source.');
}
export async function files(directory, prefix = '') {
  const result = [];
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const name = prefix ? `${prefix}/${item.name}` : item.name;
    if (item.isDirectory()) result.push(...await files(path.join(directory, item.name), name));
    else if (item.isFile()) result.push(name);
    else throw Error(`Symlink or unsupported package entry: ${name}`);
  }
  return result.sort();
}
export async function manifest(directory, names) {
  return (await Promise.all(names.map(async name => `${createHash('sha256').update(await readFile(path.join(directory, name))).digest('hex')}  ${name}`))).join('\n') + '\n';
}
export function assertPublicPackage(names) {
  for (const name of names) {
    if ((/(^|\/)\.env($|\.)/.test(name) && !name.endsWith('.env.example')) || /(^|\/)node_modules\//.test(name)
      || /(^|\/)(?:[^/]*\.pem|[^/]*\.key|[^/]*\.(?:sqlite3?|db)(?:-wal|-shm)?|[^/]*\.(?:dump|backup|bak))$/i.test(name)) throw Error(`Private/runtime material in archive: ${name}`);
  }
}

async function main() {
  const deploy = path.dirname(fileURLToPath(import.meta.url));
  const repo = path.resolve(deploy, '../..');
  const run = (command, args, cwd = repo) => execFileSync(command, args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
  const revision = run('git', ['rev-parse', 'HEAD']);
  const date = new Date().toISOString().slice(0, 10).replaceAll('-', '');
  const releaseName = assertReleaseName(`canvas-${revision.slice(0, 7)}-${date}-prompt`);
  assertClean(repo);
  const tracked = run('git', ['ls-tree', '-rz', '--name-only', 'HEAD']).split('\0').filter(Boolean);
  for (const name of requiredSource) if (!tracked.includes(name)) throw Error(`Required committed source missing: ${name}`);
  if (process.argv.includes('--check')) { console.log(JSON.stringify({ revision, releaseName, ready: true })); return; }
  if (process.argv.length > 2) throw Error('Usage: bun package.mjs [--check]');

  // All builds run from this fresh Git archive, never from the live working tree or an existing dist.
  const output = path.resolve(repo, 'output/prompt-optimization/packages', releaseName);
  await mkdir(path.dirname(output), { recursive: true });
  await mkdir(output); // Refuse to overwrite an earlier package for the same HEAD/date.
  const root = path.join(output, 'payload');
  await mkdir(root);
  run('git', ['archive', '--format=tar', `--output=${path.join(output, 'source.tar')}`, revision]);
  run('tar', ['-xf', path.join(output, 'source.tar'), '-C', root]);
  const sourceNames = await files(root);
  assertPublicPackage(sourceNames);
  const sourceManifest = await manifest(root, sourceNames);
  const buildRoot = path.join(output, 'build');
  await mkdir(buildRoot);
  run('tar', ['-xf', path.join(output, 'source.tar'), '-C', buildRoot]);
  const buildEnvironment = { ...process.env, NODE_ENV: 'production' };
  for (const key of Object.keys(buildEnvironment)) if (key.startsWith('VITE_') || key.startsWith('CANVAS_')) delete buildEnvironment[key];
  for (const directory of ['shared', 'web']) execFileSync('bun', ['install', '--frozen-lockfile'], { cwd: path.join(buildRoot, directory), stdio: 'inherit', env: { ...buildEnvironment, NODE_ENV: 'development' }, windowsHide: true });
  execFileSync('bun', ['run', 'build'], { cwd: path.join(buildRoot, 'web'), stdio: 'inherit', env: buildEnvironment, windowsHide: true });
  if (JSON.parse(await readFile(path.join(buildRoot, 'web/dist/deployment-edition.json'), 'utf8')).standalone) throw Error('Standalone build is not a production release');
  if (await manifest(buildRoot, sourceNames) !== sourceManifest) throw Error('Build modified committed source');
  assertClean(repo);
  if (run('git', ['rev-parse', 'HEAD']) !== revision) throw Error('HEAD changed while building');
  await cp(path.join(buildRoot, 'web/dist'), path.join(root, 'release-web'), { recursive: true });
  await mkdir(path.join(root, 'deploy'));
  for (const name of ['prepare.sh', 'cutover.sh', 'recipe-state.ts', 'Dockerfile.api', 'Dockerfile.web', 'README.md']) {
    const content = (await readFile(path.join(deploy, name), 'utf8')).replaceAll('__RELEASE__', releaseName).replaceAll('\r\n', '\n');
    await writeFile(path.join(root, 'deploy', name), content);
  }
  await writeFile(path.join(root, 'REVISION'), `${revision}\n`);
  await writeFile(path.join(root, 'release-web/revision.txt'), `${revision}\n`);
  await writeFile(path.join(root, 'SOURCE-SHA256SUMS'), sourceManifest);
  await writeFile(path.join(root, 'SERVER-SHA256SUMS'), await manifest(path.join(root, 'server'), await files(path.join(root, 'server'))));
  await writeFile(path.join(root, 'SHARED-SHA256SUMS'), await manifest(path.join(root, 'shared'), await files(path.join(root, 'shared'))));
  await writeFile(path.join(root, 'WEB-SHA256SUMS'), await manifest(path.join(root, 'release-web'), await files(path.join(root, 'release-web'))));
  await writeFile(path.join(root, 'ORIGINALS-SHA256SUMS'), await manifest(root, originals));
  const names = await files(root);
  assertPublicPackage(names);
  await writeFile(path.join(root, 'SHA256SUMS'), await manifest(root, names));
  const archive = path.join(output, `${releaseName}.tar.gz`);
  run('tar', ['-czf', archive, '-C', root, '.']);
  const data = await readFile(archive);
  console.log(JSON.stringify({ revision, releaseName, archive, bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') }, null, 2));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
