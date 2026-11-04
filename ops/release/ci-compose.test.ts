import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
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
  expect(config.networks).toEqual({
    default: { name: 'ci-release-123-amd64_default', internal: true },
    ingress: { name: 'ci-release-123-amd64_ingress', internal: false },
  });
  expect(config.services.web.networks).toEqual(['default', 'ingress']);
  for (const [role, service] of Object.entries(config.services)) {
    if (role === 'web') continue;
    expect(service.networks).toEqual(['default']);
    expect(service.ports).toBeUndefined();
  }
  expect(config.services.web.ports).toEqual(['127.0.0.1:3301:3000']);
  expect(config.services['mock-provider'].environment.CANVAS_SMOKE_PROJECT).toBe(options.project);
  expect(config.services['mock-provider'].ports).toBeUndefined();
  expect(source.services.api.build).toBeDefined();
});

test('refuses production project names and existing external data volumes', () => {
  expect(() => releaseTestCompose(source, { ...options, project: 'vincent-s-canvas' })).toThrow();
  expect(() => releaseTestCompose({ ...source, volumes: { pg: { name: 'production-pg' } } }, options)).toThrow();
});

test.skipIf(process.env.RUN_DOCKER_COMPOSE_CONTRACT_TESTS !== 'true')('the actual image health command reaches an explicitly IPv4-bound API', () => {
  const image = process.env.COMPOSE_RUNTIME_TEST_IMAGE;
  if (!image) throw Error('Explicit candidate image required');
  const command = releaseTestCompose(source, options).services.api.healthcheck.test;
  expect(command[0]).toBe('CMD');
  const script = `import express from "express";
const app=express();app.get("/api/health",(_,response)=>response.json({status:"ok"}));
const server=app.listen({host:"0.0.0.0",port:3100});
await new Promise(resolve=>server.once("listening",resolve));
try {
  const child=Bun.spawn(${JSON.stringify(command.slice(1))},{stdout:"pipe",stderr:"pipe"});
  const deadline=setTimeout(()=>child.kill(),3000);
  const [out,error,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
  clearTimeout(deadline);
  if(code!==0)throw Error("Health command failed: "+error);
  if(JSON.parse(out).status!=="ok")throw Error("Unexpected health response");
  console.log("IPV4_API_HEALTH_OK");
} finally {server.close();}`;
  const result = spawnSync('docker', ['run', '--rm', '--pull', 'never', '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--memory', '256m', '--pids-limit', '64', '--entrypoint', 'bun', image, '--no-env-file', '-e', script], { encoding: 'utf8', timeout: 15_000 });
  expect(result.error).toBeUndefined();
  if (result.status !== 0) throw Error(result.stderr.slice(0, 2000) || 'Candidate health probe failed');
  expect(result.status).toBe(0);
  expect(result.stdout.trim()).toBe('IPV4_API_HEALTH_OK');
}, 20_000);
