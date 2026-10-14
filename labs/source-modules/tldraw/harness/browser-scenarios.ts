import { createShapeId } from 'tldraw';
import { ExecutionGraph } from '../upstream/templates/image-pipeline/src/execution/ExecutionGraph';
import { executionState, startExecution, stopExecution } from '../upstream/templates/image-pipeline/src/execution/executionState';
import { getNodeDefinitions, getNodeDefinition } from '../upstream/templates/image-pipeline/src/nodes/nodeTypes';
import { getNodePorts, getNodePortConnections, getNodeInputPortValues, getNodeOutputPortInfo } from '../upstream/templates/image-pipeline/src/nodes/nodePorts';
import { createOrUpdateConnectionBinding } from '../upstream/templates/image-pipeline/src/connection/ConnectionBindingUtil';
import { arePortDataTypesCompatible, findFirstCompatiblePort } from '../upstream/templates/image-pipeline/src/ports/portCompatibility';
import { updateNode } from '../upstream/templates/image-pipeline/src/nodes/types/shared';

declare global { interface Window { editor: any; labFixture: any; } }
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
function check(condition: unknown, message: string) { if (!condition) throw new Error(message); }
function equal(a: any, b: any, message: string) { check(JSON.stringify(a) === JSON.stringify(b), `${message}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`); }
const editor = () => window.editor;
let labels = new Map<string, string>();
let trace: any[] = [];
let removeTrace: (() => void) | null = null;

export async function control(plans: any[] = []) {
  await fetch('/__lab/control', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ plans }) });
}
export async function apiState() { return await (await fetch('/__lab/state')).json(); }
async function waitRequest(count = 1) { for (let i = 0; i < 120; i++) { if ((await apiState()).requests.length >= count) return; await delay(10); } throw new Error('Timed out waiting for local model request'); }

function reset() {
  const e = editor(); stopExecution(e); removeTrace?.();
  e.deleteShapes(e.getCurrentPageShapes().map((s: any) => s.id));
  labels = new Map(); trace = [];
  removeTrace = e.sideEffects.registerAfterChangeHandler('shape', (before: any, after: any) => {
    if (after.type !== 'node') return;
    if (before.props.isOutOfDate !== after.props.isOutOfDate) trace.push({ label: labels.get(after.id), isOutOfDate: after.props.isOutOfDate, at: performance.now() });
  });
}
function add(type: string, label: string, props: any = {}, x = 100, y = 100) {
  const e = editor(), id = createShapeId();
  const defaults = getNodeDefinition(e, type as any).getDefault();
  e.createShape({ id, type: 'node', x, y, props: { node: { ...defaults, ...props }, isOutOfDate: false } });
  labels.set(id, label); return id;
}
function connect(from: string, output: string, to: string, input: string, order?: number) {
  const e = editor(), id = createShapeId();
  e.createShape({ id, type: 'connection', x: 0, y: 0 });
  createOrUpdateConnectionBinding(e, id, from, { terminal: 'start', portId: output });
  createOrUpdateConnectionBinding(e, id, to, { terminal: 'end', portId: input, ...(order == null ? {} : { order }) });
  return id;
}
const node = (id: string) => editor().getShape(id).props.node;
function finishTrace() { return trace.map(t => ({ ...t, at: Math.round(t.at * 10) / 10 })); }
function statusOf(graph: ExecutionGraph, ids: Record<string, string>) { return Object.fromEntries(Object.entries(ids).map(([label, id]) => [label, graph.getNodeStatus(id)])); }
function graph(ids: string[]) { return new ExecutionGraph(editor(), new Set(ids) as any); }

export async function setupConnectedFixture() {
  await control(); reset();
  const model = add('model', 'model', { provider: 'flux', modelId: 'flux-dev' }, 60, 50);
  const fabric = add('prompt', 'fabric', { text: '奶油色亚麻面料，保留自然织纹' }, 60, 290);
  const garment = add('prompt', 'garment', { text: '简约夏季衬衫，保持原有廓形' }, 60, 490);
  const generate = add('generate', 'generate', { seed: 12 }, 440, 80);
  const preview = add('preview', 'preview', {}, 810, 80);
  connect(model, 'output', generate, 'model');
  // Intentionally reverse binding creation order. The original order field must win.
  connect(garment, 'output', generate, 'prompt', 20);
  connect(fabric, 'output', generate, 'prompt', 10);
  connect(generate, 'output', preview, 'image');
  editor().zoomToFit({ inset: 260, animation: { duration: 0 } });
  const fixture = { model, fabric, garment, generate, preview };
  window.labFixture = fixture; return fixture;
}

