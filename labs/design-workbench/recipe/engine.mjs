export function makeTasks(count, kind = 'structure') {
  const amount = Math.max(1, Math.min(6, Math.round(Number(count) || 1)));
  return [
    { id: 'source', label: '读取参考', depends: [], price: 0 },
    { id: 'prepare', label: kind === 'pattern' ? '设置图案定位' : '结构约束整理', depends: ['source'], price: 0 },
    ...Array.from({ length: amount }, (_, i) => ({ id: `variant-${i + 1}`, label: `候选 ${String(i + 1).padStart(2, '0')}`, depends: ['prepare'], price: 0.8, branch: i })),
    { id: 'board', label: '汇总方案板', depends: Array.from({ length: amount }, (_, i) => `variant-${i + 1}`), price: 0 },
  ].map(task => ({ ...task, status: 'waiting', attempts: 0, error: '', output: null }));
}

export function costs(tasks) {
  const cents = tasks.reduce((sum, task) => sum + Math.round(task.price * 100), 0);
  const attemptCents = tasks.reduce((sum, task) => sum + Math.round(task.price * 100) * task.attempts, 0);
  return { planned: cents / 100, attempted: attemptCents / 100, actual: 0 };
}

export class RecipeRunner {
  constructor({ tasks, execute, onChange = () => {}, stepMs = 600, tickMs = 40 }) {
    this.tasks = tasks.map(task => ({ ...task, depends: [...task.depends] }));
    this.execute = execute;
    this.onChange = onChange;
    this.stepMs = stepMs;
    this.tickMs = tickMs;
    this.active = false;
    this.paused = false;
    this.cancelled = false;
    this.controller = new AbortController();
  }
  snapshot() {
    return { tasks: this.tasks.map(task => ({ ...task, depends: [...task.depends] })), active: this.active, paused: this.paused, cancelled: this.cancelled, costs: costs(this.tasks) };
  }
  emit() { this.onChange(this.snapshot()); }
  pause() { if (this.active) { this.paused = true; this.emit(); } }
  resume() { if (this.active) { this.paused = false; this.emit(); } }
  cancel() { this.cancelled = true; this.paused = false; this.controller.abort(); this.emit(); }
  async checkpoint(milliseconds = 0) {
    let elapsed = 0;
    while (this.paused || elapsed < milliseconds) {
      if (this.cancelled) throw new Error('cancelled');
      await new Promise(resolve => setTimeout(resolve, this.tickMs));
      if (!this.paused) elapsed += this.tickMs;
    }
    if (this.cancelled) throw new Error('cancelled');
  }
  async run({ retryFailed = false } = {}) {
    if (this.active || this.cancelled) return false;
    if (retryFailed) this.tasks.filter(task => task.status === 'failed').forEach(task => { task.status = 'waiting'; task.error = ''; });
    this.active = true;
    this.emit();
    try {
      for (const task of this.tasks) {
        await this.checkpoint();
        if (task.status !== 'waiting') continue;
        if (!task.depends.every(id => this.tasks.find(item => item.id === id)?.status === 'completed')) continue;
        task.status = 'running';
        task.attempts += 1;
        this.emit();
        try {
          await this.checkpoint(this.stepMs);
          const output = await this.execute(task, this.controller.signal);
          await this.checkpoint();
          task.output = output ?? null;
          task.status = 'completed';
        } catch (error) {
          if (this.cancelled) break;
          task.status = 'failed';
          task.error = error?.message || '模拟步骤失败';
        }
        this.emit();
      }
    } catch (error) {
      if (!this.cancelled) throw error;
    } finally {
      this.active = false;
      this.paused = false;
      this.emit();
    }
    return !this.cancelled;
  }
}
