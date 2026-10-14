import { loadImage, readImageFile, downloadBlob, saveProject, loadProject, notify } from '/shared.js';
import { makeTasks, RecipeRunner, costs } from './engine.mjs';
import { DEFAULT_PALETTE, normalizePalette, makeColor, generatePalette, recolorImageData } from './color-tools.mjs';

const STORAGE_KEY = 'design-studio-recipe-v1';
const PALETTE_STYLES = { soft: '柔和', vivid: '鲜明', earth: '大地', free: '自由' };
const RECIPES = {
  structure: { name: '参考款 → 结构 → 配色 → 方案板', short: '同结构，探索系列配色', prepare: '结构约束整理', branch: '配色候选', title: '轻盈夏日 / 2027', constraints: '保留短袖廓形、领型与门襟；不增加口袋和装饰。', prompt: '围绕柔和自然色系，探索适合夏季的同款配色。', description: '参考款 → 结构约束 → 多配色分支 → 方案板' },
  pattern: { name: '图案 → 定位 → 候选 → 方案板', short: '花叶图案，探索定位组合', prepare: '设置图案定位', branch: '定位候选', title: '植感日常 / 2027', constraints: '保留衬衫结构与底色，只比较花叶图案的位置与大小。', prompt: '把花叶图案放在胸前或下摆，比较克制、舒展的视觉布局。', description: '图案参考 → 定位设置 → 多方案分支 → 方案板' },
};
const STATUS = { waiting: '等待', running: '执行中', completed: '完成', failed: '失败' };
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const money = value => `¥${value.toFixed(2)}`;
const silhouette = '<svg viewBox="0 0 100 100" aria-hidden="true"><path d="M33 17 18 24 8 43 26 52 31 42 31 84 69 84 69 42 74 52 92 43 82 24 67 17 58 25 50 32 42 25Z" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M42 25 50 40 58 25M50 40V84" fill="none" stroke="currentColor"/></svg>';

const colorCode = color => [color.pantoneCode, color.library].filter(Boolean).join(' ');
const colorDescription = color => `${colorCode(color) ? `${colorCode(color)} / ` : ''}${color.hex.toUpperCase()}`;

async function createCandidate(source, kind, index, paletteColor, signal) {
  const image = await loadImage(source);
  if (signal.aborted) throw new Error('cancelled');
  const canvas = document.createElement('canvas');
  canvas.width = 700; canvas.height = 805;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fafbf7'; ctx.fillRect(0, 0, 700, 805);
  const scale = Math.min(650 / image.width, 650 / image.height);
  const w = Math.round(image.width * scale), h = Math.round(image.height * scale);
  const x = Math.round((700 - w) / 2), y = Math.round((700 - h) / 2) + 20;
  ctx.drawImage(image, x, y, w, h);
  if (kind === 'structure') {
    const pixels = ctx.getImageData(x, y, w, h);
    recolorImageData(pixels, paletteColor.hex);
    ctx.putImageData(pixels, x, y);
  } else {
    const motif = await loadImage(index % 2 ? '/assets/leaf.svg' : '/assets/flower.svg');
    if (signal.aborted) throw new Error('cancelled');
    const placements = [[.59,.4,.13], [.41,.65,.2], [.48,.48,.23], [.63,.58,.13], [.4,.37,.11], [.49,.67,.16]];
    const [px, py, size] = placements[index];
    ctx.save(); ctx.globalAlpha = .8;
    ctx.drawImage(motif, x + w * (px - size / 2), y + h * (py - size / 2), w * size, h * size);
    ctx.restore();
  }
  ctx.fillStyle = '#e9eee3'; ctx.fillRect(25, 741, 650, 1);
  ctx.fillStyle = '#819072'; ctx.font = '15px sans-serif'; ctx.fillText(kind === 'structure' ? '本地近似色示意 / 非人工智能生成' : '本地效果示意 / 非人工智能生成', 28, 775);
  ctx.fillStyle = '#77826b'; ctx.textAlign = 'right'; ctx.fillText(String(index + 1).padStart(2,'0'), 670, 775);
  return { image: canvas.toDataURL('image/png'), name: kind === 'structure' ? paletteColor.name : ['胸前小花','下摆叶影','中心花饰','侧身叶形','领下花点','下摆叶饰'][index], color: paletteColor.hex, paletteColor: {...paletteColor}, colorLabel: kind === 'structure' ? colorDescription(paletteColor) : '', method: kind === 'structure' ? '本地近似配色（非服装分割）' : 'Canvas 花叶 SVG 定位叠加（非真实面料渲染）' };
}