export async function verifyConnectedUiRun() {
  const ids = window.labFixture, e = editor(), state = await apiState();
  equal(state.requests.length, 1, 'UI-triggered pipeline must call original API client exactly once');
  equal(state.requests[0].body.prompt, '奶油色亚麻面料，保留自然织纹, 简约夏季衬衫，保持原有廓形', 'multi input order');
  equal(state.requests[0].body.model, 'flux:flux-dev', 'model output serialization');
  check(node(ids.generate).lastResultUrl, 'Original generate node must persist backend result');
  equal(node(ids.preview).lastImageUrl, node(ids.generate).lastResultUrl, 'Preview result propagation');
  equal(executionState.get(e).runningGraph, null, 'Original startExecution must clear running graph');
  const startGenerate = trace.findIndex(t => t.label === 'generate' && t.isOutOfDate === true);
  for (const label of ['model', 'fabric', 'garment']) check(trace.findIndex(t => t.label === label && t.isOutOfDate === false) < startGenerate, `${label} must finish before generate starts`);
  return { inputPortValues: getNodeInputPortValues(e, ids.generate), api: state.requests, trace: finishTrace(), preview: node(ids.preview) };
}

export async function setupAllNodePanels() {
  await control(); reset();
  const types = Object.keys(getNodeDefinitions(editor()));
  types.forEach((type, index) => add(type, type, type === 'iterator' ? { items: '奶油色\n鼠尾草绿\n天蓝色' } : {}, (index % 5) * 340, Math.floor(index / 5) * 650));
  editor().zoomToFit({ inset: 200, animation: { duration: 0 } });
  return types;
}

