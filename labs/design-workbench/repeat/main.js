import { mountRepeat } from '/product/repeat/main.js';
import { createProductServices } from '/product-services.js';

export async function mountDemo(root) {
    root.classList.add('local-design-workbench');
    const services = createProductServices(root);
    const stop = await mountRepeat(root, services);
    return () => { services.dispose(); stop(); };
}
