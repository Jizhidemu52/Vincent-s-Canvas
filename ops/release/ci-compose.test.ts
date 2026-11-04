import { expect, test } from 'bun:test';
import { releaseTestCompose } from './ci-compose.mjs';

const source = Bun.YAML.parse(await Bun.file(new URL('../../docker-compose.yml', import.meta.url)).text());
const options = { repository: '/work/repository', project: 'ci-release-123-amd64', commit: 'a'.repeat(40), apiImage: 'api:tested', webImage: 'web:tested', environment: '/work/private/test.env', port: 3301 };

test('candidate app images never rebuild while all test resources stay in one isolated project', () => {
  const config = releaseTestCompose(source, options);
  for (const role of ['api', 'worker', 'web']) {
    expect(config.services[role].build).toBeUndefined();
    expect(config.services[role].pull_policy).toBe('never');
    expect(config.services[role].container_name).toBeUndefined();
  }
  expect(config.services.api.image).toBe('api:tested');
  expect(config.services.worker.image).toBe('api:tested');
  expect(config.services.web.image).toBe('web:tested');
  expect(config.services.worker.environment.TASK_MOCK_MODE).toBe('false');
  expect(config.networks).toEqual({ default: { name: 'ci-release-123-amd64_default', internal: true } });
  expect(config.services.web.ports).toEqual(['127.0.0.1:3301:3000']);
  expect(config.services['mock-provider'].environment.CANVAS_SMOKE_PROJECT).toBe(options.project);
  expect(config.services['mock-provider'].ports).toBeUndefined();
  expect(source.services.api.build).toBeDefined();
});

test('refuses production project names and existing external data volumes', () => {
  expect(() => releaseTestCompose(source, { ...options, project: 'vincent-s-canvas' })).toThrow();
  expect(() => releaseTestCompose({ ...source, volumes: { pg: { name: 'production-pg' } } }, options)).toThrow();
});