export async function runCase(name: string) {
  const e = editor();
  if (name === 'port-contract') {
    await control(); reset();
    const id = add('generate', 'generate'); const ports = getNodePorts(e, id);
    equal(arePortDataTypesCompatible('image', 'text'), false, 'incompatible typed ports');
    equal(arePortDataTypesCompatible('image', 'any'), true, 'any port support');
    equal(findFirstCompatiblePort([{ id: 'generic', terminal: 'end', dataType: 'any' }, { id: 'prompt', terminal: 'end', dataType: 'text' }] as any, 'end', 'text')?.id, 'prompt', 'exact match preference');
    equal(ports.prompt.multi, true, 'Generate prompt is multi-value');
    equal(Object.keys(getNodeDefinitions(e)).length, 17, 'actual source node count');
    return { ports, registeredNodeTypes: Object.keys(getNodeDefinitions(e)) };
  }
  if (name === 'diamond-join') {
    await control(); reset();
    const prompt = add('prompt', 'source', { text: 'linen blouse' });
    const router = add('router', 'router', { outputCount: 2 }, 400, 100);
    const a = add('prompt_concat', 'branch-a', { separator: 'space' }, 700, 40);
    const b = add('prompt_concat', 'branch-b', { separator: 'space' }, 700, 400);
    const pa = add('prompt', 'prefix-a', { text: 'front view' }, 400, 500);
    const pb = add('prompt', 'prefix-b', { text: 'back view' }, 400, 720);
    const generate = add('generate', 'join', { seed: 1 }, 1000, 100);
    connect(prompt, 'output', router, 'input'); connect(router, 'out_0', a, 'main'); connect(router, 'out_1', b, 'main');
    connect(pa, 'output', a, 'prefix'); connect(pb, 'output', b, 'prefix'); connect(a, 'output', generate, 'prompt', 1); connect(b, 'output', generate, 'prompt', 2);
    const execution = graph([prompt, pa, pb]); await execution.execute();
    const state = await apiState(); equal(state.requests.length, 1, 'diamond join executes once');
    equal(state.requests[0].body.prompt, 'front view linen blouse, back view linen blouse', 'branches merge in ordered multi input');
    equal(execution.getNodeStatus(generate as any), 'executed', 'join executed');
    return { requests: state.requests, trace: finishTrace(), status: statusOf(execution, { source: prompt, router, branchA: a, branchB: b, join: generate }) };
  }
  if (name === 'downstream-reuse-and-staleness') {
    await control(); reset();
    const prompt = add('prompt', 'prompt', { text: 'old design' });
    const generate = add('generate', 'generate', {}, 400, 100), preview = add('preview', 'preview', {}, 750, 100);
    connect(prompt, 'output', generate, 'prompt'); connect(generate, 'output', preview, 'image');
    const first = graph([prompt]); await first.execute(); const cached = node(generate).lastResultUrl;
    await control(); const onlyPreview = graph([preview]); await onlyPreview.execute();
    equal((await apiState()).requests.length, 0, 'downstream-only run uses saved upstream output'); equal(node(preview).lastImageUrl, cached, 'cached output reused');
    updateNode(e, e.getShape(prompt), n => ({ ...n, text: 'new design needing regeneration' }), true);
    const infoBefore = getNodeOutputPortInfo(e, generate).output;
    equal(infoBefore.isOutOfDate, true, 'original output information reports stale upstream');
    const staleRun = graph([preview]); await staleRun.execute();
    equal(node(preview).lastImageUrl, cached, 'current implementation still uses stale cached output');
    equal((await apiState()).requests.length, 0, 'stale input does not automatically re-execute upstream');
    return { cached, infoBefore, previewAfter: node(preview), requests: (await apiState()).requests, gap: 'ExecutionGraph external dependency read ignores isOutOfDate. Downstream-only run silently consumes stale saved result.' };
  }
  if (name === 'rerun-and-no-result-cache') {
    await control(); reset(); const generate = add('generate', 'generate');
    const first = graph([generate]); await first.execute();
    let sameGraphError = ''; try { await first.execute(); } catch (error: any) { sameGraphError = error.message; }
    check(sameGraphError.includes('only be executed once'), 'same graph instance should reject reuse');
    const second = graph([generate]); await second.execute();
    const state = await apiState(); equal(state.requests.length, 2, 'fresh graph re-executes unchanged model node');
    return { sameGraphError, requests: state.requests, gap: 'Persisted lastResultUrl is a display/downstream value, not a request-key cache. New graph with unchanged Generate inputs calls backend again.' };
  }
  if (name === 'failure-state-and-sibling') {
    await control([{ matchPrompt: 'FAIL', status: 500, delayMs: 30 }, { matchPrompt: 'SLOW', delayMs: 160 }]); reset();
    const pa = add('prompt', 'input-fail', { text: 'FAIL branch' }), pb = add('prompt', 'input-slow', { text: 'SLOW branch' }, 100, 400);
    const a = add('generate', 'failed', {}, 400, 100), b = add('generate', 'sibling', {}, 400, 500), sink = add('preview', 'sibling-preview', {}, 750, 500);
    connect(pa, 'output', a, 'prompt'); connect(pb, 'output', b, 'prompt'); connect(b, 'output', sink, 'image');
    const execution = graph([a, b]); let error = '';
    try { await execution.execute(); } catch (e: any) { error = e.message; }
    check(error.includes('INTENTIONAL_LOCAL_FAILURE'), 'HTTP failure propagated');
    const atReject = statusOf(execution, { failed: a, sibling: b, preview: sink });
    await delay(230); const afterSettle = statusOf(execution, { failed: a, sibling: b, preview: sink });
    equal(afterSettle.failed, 'executing', 'source implementation leaves failed node status executing');
    equal(afterSettle.sibling, 'executed', 'inflight sibling can finish after rejection');
    equal(afterSettle.preview, 'waiting', 'sibling downstream is stopped with whole graph');
    equal(e.getShape(a).props.isOutOfDate, true, 'failed shape remains out of date');
    check(node(b).lastResultUrl, 'sibling writes result after first branch fails');
    return { error, atReject, afterSettle, requests: (await apiState()).requests, trace: finishTrace(), gap: 'No failed terminal node state; first rejection stops graph scheduling but does not cancel sibling network request or late write.' };
  }
  if (name === 'stop-does-not-cancel-inflight') {
    await control([{ delayMs: 180 }]); reset();
    const generate = add('generate', 'generate'), preview = add('preview', 'preview', {}, 440, 100); connect(generate, 'output', preview, 'image');
    const running = startExecution(e, new Set([generate]) as any); await waitRequest();
    stopExecution(e); equal(executionState.get(e).runningGraph, null, 'stop clears visible execution state');
    const resultAtStop = node(generate).lastResultUrl; equal(resultAtStop, null, 'request still in flight when stopped');
    await running;
    check(node(generate).lastResultUrl, 'inflight request still writes after stop'); equal(node(preview).lastImageUrl, null, 'downstream not run after stop');
    return { resultAtStop, resultAfterStop: node(generate).lastResultUrl, previewAfter: node(preview), requests: (await apiState()).requests, trace: finishTrace(), gap: 'Stop only prevents new scheduling; fetch has no AbortSignal and already-running Generate still updates its saved result.' };
  }
  if (name === 'overlap-late-write') {
    await control([{ matchPrompt: 'OLD', delayMs: 220 }, { matchPrompt: 'NEW', delayMs: 30 }]); reset();
    const prompt = add('prompt', 'prompt', { text: 'OLD request' }), generate = add('generate', 'generate', {}, 430, 100); connect(prompt, 'output', generate, 'prompt');
    const oldRun = startExecution(e, new Set([generate]) as any); await waitRequest();
    updateNode(e, e.getShape(prompt), n => ({ ...n, text: 'NEW request' }), false);
    const newRun = startExecution(e, new Set([generate]) as any); await newRun;
    const afterNew = node(generate).lastResultUrl; await oldRun; const final = node(generate).lastResultUrl;
    const state = await apiState(); equal(state.requests.length, 2, 'two genuine original API requests');
    check(afterNew.endsWith(`${state.requests[1].id}.svg`), 'new request initially wins');
    check(final.endsWith(`${state.requests[0].id}.svg`), 'older stopped request overwrites newer saved result');
    return { afterNew, final, requests: state.requests, gap: 'New start stops old graph scheduling but has no generation/revision guard: delayed OLD result overwrites NEW result.' };
  }
  if (name === 'failure-rerun') {
    await control([{ status: 503 }]); reset(); const generate = add('generate', 'generate'), preview = add('preview', 'preview', {}, 440, 100); connect(generate, 'output', preview, 'image');
    let initialFailure = ''; try { await startExecution(e, new Set([generate]) as any); } catch (error: any) { initialFailure = error.message; }
    check(initialFailure.includes('INTENTIONAL_LOCAL_FAILURE'), 'failure reached caller'); equal(executionState.get(e).runningGraph, null, 'failed run clears wrapper state');
    await startExecution(e, new Set([generate]) as any);
    const state = await apiState(); equal(state.requests.length, 2, 'manual new run performs retry'); equal(node(generate).lastResultUrl, node(preview).lastImageUrl, 'new run can recover');
    return { initialFailure, requests: state.requests, finalNode: node(generate), note: 'Recovery works by explicit new run, not automatic retry or resume.' };
  }
  if (name === 'iterator-last-only') {
    await control(); reset();
    const source = add('prompt', 'template', { text: 'linen blouse' }), iterator = add('iterator', 'iterator', { items: 'cream\nsage\n' }, 450, 100), preview = add('preview', 'preview', {}, 850, 100);
    connect(source, 'output', iterator, 'template'); connect(iterator, 'output', preview, 'image');
    await graph([source]).execute(); const state = await apiState();
    equal(state.requests.map((r: any) => r.body.prompt), ['linen blouse, cream', 'linen blouse, sage'], 'iterator makes sequential item requests');
    equal(node(iterator).completedCount, 2, 'iteration progress saved'); equal(node(preview).lastImageUrl, node(iterator).lastResultUrl, 'only final image reaches sink');
    const previewStarts = trace.filter(t => t.label === 'preview' && t.isOutOfDate).length; equal(previewStarts, 1, 'downstream is not expanded per iteration');
    return { requests: state.requests, iterator: node(iterator), previewStarts, note: 'Iterator is sequential generation with last-result output, not a gallery/batch-fanout executor.' };
  }
  if (name === 'capture-real-editor') {
    await control(); reset();
    const capture = add('capture', 'capture', { w: 400, h: 300 }, 0, 0);
    const excludedNode = add('prompt', 'excluded-node', { text: 'DO NOT CAPTURE ME' }, 30, 20);
    const geo = createShapeId(); e.createShape({ id: geo, type: 'geo', x: 95, y: 140, props: { w: 150, h: 90, fill: 'solid', color: 'red', geo: 'rectangle' } });
    const generate = add('generate', 'generate', { seed: 7 }, 500, 20); connect(capture, 'output', generate, 'image');
    const preview = add('preview', 'preview', {}, 900, 20); connect(generate, 'output', preview, 'image');
    e.zoomToFit({ animation: { duration: 0 } });
    await graph([capture]).execute();
    const url = node(capture).lastCaptureUrl; check(url.startsWith('data:image/png;base64,'), 'Capture uses real Editor.toImage PNG');
    const image = new Image(); image.src = url; await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
    const ctx = canvas.getContext('2d')!; ctx.drawImage(image, 0, 0); const data = ctx.getImageData(0, 0, image.width, image.height).data;
    let redPixels = 0, darkPixels = 0;
    for (let i = 0; i < data.length; i += 4) { if (data[i] > 120 && data[i] > data[i + 1] * 1.25 && data[i] > data[i + 2] * 1.15) redPixels++; if (data[i] < 80 && data[i + 1] < 80 && data[i + 2] < 80) darkPixels++; }
    check(redPixels > 1000, 'real captured artwork pixels must be present');
    const state = await apiState(); equal(state.requests[0].body.referenceImageUrl, url, 'Capture output feeds original Generate referenceImageUrl');
    equal(node(preview).lastImageUrl, node(generate).lastResultUrl, 'capture path reaches preview');
    return { captureUrl: url, pngWidth: image.width, pngHeight: image.height, redPixels, darkPixels, excludedNode, capturedGeo: geo, api: state.requests.map((r: any) => ({ ...r, body: { ...r.body, referenceImageUrl: `[PNG data URL ${r.body.referenceImageUrl.length} chars]` } })), note: 'Original CaptureNode.execute + real Editor.toImage; only model endpoint is stubbed.' };
  }
  throw new Error(`Unknown case: ${name}`);
}
