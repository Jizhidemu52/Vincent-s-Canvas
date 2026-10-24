import { loadImage, readImageFile, downloadBlob, saveProject, loadProject, notify } from '/shared.js';

// The experiment owns its storage adapter, never a second editor implementation.
export function normalizeLabProject(input) {
    if (!input || typeof input !== 'object') return input;
    if (Array.isArray(input)) return input.map(normalizeLabProject);
    return Object.fromEntries(Object.entries(input).map(([key, value]) => [key,
        key === 'src' && typeof value === 'string' && /^\/assets\/(garment\.png|flower\.svg|leaf\.svg|brand\.svg)$/.test(value) ? `/design-workbench${value}` :
        key === 'type' && value === 'garment-placement-demo' ? 'garment-pattern-placement' : normalizeLabProject(value),
    ]));
}

export function createProductServices() {
    const controller = new AbortController();
    let dirty = false;
    const warn = (event) => { if (dirty) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', warn);
    const originalKey = key => key === 'garment-pattern-placement-v1' ? 'garment-placement-demo-v1' : key;
    const assertActive = () => { if (controller.signal.aborted) throw new Error('工作台已关闭'); };
    return {
        signal: controller.signal, loadImage, readImageFile, downloadBlob, notify,
        setDirty(value) { dirty = value; },
        async saveProject(key, value) { assertActive(); await saveProject(originalKey(key), value); assertActive(); },
        async loadProject(key) { assertActive(); const result = await loadProject(originalKey(key)); assertActive(); return normalizeLabProject(result); },
        dispose() { controller.abort(); window.removeEventListener('beforeunload', warn); },
    };
}
