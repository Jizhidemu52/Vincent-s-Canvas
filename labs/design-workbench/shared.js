const DB_NAME = 'vincent-design-lab-v1';
let databasePromise;

function database() {
    if (!databasePromise) databasePromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, 1);
        request.onupgradeneeded = () => request.result.createObjectStore('projects');
        request.onerror = () => { databasePromise = undefined; reject(request.error || new Error('浏览器本地存储不可用')); };
        request.onblocked = () => { databasePromise = undefined; reject(new Error('请关闭此试用版的旧标签页后重试保存')); };
        request.onsuccess = () => {
            request.result.onversionchange = () => { request.result.close(); databasePromise = undefined; };
            resolve(request.result);
        };
    });
    return databasePromise;
}

export async function saveProject(key, value) {
    const db = await database();
    await new Promise((resolve, reject) => {
        const transaction = db.transaction('projects', 'readwrite');
        transaction.objectStore('projects').put(value, key);
        transaction.oncomplete = resolve;
        transaction.onerror = transaction.onabort = () => reject(transaction.error || new Error('本地保存失败，未覆盖当前编辑'));
    });
}

export async function loadProject(key) {
    const db = await database();
    return new Promise((resolve, reject) => {
        const request = db.transaction('projects', 'readonly').objectStore('projects').get(key);
        request.onsuccess = () => resolve(request.result ?? null);
        request.onerror = () => reject(request.error || new Error('本地方案读取失败'));
    });
}

export function loadImage(src) {
    return new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => {
            if (!image.naturalWidth || !image.naturalHeight || image.naturalWidth * image.naturalHeight > 40_000_000) return reject(new Error('图片尺寸无效或超过 4000 万像素，请先缩小图片'));
            resolve(image);
        };
        image.onerror = () => reject(new Error('无法读取图片，请使用有效的 PNG、JPG 或 WebP'));
        image.src = src;
    });
}

export async function readImageFile(file) {
    if (!file) throw new Error('没有选择文件');
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) throw new Error('请选择 PNG、JPG 或 WebP 图片；透明图案建议使用 PNG');
    if (file.size > 15 * 1024 * 1024) throw new Error('图片超过 15 MB，请先缩小后再试');
    const result = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error('文件读取失败'));
        reader.onload = () => resolve(reader.result);
        reader.readAsDataURL(file);
    });
    await loadImage(result);
    return result;
}

export function downloadBlob(blob, name) {
    if (!(blob instanceof Blob) || blob.size === 0) throw new Error('导出内容为空，请重试');
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url; anchor.download = name; anchor.hidden = true;
    document.body.append(anchor); anchor.click(); anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

let toastTimer;
export function notify(message, tone = 'success') {
    if (tone === 'error') {
        const raw = String(message || '');
        if (/Unexpected token|Unexpected end|JSON Parse error|Expected property name|JSON\.parse/i.test(raw)) message = '工程文件格式不正确，请选择有效的 JSON 文件。';
        else if (/quota|disk space|storage.*full/i.test(raw)) message = '浏览器本地存储空间不足，请先导出工程文件。';
        else if (!/[\u3400-\u9fff]/.test(raw)) message = '操作未完成，请检查输入文件或刷新后重试。';
    }
    let toast = document.querySelector('#lab-toast');
    if (!toast) { toast = document.createElement('div'); toast.id = 'lab-toast'; document.body.append(toast); }
    toast.setAttribute('role', tone === 'error' ? 'alert' : 'status');
    toast.className = `toast ${tone}`; toast.textContent = message; toast.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { toast.hidden = true; }, tone === 'error' ? 6500 : 3500);
}
