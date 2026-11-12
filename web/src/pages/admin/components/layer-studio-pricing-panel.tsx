import type { ServerModel, ServerProvider } from "@/services/api/model-configuration";

// Kept as an inert compatibility export. Existing server configuration is untouched.
export function LayerStudioPricingPanel(_props: { models: ServerModel[]; providers: ServerProvider[]; loading: boolean }) {
    return null;
}
