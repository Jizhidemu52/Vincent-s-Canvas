// Disposable CI only. Production deployment never calls this renderer.
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function releaseTestCompose(source, options) {
  if (!/^ci-release-[a-z0-9-]+$/.test(options.project) || !/^[a-f0-9]{40}$/.test(options.commit)) throw Error('Explicit isolated CI identity required');
  if (!Number.isInteger(options.port) || options.port < 1024 || options.port > 65535) throw Error('Explicit loopback port required');
  const result = structuredClone(source);
  result.name = options.project;
  result.networks = { default: { name: `${options.project}_default`, internal: true } };
  for (const [name, service] of Object.entries(result.services)) {
    delete service.container_name;
    service.networks = ['default'];
    service.env_file = [options.environment];
    if (service.build) service.build.context = options.repository;
    if (['api', 'worker', 'web'].includes(name)) {
      delete service.build;
      service.image = name === 'web' ? options.webImage : options.apiImage;
      service.pull_policy = 'never';
    }
    if (['api', 'worker'].includes(name)) {
      service.environment = { ...(service.environment || {}), TASK_MOCK_MODE: 'false', AUTH_ENABLED: 'true', OA_LOGIN_ENABLED: 'false', CREDITS_ENABLED: 'true', ROLE_PORTALS_ENABLED: 'true' };
      service.command = ['bun', name === 'api' ? 'src/index.ts' : 'src/worker.ts'];
    }
  }
  result.services.web.ports = [`127.0.0.1:${options.port}:3000`];
  result.services['mock-provider'] = {
    image: options.apiImage, pull_policy: 'never', command: ['bun', '/smoke/mock-provider.ts'],
    environment: { HOST: '0.0.0.0', PORT: '4180', CANVAS_SMOKE_PROJECT: options.project },
    volumes: [{ type: 'bind', source: resolve(options.repository, 'server/tests/production-smoke'), target: '/smoke', read_only: true, bind: { create_host_path: false } }],
    networks: ['default'], read_only: true, tmpfs: ['/tmp:rw,noexec,nosuid,size=64m'],
    security_opt: ['no-new-privileges:true'], cap_drop: ['ALL'],
  };
  for (const volume of Object.values(result.volumes || {})) {
    if (volume?.external || volume?.name) throw Error('CI refuses externally named data volumes');
  }
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [repository, project, commit, apiImage, webImage, environment, port, output] = process.argv.slice(2);
  if (!output) throw Error('Explicit release CI paths required');
  const source = Bun.YAML.parse(await Bun.file(resolve(repository, 'docker-compose.yml')).text());
  const config = releaseTestCompose(source, { repository, project, commit, apiImage, webImage, environment, port: Number(port) });
  await writeFile(output, JSON.stringify(config, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
}
