import { expect, test } from "bun:test";

import { createCanvasPerformanceScenario } from "@/lib/canvas/canvas-performance-scenario";

test("creates an isolated representative 500-node canvas scenario", () => {
    const scenario = createCanvasPerformanceScenario();

    expect(scenario.nodes).toHaveLength(500);
    expect(scenario.connections).toHaveLength(1000);
    expect(new Set(scenario.nodes.map((node) => node.id)).size).toBe(500);
    expect(new Set(scenario.nodes.map((node) => node.type)).size).toBe(5);
    expect(scenario.connections.every((connection) => scenario.nodes.some((node) => node.id === connection.fromNodeId))).toBe(true);
    expect(scenario.connections.every((connection) => scenario.nodes.some((node) => node.id === connection.toNodeId))).toBe(true);
});

test("creates a bounded 5000-node stress scenario with the same graph density", () => {
    const scenario = createCanvasPerformanceScenario(5000);

    expect(scenario.nodes).toHaveLength(5000);
    expect(scenario.connections).toHaveLength(10000);
    expect(new Set(scenario.connections.map((connection) => connection.id)).size).toBe(10000);
    expect(scenario.connections.every((connection) => connection.fromNodeId !== connection.toNodeId)).toBe(true);
});

test("can include browser-decodable image content without mutating the default fixture", () => {
    const defaultScenario = createCanvasPerformanceScenario(500);
    const mediaScenario = createCanvasPerformanceScenario(500, { includeImageContent: true });
    const defaultImage = defaultScenario.nodes.find((node) => node.type === "image");
    const image = mediaScenario.nodes.find((node) => node.type === "image");

    expect(defaultImage?.metadata?.content).toBeUndefined();
    expect(image?.metadata?.content).toStartWith("data:image/svg+xml");
    expect(mediaScenario.nodes.filter((node) => node.type === "image").every((node) => Boolean(node.metadata?.content))).toBe(true);
});
