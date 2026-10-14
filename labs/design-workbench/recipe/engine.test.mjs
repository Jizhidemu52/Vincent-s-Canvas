import test from 'node:test';
import assert from 'node:assert/strict';
import { makeTasks, costs, RecipeRunner } from './engine.mjs';

test('branch limits and integer-cent simulated costs', () => {
  assert.equal(makeTasks(99).length, 9);
  assert.equal(makeTasks(0).length, 4);
  assert.equal(costs(makeTasks(3)).planned, 2.4);
  assert.equal(costs(makeTasks(6)).actual, 0);
});

test('retry only failed branch; completed work never runs twice', async () => {
  let failed = false;
  const runner = new RecipeRunner({ tasks: makeTasks(3), stepMs: 0, execute: async task => {
    if (task.id === 'variant-2' && !failed) { failed = true; throw new Error('injected'); }
    return task.id;
  } });
  await runner.run();
  assert.equal(runner.tasks.find(task => task.id === 'board').status, 'waiting');
  assert.equal(runner.tasks.find(task => task.id === 'variant-3').status, 'completed');
  await runner.run({ retryFailed: true });
  assert.ok(runner.tasks.every(task => task.status === 'completed'));
  assert.equal(runner.tasks.find(task => task.id === 'variant-2').attempts, 2);
  assert.ok(runner.tasks.filter(task => task.id !== 'variant-2').every(task => task.attempts === 1));
  assert.equal(costs(runner.tasks).attempted, 3.2);
  assert.equal(costs(runner.tasks).actual, 0);
});

test('pause gates execution; duplicate run and cancellation are safe', async () => {
  let executions = 0;
  const runner = new RecipeRunner({ tasks: makeTasks(1), stepMs: 30, tickMs: 5, execute: async () => ++executions });
  const running = runner.run();
  runner.pause();
  await new Promise(resolve => setTimeout(resolve, 45));
  assert.equal(executions, 0);
  assert.equal(await runner.run(), false);
  runner.resume();
  runner.cancel();
  await running;
  assert.equal(executions, 0);
  assert.equal(runner.active, false);
});

test('cancel while paused before first task resolves without a rejected run', async () => {
  let runner;
  runner = new RecipeRunner({ tasks: makeTasks(1), stepMs: 1, tickMs: 5, execute: async () => assert.fail('cancelled task must not execute'), onChange: snapshot => {
    if (snapshot.active && !snapshot.paused && !snapshot.cancelled && snapshot.tasks.every(task => task.attempts === 0)) runner.pause();
  } });
  const run = runner.run();
  runner.cancel();
  assert.equal(await run, false);
});
