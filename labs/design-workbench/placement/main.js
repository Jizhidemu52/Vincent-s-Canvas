import { mountPlacement } from '/product/placement/main.js';
import { createProductServices } from '/product-services.js';

export async function mountDemo(root) {
    root.classList.add('local-design-workbench');
    const services = createProductServices(root);
    const stop = await mountPlacement(root, services);
    return () => { services.dispose(); stop(); };
}