function wrapText(ctx, text, x, y, maxWidth, lineHeight, maxLines = 3) {
  let line = '', row = 0;
  for (const char of String(text)) {
    if (ctx.measureText(line + char).width > maxWidth) {
      ctx.fillText(line, x, y + row * lineHeight); line = char; row += 1;
      if (row >= maxLines) return;
    } else line += char;
  }
  if (row < maxLines) ctx.fillText(line, x, y + row * lineHeight);
}

export async function mountDemo(root) {
  let disposed = false, uploadEpoch = 0, uploadPending = false, runner = null, view = null, stale = false;
  let params = { kind: 'structure', series: RECIPES.structure.title, constraints: RECIPES.structure.constraints, prompt: RECIPES.structure.prompt, count: 3, injectFailure: false, palette: normalizePalette(DEFAULT_PALETTE), paletteMode: 'manual', paletteStyle: 'soft' };
  let source = { name: '内置参考 · 蓝色短袖衬衫', dataURL: '/assets/garment.png' };
  let selected = new Set(), runSnapshot = null;
  let activeColor = 0, hexDraft = params.palette[0].hex, paletteStatus = '', paletteError = false;
  const link = document.createElement('link'); link.rel = 'stylesheet'; link.href = '/recipe/recipe.css'; document.head.appendChild(link);
  root.classList.add('recipe-demo');

  function currentTasks() { return view?.tasks || makeTasks(params.count, params.kind); }
  function currentResults() { return currentTasks().filter(task => task.id.startsWith('variant-') && task.status === 'completed' && task.output?.image); }
  function copyParams() { return {...params, palette: params.palette.map(color => ({...color}))}; }
  function refreshColorDraft() { activeColor = Math.min(activeColor, params.count - 1); hexDraft = params.palette[activeColor].hex; }
  function paletteEditor() {
    if (params.kind !== 'structure') return '<div class="recipe-color-note">定位流程只比较图案位置，不使用配色。</div>';
    const locked = !!runner?.active || uploadPending, current = params.palette[activeColor];
    return `<div class="recipe-color-heading"><strong>系列配色</strong><span>点击色块逐个编辑</span></div>
      <div class="recipe-palette" role="group" aria-label="候选颜色">${params.palette.slice(0,params.count).map((color,index)=>`<button type="button" class="recipe-color-chip" data-action="color-select" data-color-index="${index}" data-edit aria-pressed="${activeColor===index}" aria-label="编辑第 ${index+1} 色，${esc(colorDescription(color))}" title="第 ${index+1} 色 · ${esc(colorDescription(color))}" style="--swatch:${color.hex}" ${locked?'disabled':''}><span>${index+1}</span></button>`).join('')}</div>
      <div class="recipe-color-modes" role="group" aria-label="配色方式"><button type="button" data-action="color-mode" data-mode="manual" data-edit aria-pressed="${params.paletteMode==='manual'}" ${locked?'disabled':''}>手动选色</button><button type="button" data-action="color-mode" data-mode="random" data-edit aria-pressed="${params.paletteMode==='random'}" ${locked?'disabled':''}>随机配色</button></div>
      ${params.paletteMode==='random'?`<label for="recipe-palette-style">整组配色风格</label><div class="recipe-color-random"><select id="recipe-palette-style" name="paletteStyle" data-edit ${locked?'disabled':''}>${Object.entries(PALETTE_STYLES).map(([value,label])=>`<option value="${value}" ${params.paletteStyle===value?'selected':''}>${label}</option>`).join('')}</select><button type="button" class="recipe-btn" data-action="randomize" data-edit ${locked?'disabled':''}>换一组</button></div>`:''}
      <label for="recipe-color-hex" class="recipe-color-current">正在编辑第 ${activeColor+1} 色 <span>${esc(current.name)}</span></label>
      <div class="recipe-color-inputs"><input id="recipe-color-picker" type="color" name="palettePicker" data-edit value="${current.hex}" aria-label="选择第 ${activeColor+1} 色" ${locked?'disabled':''}><input id="recipe-color-hex" type="text" name="paletteHex" data-edit maxlength="7" spellcheck="false" autocomplete="off" value="${esc(hexDraft)}" placeholder="#91A8A1" aria-label="当前颜色 HEX 色值" ${locked?'disabled':''}><button type="button" class="recipe-btn" data-action="apply-color" data-edit ${locked?'disabled':''}>应用</button></div>
      <div class="recipe-color-status ${paletteError?'error':''}" data-palette-status role="status">${esc(paletteStatus || (params.paletteMode==='random'?'选择风格后，点击“换一组”生成整组颜色。':'可直接选色，或输入 HEX 后点击“应用”。'))}</div>
      <div class="recipe-color-note">屏幕近似色，仅用于方向比较；不等于实物色卡、染色或印花标准。</div>`;
  }
  function renderPalette() { const panel = root.querySelector('[data-palette-editor]'); if (panel) panel.innerHTML = paletteEditor(); }
  function applyPaletteColor(hex) {
    if (runner?.active || uploadPending) return;
    try {
      const color = makeColor(hex, {name:`自选色 ${activeColor+1}`,source:'manual',approximate:true});
      params.palette = params.palette.map((item,index)=>index===activeColor?{...color}:{...item});
      hexDraft = color.hex; paletteStatus = `第 ${activeColor+1} 色已更新为 ${color.hex.toUpperCase()}。`; paletteError = false;
      invalidate(); renderPalette();
    } catch(error) { paletteStatus = error.message || '请输入有效的 HEX 色值，例如 #91A8A1。'; paletteError = true; renderPalette(); }
  }
  function invalidate(message = '') {
    if (runner?.active) return;
    stale = stale || !!view; runner?.cancel(); runner = null; view = null; runSnapshot = null; selected.clear();
    if (message) notify(message);
    update();
  }
  function shell() {
    const recipe = RECIPES[params.kind];
    root.innerHTML = `
      <header class="recipe-hero"><div><div class="recipe-kicker">系列设计 / 配方工作台</div><p>选一份配方，调整关键参数，让重复步骤自己向前。</p></div><div class="recipe-hero-label">本地模拟 · 非人工智能效果 · 实际 ¥0</div></header>
      <div class="recipe-workspace">
        <aside class="recipe-sidebar"><h2 class="recipe-section-heading">系列配方 <span class="recipe-count">01 / 设置</span></h2>
          <form class="recipe-form" onsubmit="return false">
            <div class="recipe-field"><label for="recipe-kind">选择流程</label><select id="recipe-kind" name="kind" data-edit><option value="structure" ${params.kind === 'structure' ? 'selected' : ''}>参考款 → 提取结构 → 配色</option><option value="pattern" ${params.kind === 'pattern' ? 'selected' : ''}>图案 → 定位 → 候选</option></select></div>
            <div class="recipe-field"><label for="recipe-upload">参考底图</label><div class="recipe-file"><img data-source-preview src="${esc(source.dataURL)}" alt="当前参考底图"><span class="recipe-file-copy">点击替换<br>PNG / JPG / WebP</span><input id="recipe-upload" data-edit type="file" accept="image/png,image/jpeg,image/webp" aria-label="上传参考图"></div><div class="recipe-source-name" data-source-name>${esc(source.name)} · 最大 15 MB</div></div>
            <div class="recipe-field"><label for="recipe-series">系列名称</label><input id="recipe-series" data-edit name="series" type="text" maxlength="80" value="${esc(params.series)}"></div>
            <div class="recipe-field"><label for="recipe-constraints">必须保留</label><textarea id="recipe-constraints" data-edit name="constraints" maxlength="500">${esc(params.constraints)}</textarea></div>
            <div class="recipe-field"><label for="recipe-prompt">设计方向</label><textarea id="recipe-prompt" data-edit name="prompt" maxlength="700">${esc(params.prompt)}</textarea></div>
            <div class="recipe-field"><label for="recipe-count">${params.kind === 'structure' ? '配色数量' : '候选数量'}</label><select id="recipe-count" data-edit name="count">${Array.from({length:6},(_,i)=>`<option value="${i+1}" ${params.count===i+1?'selected':''}>${i+1} 个${params.kind==='structure'?'配色':'定位'}候选</option>`).join('')}</select></div>
            <div class="recipe-palette-editor" data-palette-editor></div>
            <label class="recipe-checkline"><input id="recipe-failure" data-edit name="injectFailure" type="checkbox" ${params.injectFailure?'checked':''}><span>注入一次分支失败<br>体验“只重试失败项”</span></label>
          </form>
          <div class="recipe-mini-actions"><button class="recipe-btn" data-action="save">保存配方</button><button class="recipe-btn" data-action="restore">恢复配方</button><button class="recipe-btn subtle" data-action="reset-source">使用内置参考</button></div>
        </aside>
        <main class="recipe-center" aria-label="流程与候选矩阵"></main>
        <aside class="recipe-sidebar recipe-monitor" aria-label="运行控制和导出"></aside>
      </div>`;
    renderPalette(); update();
  }

  function update() {
    if (disposed) return;
    const active = !!view?.active, paused = !!view?.paused, recipe = RECIPES[params.kind];
    const tasks = currentTasks(), resultTasks = tasks.filter(task=>task.id.startsWith('variant-'));
    const completed = tasks.filter(task=>task.status==='completed').length;
    const failed = tasks.filter(task=>task.status==='failed').length;
    const allDone = completed === tasks.length;
    const estimate = costs(tasks);
    const phase = uploadPending ? '正在读取本地输入' : paused ? '已暂停 · 可继续' : active ? '配方执行中' : failed ? '有分支失败 · 可单独重试' : allDone ? '方案已就绪' : stale ? '参数已改动 · 请重新运行' : '准备就绪';
    root.querySelectorAll('[data-edit]').forEach(input => { input.disabled = active || uploadPending; });
    root.querySelectorAll('[data-action="restore"],[data-action="reset-source"],[data-action="save"]').forEach(button => { button.disabled = active || uploadPending; });
    const nodes = [tasks[0],tasks[1],{id:'variants', label:`${params.count} 个${recipe.branch}`, status: resultTasks.some(t=>t.status==='running')?'running':resultTasks.some(t=>t.status==='failed')?'failed':resultTasks.every(t=>t.status==='completed')?'completed':'waiting', attempts:resultTasks.reduce((s,t)=>s+t.attempts,0)}, tasks.at(-1)];
    root.querySelector('.recipe-center').innerHTML = `
      <div class="recipe-center-top"><div><h2>${esc(params.series || '未命名系列')}</h2><div class="recipe-small">${recipe.short}</div></div><div class="recipe-state" role="status">${phase}</div></div>
      <div class="recipe-flow" aria-label="节点输入输出关系">${nodes.map((task,i)=>`${i?'<span class="recipe-flow-arrow" aria-hidden="true">→</span>':''}<div class="recipe-flow-node ${task.status}" data-node="${task.id}"><div class="recipe-node-number">0${i+1} / ${STATUS[task.status]}</div><strong>${esc(task.label)}</strong><small>${['输入：参考图','输出：约束记录','输出：本地示意图','输出：方案板'][i]}<br>已执行 ${task.attempts} 次</small></div>`).join('')}</div>
      <div class="recipe-live-note ${failed||stale?'warning':''}">${failed ? '模拟故障只影响一个分支。成功候选已保留；点击“仅重试失败项”，不会重跑它们。' : stale ? '配方参数已改变，上一轮结果已清除，避免使用错误参数的候选。' : params.kind==='pattern' ? '本地示意：内置花叶 SVG 定位叠加。仅展示位置关系，不模拟印花透视、褶皱或材质融合。' : '本地示意：按选定色值进行近似改色，不进行服装语义分割。上传照片中其他彩色区域也可能被改色，显示效果不等于实物标准。'}</div>
      <div class="recipe-section-heading">${recipe.branch} <span class="recipe-count">${currentResults().length} / ${params.count} 已就绪</span></div>
      <div class="recipe-grid">${resultTasks.map((task,i)=>{
        const output=task.output, picked=selected.has(task.id);
        return `<article class="recipe-result ${picked?'selected':''}" data-result="${task.id}"><div class="recipe-result-visual">${output?.image ? `<img src="${output.image}" alt="${esc(output.name)}本地示意候选">` : `<div class="recipe-placeholder">${silhouette}<span>${task.status==='failed'?'模拟失败，可重试':task.status==='running'?'正在处理本地示意…':'等待上游输入'}</span></div>`}<span class="recipe-result-badge">本地示意 · 非人工智能效果</span></div><div class="recipe-result-status"><span>${STATUS[task.status]}${task.status==='failed'?' / 注入故障':''}</span><span>执行 ${task.attempts} 次</span></div><div class="recipe-result-footer"><div class="recipe-result-name"><strong><i class="recipe-dot" style="background:${output?.color || params.palette[i].hex}"></i>${esc(output?.name || (params.kind==='structure'?params.palette[i].name:`定位 ${i+1}`))}</strong>${params.kind==='structure'?`<span class="recipe-result-colorcode">${esc(output?.colorLabel || colorDescription(params.palette[i]))} · 近似色</span>`:''}</div><button class="recipe-pick" data-action="pick" data-id="${task.id}" aria-pressed="${picked}" ${!output?.image||active?'disabled':''}>${picked?'✓ 已入选':'选入方案'}</button></div></article>`;
      }).join('')}</div>
      <div class="recipe-empty-board">方案板已选 <strong>${selected.size}</strong> 个候选。${selected.size ? '可在右侧导出高清 PNG；选中状态会写入完整流程 JSON。' : '模拟运行后，从候选中选择要交付的方向。'}${failed ? '<br>方案汇总节点正在等待失败分支，已完成候选仍可单独导出。' : ''}</div>
      <div class="recipe-footnote">约束与设计方向会随流程保存、导出，但本试用版的滤色/定位不理解自然语言。未接实际模型，不能评价人工智能版型保留、细节一致性或材质真实度。</div>`;
    root.querySelector('.recipe-monitor').innerHTML = `
      <div><h2 class="recipe-section-heading">运行配方 <span class="recipe-count">02 / 执行</span></h2><div class="recipe-run"><button class="recipe-btn primary wide" data-action="run" ${active||uploadPending?'disabled':''}>${allDone?'重新模拟运行':'模拟运行'}</button><div class="recipe-run-buttons"><button class="recipe-btn" data-action="${paused?'resume':'pause'}" ${!active?'disabled':''}>${paused?'继续运行':'暂停'}</button><button class="recipe-btn" data-action="stop" ${!active?'disabled':''}>停止并重置</button></div><button class="recipe-btn wide" style="margin-top:8px" data-action="retry" ${!failed||active||uploadPending?'disabled':''}>仅重试失败项${failed?` (${failed})`:''}</button><div class="recipe-progress" role="progressbar" aria-label="配方完成进度" aria-valuemin="0" aria-valuemax="${tasks.length}" aria-valuenow="${completed}"><i style="width:${completed/tasks.length*100}%"></i></div><div class="recipe-small">${completed} / ${tasks.length} 节点完成${paused?' · 已暂停':''}${failed?` · ${failed} 个失败`:''}</div></div>
      <div class="recipe-metrics"><div class="recipe-metric"><span>计划节点</span><strong>${tasks.length}</strong></div><div class="recipe-metric"><span>生成分支</span><strong>${params.count}</strong></div></div><div class="recipe-price-row"><span>模拟单分支费率</span><b>¥0.80</b></div><div class="recipe-price-row"><span>计划模拟费用</span><b>${money(estimate.planned)}</b></div><div class="recipe-price-row"><span>含重试的模拟费用</span><b>${money(estimate.attempted)}</b></div><div class="recipe-price-row"><span>实际产生费用</span><b>¥0.00</b></div><div class="recipe-disclaimer">费率仅为演示假设，不是供应商报价。失败尝试也计入模拟次数；所有图像操作均在浏览器本地执行。</div>
      <div class="recipe-log" aria-label="节点执行记录">${tasks.map(task=>`<div class="recipe-log-item" data-log="${task.id}"><span>${esc(task.label)}</span><span>${STATUS[task.status]} · ${task.attempts} 次</span></div>`).join('')}</div></div>
      <div class="recipe-export"><h2 class="recipe-section-heading">带走方案 <span class="recipe-count">03 / 导出</span></h2><button class="recipe-btn wide" data-action="export-board" ${!selected.size||active?'disabled':''}>导出方案板 PNG</button><button class="recipe-btn wide" data-action="export-json" ${active||uploadPending?'disabled':''}>导出完整流程 JSON</button><div class="recipe-small">PNG 保留近似色与“非人工智能”标记。JSON 包含输入图、完整配色、配方参数、候选结果及执行记录。</div></div>`;
  }

  async function start(retry = false) {
    if (runner?.active || uploadPending || disposed) return;
    if (retry && runner) { await runner.run({retryFailed:true}); return; }
    runner?.cancel();
    selected.clear(); stale = false;
    runSnapshot = { params: copyParams(), source: {...source}, startedAt: new Date().toISOString() };
    const frozen = runSnapshot;
    let failureUsed = false;
    const localRunner = new RecipeRunner({ tasks: makeTasks(params.count, params.kind), stepMs: 680,
      onChange: snapshot => { if (!disposed && runner === localRunner) { view = snapshot; update(); } },
      execute: async (task,signal) => {
        if (task.id === 'source') { const img=await loadImage(frozen.source.dataURL); return {width:img.width,height:img.height,name:frozen.source.name}; }
        if (task.id === 'prepare') return {constraints:frozen.params.constraints,prompt:frozen.params.prompt,note:'人工参数整理，未进行人工智能识别'};
        if (task.branch !== undefined) {
          if (frozen.params.injectFailure && !failureUsed && task.branch === Math.min(1,frozen.params.count-1)) { failureUsed=true; throw new Error('注入的一次性模拟分支故障'); }
          const result=await createCandidate(frozen.source.dataURL,frozen.params.kind,task.branch,frozen.params.palette[task.branch],signal);
          if (!signal.aborted && !disposed && runner === localRunner) selected.add(task.id);
          return result;
        }
        return {ready:true,note:'方案板从本地候选按用户选择排版'};
      }
    });
    runner=localRunner;
    try { await localRunner.run(); } catch (error) { if (!disposed) notify(error.message,'error'); }
  }

  async function exportBoard() {
    const results=currentResults().filter(task=>selected.has(task.id));
    if (!results.length || runner?.active) return;
    const frozen=runSnapshot || {params:copyParams()};
    const snapshotResults=results.map(task=>({name:task.output.name,image:task.output.image,colorLabel:task.output.colorLabel || ''}));
    const cols=Math.min(3,results.length), rows=Math.ceil(results.length/cols), width=1800, cell=(width-160-(cols-1)*30)/cols, cellH=cell*1.15;
    const canvas=document.createElement('canvas'); canvas.width=width; canvas.height=Math.ceil(280+rows*(cellH+95)+190);
    const ctx=canvas.getContext('2d'); ctx.fillStyle='#f5f3ee'; ctx.fillRect(0,0,width,canvas.height);
    ctx.fillStyle='#537456';ctx.font='18px sans-serif';ctx.fillText('系列设计 / 本地效果示意',80,76);
    ctx.fillStyle='#26362a';ctx.font='bold 48px sans-serif';wrapText(ctx,frozen.params.series||'未命名系列',80,144,width-160,56,1);
    ctx.fillStyle='#78836e';ctx.font='20px sans-serif';ctx.fillText(frozen.params.kind==='structure'?'屏幕近似色，非人工智能效果  /  实际费用 ¥0.00':'本地示意，非人工智能效果  /  实际费用 ¥0.00',80,193);
    for (let index=0;index<snapshotResults.length;index++) {
      const result=snapshotResults[index], img=await loadImage(result.image);
      if (disposed) return;
      const x=80+(index%cols)*(cell+30),y=250+Math.floor(index/cols)*(cellH+95);
      ctx.fillStyle='white';ctx.fillRect(x,y,cell,cellH+68);ctx.drawImage(img,x,y,cell,cellH);
      ctx.fillStyle='#4c6044';ctx.font='22px sans-serif';wrapText(ctx,`${String(index+1).padStart(2,'0')}  ${result.name}${result.colorLabel?` · ${result.colorLabel}`:''}`,x+20,y+cellH+28,cell-40,27,2);
    }
    const footer=canvas.height-125;ctx.fillStyle='#758168';ctx.font='20px sans-serif';
    wrapText(ctx,`保留约束：${frozen.params.constraints}`,80,footer,width-160,30,2);
    ctx.font='17px sans-serif';ctx.fillText('仅供流程体验；屏幕近似色不是实物标准，未验证版型保留、材质真实性与生产可行性。',80,canvas.height-35);
    const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));
    if (!disposed && blob) { downloadBlob(blob,`系列方案板-${new Date().toISOString().slice(0,10)}.png`);notify('方案板 PNG 已导出，保留非人工智能标记'); }
  }

  async function exportJSON() {
    const snapshot=runSnapshot ? {...runSnapshot,params:{...runSnapshot.params,palette:runSnapshot.params.palette.map(color=>({...color}))},source:{...runSnapshot.source}} : {params:copyParams(),source:{...source}};
    const data={schema:'collection-recipe-demo/v1',exportedAt:new Date().toISOString(),mode:'local-simulation-not-ai',recipe:RECIPES[params.kind].description,...snapshot,source:{...snapshot.source},tasks:currentTasks(),selection:[...selected],costs:costs(currentTasks()),limitations:['未接实际模型','提示词与约束只记录，不驱动图像语义编辑','局部改色不等于服装分割或人工智能配色','HEX 和图像为屏幕近似色，不是实物色卡或生产颜色标准','模拟费用不构成报价，实际费用为0']};
    if (data.source.dataURL === '/assets/garment.png') {
      const img=await loadImage(data.source.dataURL);if(disposed)return;
      const canvas=document.createElement('canvas');canvas.width=img.width;canvas.height=img.height;canvas.getContext('2d').drawImage(img,0,0);
      data.source.originalAsset=data.source.dataURL;data.source.dataURL=canvas.toDataURL('image/png');
    }
    downloadBlob(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}),'系列流程-完整记录.json');
    notify('完整流程 JSON 已导出');
  }

  async function handleClick(event) {
    const button=event.target.closest('button[data-action]');
    if (!button || !root.contains(button) || button.disabled) return;
    const action=button.dataset.action;
    if (['color-select','color-mode','randomize','apply-color'].includes(action) && (runner?.active || uploadPending)) return;
    try {
      if (action==='color-select') {
        const index=Number(button.dataset.colorIndex);if(!Number.isInteger(index)||index<0||index>=params.count)return;
        activeColor=index;refreshColorDraft();paletteStatus='';paletteError=false;renderPalette();
      }
      else if (action==='color-mode') {
        const mode=button.dataset.mode;if(!['manual','random'].includes(mode)||mode===params.paletteMode)return;
        params.paletteMode=mode;paletteStatus='';paletteError=false;invalidate();renderPalette();
      }
      else if (action==='randomize') {
        const generated=generatePalette(params.count,params.paletteStyle);
        params.palette=normalizePalette([...generated,...params.palette.slice(params.count)]);
        refreshColorDraft();paletteStatus=`已生成 ${params.count} 个${PALETTE_STYLES[params.paletteStyle]}配色，可逐个微调。`;paletteError=false;invalidate();renderPalette();
      }
      else if (action==='apply-color') applyPaletteColor(root.querySelector('#recipe-color-hex').value);
      else if (action==='run') await start();
      else if (action==='retry') await start(true);
      else if (action==='pause') runner?.pause();
      else if (action==='resume') runner?.resume();
      else if (action==='stop') { runner?.cancel();runner=null;view=null;runSnapshot=null;selected.clear();stale=false;update();notify('已停止，未产生实际费用'); }
      else if (action==='pick') { const id=button.dataset.id;if(selected.has(id))selected.delete(id);else selected.add(id);update(); }
      else if (action==='save') { await saveProject(STORAGE_KEY,{version:1,params:copyParams(),source:{...source},savedAt:new Date().toISOString()});if(!disposed)notify('配方已保存到本机浏览器'); }
      else if (action==='restore') {
        const epoch=++uploadEpoch;uploadPending=true;update();
        const saved=await loadProject(STORAGE_KEY);
        if(disposed||epoch!==uploadEpoch)return;
        if(!saved){uploadPending=false;update();notify('本机还没有保存过配方','error');return;}
        if(saved.version!==1||!RECIPES[saved.params?.kind]||typeof saved.source?.dataURL!=='string'||!(/^(data:image\/(png|jpeg|webp);base64,|\/assets\/garment\.png$)/.test(saved.source.dataURL)))throw new Error('保存的配方格式无效');
        await loadImage(saved.source.dataURL);if(disposed||epoch!==uploadEpoch)return;uploadPending=false;
        const restoredPalette=normalizePalette(saved.params.palette);
        invalidate();params={kind:saved.params.kind,series:String(saved.params.series||'').slice(0,80),constraints:String(saved.params.constraints||'').slice(0,500),prompt:String(saved.params.prompt||'').slice(0,700),count:Math.max(1,Math.min(6,Math.round(Number(saved.params.count)||3))),injectFailure:!!saved.params.injectFailure,palette:restoredPalette,paletteMode:saved.params.paletteMode==='random'?'random':'manual',paletteStyle:Object.hasOwn(PALETTE_STYLES,saved.params.paletteStyle)?saved.params.paletteStyle:'soft'};source={name:String(saved.source.name||'保存的参考图'),dataURL:saved.source.dataURL};activeColor=0;refreshColorDraft();paletteStatus='';paletteError=false;stale=false;shell();notify('已恢复配方与配色；运行结果需重新模拟');
      }
      else if (action==='reset-source') { source={name:'内置参考 · 蓝色短袖衬衫',dataURL:'/assets/garment.png'};invalidate();shell(); }
      else if (action==='export-board') await exportBoard();
      else if (action==='export-json') await exportJSON();
    } catch(error) { if(!disposed){if(action==='restore'){uploadPending=false;update();}notify(error.message||'操作未完成','error');} }
  }

  async function handleChange(event) {
    const target=event.target;
    if(runner?.active)return;
    if(target.name==='palettePicker') { if(!uploadPending)applyPaletteColor(target.value);return; }
    if(target.name==='paletteStyle') {
      if(uploadPending||!Object.hasOwn(PALETTE_STYLES,target.value))return;
      params.paletteStyle=target.value;paletteStatus='';paletteError=false;invalidate();renderPalette();return;
    }
    if(target.id==='recipe-upload') {
      const file=target.files?.[0];if(!file)return;
      const epoch=++uploadEpoch;uploadPending=true;update();
      try {
        const dataURL=await readImageFile(file);await loadImage(dataURL);
        if(disposed||epoch!==uploadEpoch)return;
        source={name:file.name,dataURL};uploadPending=false;invalidate();shell();notify('参考图已替换，旧候选已清除');
      }catch(error){if(!disposed&&epoch===uploadEpoch){uploadPending=false;update();notify(error.message||'图片读取失败','error');target.value='';}}
      return;
    }
    if(target.name==='kind') {
      if(!RECIPES[target.value])return;
      const recipe=RECIPES[target.value];params={...params,kind:target.value,series:recipe.title,constraints:recipe.constraints,prompt:recipe.prompt};invalidate();shell();return;
    }
    if(target.name==='count'){params.count=Math.max(1,Math.min(6,Number(target.value)||3));refreshColorDraft();paletteStatus='';paletteError=false;invalidate();renderPalette();}
    else if(target.name==='injectFailure'){params.injectFailure=target.checked;invalidate();}
  }

  function handleInput(event) {
    const target=event.target;
    if(target.name==='paletteHex') { if(!runner?.active&&!uploadPending)hexDraft=target.value;return; }
    if(runner?.active || !['series','constraints','prompt'].includes(target.name))return;
    params[target.name]=target.value;invalidate();
  }
  function handleKeydown(event) { if(event.key==='Enter'&&event.target.id==='recipe-color-hex'){event.preventDefault();applyPaletteColor(event.target.value);} }
  root.addEventListener('click',handleClick);root.addEventListener('change',handleChange);root.addEventListener('input',handleInput);root.addEventListener('keydown',handleKeydown);
  shell();
  return () => { disposed=true;uploadEpoch+=1;runner?.cancel();root.removeEventListener('click',handleClick);root.removeEventListener('change',handleChange);root.removeEventListener('input',handleInput);root.removeEventListener('keydown',handleKeydown);root.classList.remove('recipe-demo');link.remove(); };
}
