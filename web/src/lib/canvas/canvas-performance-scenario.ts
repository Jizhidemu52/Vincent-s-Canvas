import { NODE_DEFAULT_SIZE } from "@/constant/canvas";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData, type ViewportTransform } from "@/types/canvas";

export type CanvasPerformanceScenario = {
    nodes: CanvasNodeData[];
    connections: CanvasConnection[];
    viewport: ViewportTransform;
};

export type CanvasPerformanceScenarioOptions = {
    includeImageContent?: boolean;
};

export type CanvasPerformanceScenarioNodeCount = 500 | 2000 | 5000;

const DEFAULT_FIXTURE_NODE_COUNT: CanvasPerformanceScenarioNodeCount = 500;
const FIXTURE_COLUMNS = 25;
const fixtureNodeTypes = [
    CanvasNodeType.Text,
    CanvasNodeType.Text,
    CanvasNodeType.Text,
    CanvasNodeType.Image,
    CanvasNodeType.Config,
    CanvasNodeType.Video,
    CanvasNodeType.Audio,
] as const;
const PERFORMANCE_IMAGE_DATA_URL = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 420"><rect width="320" height="420" fill="#fffaf5"/><rect x="38" y="35" width="244" height="350" rx="24" fill="#f97316" opacity=".16"/><path d="M102 126c24-32 92-32 116 0l20 184H82z" fill="#ea580c"/><path d="M112 122c17 18 79 18 96 0" fill="none" stroke="#fff7ed" stroke-width="12" stroke-linecap="round"/></svg>')}`;

function createFixtureNode(index: number, options: CanvasPerformanceScenarioOptions): CanvasNodeData {
    const type = fixtureNodeTypes[index % fixtureNodeTypes.length];
    const spec = NODE_DEFAULT_SIZE[type];
    const column = index % FIXTURE_COLUMNS;
    const row = Math.floor(index / FIXTURE_COLUMNS);

    return {
        id: `performance-node-${index}`,
        type,
        title: `${spec.title} ${index + 1}`,
        position: { x: column * 520, y: row * 360 },
        width: spec.width,
        height: spec.height,
        metadata:
            type === CanvasNodeType.Text
                ? { content: `Performance scenario text node ${index + 1}`, fontSize: 14, status: "idle" }
                : type === CanvasNodeType.Config
                    ? { generationMode: "image", model: "gpt-image-2", size: "1:1", quality: "1k", count: 1, status: "idle" }
                    : type === CanvasNodeType.Image && options.includeImageContent
                        ? { status: "idle", content: PERFORMANCE_IMAGE_DATA_URL, mimeType: "image/svg+xml" }
                        : { status: "idle" },
    };
}

/**
 * A transient workload used only by the local performance route. Callers
 * receive fresh arrays, so it cannot mutate a project. Image content is opt
 * in because it intentionally exercises browser image decoding.
 */
export function createCanvasPerformanceScenario(nodeCount: CanvasPerformanceScenarioNodeCount = DEFAULT_FIXTURE_NODE_COUNT, options: CanvasPerformanceScenarioOptions = {}): CanvasPerformanceScenario {
    const nodes = Array.from({ length: nodeCount }, (_, index) => createFixtureNode(index, options));
    const connections = nodes.flatMap<CanvasConnection>((node, index) => [
        { id: `performance-link-horizontal-${index}`, fromNodeId: node.id, toNodeId: nodes[(index + 1) % nodes.length]!.id },
        { id: `performance-link-vertical-${index}`, fromNodeId: node.id, toNodeId: nodes[(index + FIXTURE_COLUMNS) % nodes.length]!.id },
    ]);

    return {
        nodes,
        connections,
        viewport: { x: 80, y: 80, k: 1 },
    };
}
