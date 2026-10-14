import * as React from 'react';
import { createRoot } from 'react-dom/client';
import plugin from './sdk-source/plugins/canvas/sticky-note/dist/sticky-note.js';

// Import occurs before runtime injection, matching the original SDK lazy-loading contract.
const events = new EventTarget();
(globalThis as any).InfiniteCanvasRuntime = {
  React, jsx: React.createElement, Fragment: React.Fragment, version: 'isolated-test-host',
  emit: (name, payload) => events.dispatchEvent(new CustomEvent(name, { detail: payload })),
  on: (name, handler) => { const fn = e => handler(e.detail); events.addEventListener(name, fn); return () => events.removeEventListener(name, fn); },
};
const definition = plugin.nodes[0];
const Content = definition.Content;
function Host() {
  const [metadata, setMetadata] = React.useState(() => { try { return JSON.parse(localStorage.getItem('source-sdk-fixture') || 'null') || definition.defaultMetadata; } catch { return definition.defaultMetadata; } });
  const [mounted, setMounted] = React.useState(true);
  const [changes, setChanges] = React.useState(0);
  const ctx = { node: { id: 'fixture-note', type: definition.type, title: 'Source plugin', position: { x: 0, y: 0 }, ...definition.defaultSize, metadata }, updateMetadata(patch) { setMetadata(m => ({ ...m, ...patch })); setChanges(n => n + 1); }, isSelected: true, scale: 1 };
  return <main><h1>原仓库 SDK + 便签插件实测</h1><p>原插件与 SDK 未改写；此页面仅提供 React、节点数据和保存适配。不是完整无限画布。</p><div className="controls"><button onClick={() => localStorage.setItem('source-sdk-fixture', JSON.stringify(metadata))}>保存测试节点</button><button onClick={() => setMounted(v => !v)}>{mounted ? '卸载插件' : '重新挂载'}</button><button onClick={() => { setMetadata(definition.defaultMetadata); localStorage.removeItem('source-sdk-fixture'); }}>重置测试节点</button></div><section id="plugin-node">{mounted ? <Content ctx={ctx} /> : <p>插件已卸载</p>}</section><button id="outside">插件外部区域</button><h2>实际回写数据</h2><pre id="metadata">{JSON.stringify({ metadata, changes }, null, 2)}</pre><p>双击便签编辑、按 Esc 或点击外部退出；右上角圆点改色。本页无 AI 接口。</p></main>;
}
createRoot(document.getElementById('app')!).render(<Host />);
