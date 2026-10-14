import { setupConnectedFixture, setupAllNodePanels } from './browser-scenarios.ts';

const labels = {
 'original-app-mount':'原版页面与真实编辑器挂载',
 'original-ui-run-ordered-multi-inputs':'原版运行按钮、多输入排序与预览传递',
 'port-contract':'类型端口与精确类型优先匹配',
 'diamond-join':'分支汇合与依赖执行顺序',
 'downstream-reuse-and-staleness':'过期上游结果仍被下游使用',
 'rerun-and-no-result-cache':'新一轮执行没有请求级缓存',
 'failure-state-and-sibling':'失败状态与兄弟请求晚写',
 'stop-does-not-cancel-inflight':'停止后在途请求继续回写',
 'overlap-late-write':'旧请求结果覆盖新请求结果',
 'failure-rerun':'失败后手动重跑恢复',
 'iterator-last-only':'逐项迭代、仅末项传给下游',
 'capture-real-editor':'真实画布截取并送入生成节点',
};
const box = document.createElement('div'); box.id = 'lab-controls';
box.style.cssText = 'position:fixed;z-index:9999;top:8px;left:500px;right:170px;display:flex;justify-content:center;gap:8px;pointer-events:none;font:12px system-ui';
document.body.append(box);
const status = document.createElement('span');
status.style.cssText = 'color:#354b37;background:#f1f5ed;padding:7px 9px;border-radius:5px;pointer-events:auto';
status.textContent = '原始源码实验 · 仅模型接口为本地模拟'; box.append(status);
function button(label, action) {
 const btn = document.createElement('button'); btn.textContent = label;
 btn.style.cssText = 'border:1px solid #c3cec2;border-radius:5px;padding:6px 10px;background:white;color:#233c2a;cursor:pointer;pointer-events:auto';
 btn.onclick = async () => { btn.disabled = true; try { await action(); } catch (error) { status.textContent = '操作失败，请查看实验日志'; console.error(error); } finally { btn.disabled = false; } }; box.append(btn);
}
button('清空并载入连线示例', async () => { await setupConnectedFixture(); status.textContent = '已载入示例：点击虚线区域左侧三角按钮运行'; });
button('查看全部节点', async () => { await setupAllNodePanels(); status.textContent = '已载入 17 类原始节点；滚轮缩放，拖动画布查看'; });
const report = document.createElement('section'); report.hidden = true;
report.style.cssText = 'position:fixed;z-index:10000;top:55px;right:180px;width:400px;max-height:75vh;overflow:auto;background:#fff;border:1px solid #ccd4c9;padding:16px;border-radius:9px;box-shadow:0 6px 28px #0002;font:13px/1.7 system-ui;color:#26352a';
document.body.append(report);
button('实测结果', async () => {
 if (!report.hidden) { report.hidden = true; return; }
 const data = await (await fetch('/__lab/results')).json(); report.replaceChildren();
 const heading = document.createElement('h3'); heading.textContent = '原始模块实测结果'; heading.style.margin = '0 0 8px'; report.append(heading);
 const intro = document.createElement('p'); intro.textContent = data.summary ? `${data.summary.scenarios} 个场景：${data.summary.passed} 项通过，${data.summary.observedGaps} 项缺口已复现，${data.summary.harnessFailures} 项测试器失败。真实模型调用 0 次。` : '尚未运行测试，请在实验目录运行 npm test。'; report.append(intro);
 for (const item of data.results || []) {
  const line = document.createElement('div'); line.textContent = `${item.status === 'PASS' ? '通过' : item.status === 'OBSERVED_GAP' ? '已复现缺口' : '测试器失败'} · ${labels[item.name] || '实验场景'}`;
  line.style.color = item.status === 'OBSERVED_GAP' ? '#9b531b' : '#264a33'; report.append(line);
 }
 const footer = document.createElement('p'); footer.textContent = '未验证真实模型质量、云端部署和生产许可。原始日志及完整边界记录见交付目录。'; report.append(footer); report.hidden = false;
});
const license = document.createElement('div'); license.textContent = '生产使用需取得许可（下方为 SDK 原始声明）';
license.style.cssText = 'position:fixed;right:8px;bottom:42px;z-index:9999;color:#63675f;font:10px system-ui;pointer-events:none'; document.body.append(license);

window.addEventListener('unhandledrejection', () => { status.textContent = '执行失败；可修改输入后从节点重新运行。详情见实验日志。'; });
