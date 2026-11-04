import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createCanvasExampleGraph } from "@/lib/canvas/canvas-example-graph";
import { canvasExampleLessons, canvasExampleNodePrefix } from "@/lib/canvas/canvas-example-lessons";
import { resolveImageWorkflow } from "@/lib/canvas/canvas-image-workflow";
import { getSharedConfigTargets } from "@/lib/canvas/canvas-shared-connections";
import { resolveSharedGenerationPlan } from "@/lib/canvas/canvas-shared-generation";
import { canvasExampleControlGuides, canvasExampleControlPrefix, canvasExampleControlSteps } from "@/lib/canvas/canvas-example-controls";
import { CANVAS_DOCUMENT_MAX_BYTES, parseCanvasDocumentWrite } from "../../server/src/canvas-document";
import { canvasExampleControlProof, canvasExamplePractices, canvasPracticeImage } from "@/lib/canvas/canvas-example-practices";

describe("independent design teaching canvas", () => {
    test("all practice screenshots and actual local outputs ship as static assets", () => {
        const files = [...Object.values(canvasExamplePractices).flatMap(item => [canvasPracticeImage(item.image), ...(item.resultImage ? [item.resultImage] : [])]), ...Object.values(canvasExampleControlProof).map(item => canvasPracticeImage(item.image))];
        for (const file of new Set(files)) expect(existsSync(resolve(import.meta.dirname, "../public", file.slice(1)))).toBe(true);
    });
    test("complete teaching board passes the real server persistence contract and size limit", () => {
        const document = { id: "teaching-contract", title: "教学画布", createdAt: "2026-11-03T00:00:00Z", updatedAt: "2026-11-03T00:00:00Z", ...createCanvasExampleGraph(), viewport: { x: 0, y: 0, k: 1 }, backgroundMode: "dots", showImageInfo: false, chatSessions: [], activeChatId: null };
        const body = { baseRevision: 0, document };
        expect(Buffer.byteLength(JSON.stringify(body), "utf8")).toBeLessThan(CANVAS_DOCUMENT_MAX_BYTES);
        const parsed = parseCanvasDocumentWrite(document.id, body);
        expect(parsed.document?.nodes).toHaveLength(document.nodes.length);
        expect(parsed.assetIds).toEqual([]);
    });
    test("covers ten real-operation lessons and all six categories with separated case and practice areas", () => {
        const graph = createCanvasExampleGraph();
        expect(canvasExampleLessons).toHaveLength(10);
        expect(new Set(canvasExampleLessons.map(lesson => lesson.product)).size).toBe(6);
        for (const lesson of canvasExampleLessons) {
            const cases = graph.nodes.filter(node => node.id.startsWith(canvasExampleNodePrefix(lesson.id, "case")));
            const practice = graph.nodes.filter(node => node.id.startsWith(canvasExampleNodePrefix(lesson.id, "practice")));
            const recorded = canvasExamplePractices[lesson.id];
            expect(cases).toHaveLength(recorded.resultImage ? 6 : 4);
            expect(practice.length).toBeGreaterThanOrEqual(3);
            const explanation = cases.find(node => node.title.includes("实操简注"))!;
            expect(explanation.metadata?.content).toContain(recorded.annotation);
            expect(explanation.metadata?.content).toContain(recorded.evidence);
            expect(explanation.metadata?.content).toContain(lesson.location);
            expect(cases.some(node => node.metadata?.content === canvasPracticeImage(recorded.image))).toBe(true);
        }
        expect(JSON.stringify(graph)).not.toContain("蝴蝶结");
        expect(JSON.stringify(graph)).not.toContain("design-workbench/assets/garment.png");
    });

    test("comparison boards are locked, unwired teaching images, not generation inputs or recorded results", () => {
        const graph = createCanvasExampleGraph();
        const boards = graph.nodes.filter(node => node.type === "image" && node.id.includes("-case-"));
        expect(boards).toHaveLength(25);
        for (const board of boards) {
            expect(board.metadata?.locked).toBe(true);
            expect(graph.connections.some(edge => edge.fromNodeId === board.id || edge.toNodeId === board.id)).toBe(false);
        }
        const connectedImages = graph.nodes.filter(node => node.type === "image" && graph.connections.some(edge => edge.fromNodeId === node.id));
        expect(connectedImages.length).toBeGreaterThanOrEqual(6);
        expect(connectedImages.every(node => node.metadata?.content?.endsWith("-source.webp"))).toBe(true);
    });

    test("all nodes and workflow steps start idle with no fake task, session, asset, or result identities", () => {
        const graph = createCanvasExampleGraph();
        for (const node of graph.nodes) {
            expect(node.metadata?.status).toBe("idle");
            for (const key of ["sourceTaskId", "imageTask", "mediaTask", "videoTaskId", "generationRecord", "generationOrigin", "imageAgent", "serverAssetId", "storageKey"]) expect(node.metadata).not.toHaveProperty(key);
            if (node.type === "video" || node.type === "audio") expect(node.metadata?.content).toBeUndefined();
            if (node.type === "config") {
                expect(node.metadata?.model).toBeUndefined();
                expect(node.metadata?.count).toBe(1);
            }
        }
        for (const group of graph.groups) {
            if (!group.imageSequence) continue;
            expect(group.imageSequence.status).toBe("idle");
            expect(group.imageSequence.steps.every(step => step.status === "idle" && !step.outputNodeId)).toBe(true);
        }
    });

    test("multi-reference, per-image, and serial cases use actual distinct graph contracts", () => {
        const graph = createCanvasExampleGraph();
        const combined = graph.nodes.find(node => node.type === "config" && node.id.startsWith(canvasExampleNodePrefix("config", "practice")))!;
        const batch = graph.nodes.find(node => node.type === "config" && node.id.startsWith(canvasExampleNodePrefix("batch", "practice")))!;
        const combinedInputs = graph.connections.filter(edge => edge.toNodeId === combined.id);
        expect(combined.metadata?.configImageInputMode).toBe("combined");
        expect(combinedInputs).toHaveLength(2);
        for (const edge of combinedInputs) expect(combined.metadata?.composerContent).toContain(`@[node:${edge.fromNodeId}]`);
        expect(batch.metadata?.configImageInputMode).toBe("per-image");
        expect(graph.connections.filter(edge => edge.toNodeId === batch.id)).toHaveLength(3);
        expect(batch.metadata?.composerContent).toContain("图片1");
        expect(batch.metadata?.composerContent).not.toContain("@[node:");
        const sequence = graph.groups.find(group => group.imageSequence)!.imageSequence!;
        expect(sequence.steps).toHaveLength(2);
        expect(resolveImageWorkflow(graph, sequence.steps[0]!.configNodeId)).toEqual({ sourceNodeId: sequence.sourceNodeId, steps: sequence.steps.map(({ configNodeId, inputConfigId }) => ({ configNodeId, ...(inputConfigId ? { inputConfigId } : {}) })) });
    });

    test("fresh calls have independent ids, valid edges and groups, and no shared mutable node data", () => {
        const first = createCanvasExampleGraph(), second = createCanvasExampleGraph();
        const firstIds = new Set(first.nodes.map(node => node.id));
        expect(firstIds.size).toBe(first.nodes.length);
        expect(second.nodes.some(node => firstIds.has(node.id))).toBe(false);
        expect(new Set(first.connections.map(edge => edge.id)).size).toBe(first.connections.length);
        expect(first.connections.every(edge => firstIds.has(edge.fromNodeId) && firstIds.has(edge.toNodeId))).toBe(true);
        expect(first.groups.every(group => group.nodeIds.every(id => firstIds.has(id)))).toBe(true);
        const previous = second.nodes[0]!.metadata!.content;
        first.nodes[0]!.metadata!.content = "changed in one new project";
        expect(second.nodes[0]!.metadata!.content).toBe(previous);
    });

    test("every indexed control has honest proof status, matched screenshots only when verified, and a valid practice destination", () => {
        const graph = createCanvasExampleGraph();
        expect(new Set(canvasExampleControlGuides.map(guide => guide.id)).size).toBe(canvasExampleControlGuides.length);
        expect(new Set(canvasExampleControlSteps.map(item => item.key)).size).toBe(canvasExampleControlSteps.length);
        for (const guide of canvasExampleControlGuides) {
            expect(guide.id).toMatch(/^[a-z][a-z0-9-]+$/);
            expect(guide.id).not.toContain("--");
            expect(guide.steps.length).toBeGreaterThan(0);
            const practice = graph.nodes.filter(node => node.id.startsWith(canvasExampleNodePrefix(guide.lessonId, guide.practiceArea || "practice")));
            expect(practice.length).toBeGreaterThan(0);
        }
        for (const { key, guide, step } of canvasExampleControlSteps) {
            const card = graph.nodes.filter(node => node.id.startsWith(canvasExampleControlPrefix(key)));
            const proof = canvasExampleControlProof[key];
            expect(card).toHaveLength(proof ? 2 : 1);
            const picture = card.find(node => node.type === "image")!;
            const text = card.find(node => node.type === "text")!;
            if (proof) {
                expect(picture.metadata?.locked).toBe(true);
                expect(picture.metadata?.content).toBe(canvasPracticeImage(proof.image));
                expect(text.metadata?.content).toContain(proof.evidence);
                if (proof.annotation) expect(text.metadata?.content).toContain(proof.annotation);
            } else {
                expect(picture).toBeUndefined();
                expect(text.metadata?.content).toContain("用法说明 · 未逐项实测");
            }
            for (const value of [step.control, guide.prepare, step.action, step.result]) {
                expect(value.trim().length).toBeGreaterThan(0);
                expect(text.metadata?.content).toContain(value);
            }
            expect(graph.connections.some(edge => card.some(node => node.id === edge.fromNodeId || node.id === edge.toNodeId))).toBe(false);
        }
        for (const key of Object.keys(canvasExampleControlProof)) expect(canvasExampleControlSteps.some(item => item.key === key)).toBe(true);
    });

    test("all seven copy-history controls and single-node deletion have distinct operation captures and matching notes", () => {
        const keys = [...canvasExampleControlSteps.filter(item => item.guide.id === "shell-copy-history").map(item => item.key), "shell-delete--0"];
        expect(keys).toHaveLength(8);
        expect(new Set(keys.map(key => canvasExampleControlProof[key]?.image)).size).toBe(8);
        for (const key of keys) {
            expect(canvasExampleControlProof[key]?.image).toMatch(/^copy-history-/);
            expect(canvasExampleControlProof[key]?.annotation?.length).toBeGreaterThan(20);
        }
        expect(Object.keys(canvasExampleControlProof)).toHaveLength(50);
        expect(canvasExampleControlSteps.filter(item => !canvasExampleControlProof[item.key])).toHaveLength(650);
    });

    test("group operations and arrangement controls have 23 matching local-operation captures", () => {
        const keys = [
            ...[0, 1, 2, 4, 5].map(index => `shell-group-create--${index}`),
            ...Array.from({ length: 7 }, (_, index) => `shell-group-manage--${index}`),
            ...Array.from({ length: 6 }, (_, index) => `shell-arrange-align--${index}`),
            ...Array.from({ length: 5 }, (_, index) => `shell-arrange-spacing--${index}`),
        ];
        expect(keys).toHaveLength(23);
        expect(new Set(keys.map(key => canvasExampleControlProof[key]?.image)).size).toBe(23);
        for (const key of keys) {
            expect(canvasExampleControlProof[key]?.image).toMatch(/^(group|arrange)-/);
            expect(canvasExampleControlProof[key]?.annotation?.length).toBeGreaterThan(20);
        }
        expect(canvasExampleControlProof["shell-arrange-spacing--0"]?.annotation).toContain("未覆盖保留组内部布局分支");
    });

    test("comparison practice uses two distinct static images without fake lineage or a pre-existing group", () => {
        const graph = createCanvasExampleGraph();
        const images = graph.nodes.filter(node => node.type === "image" && node.id.startsWith(canvasExampleNodePrefix("compare", "practice")));
        expect(images).toHaveLength(2);
        expect(new Set(images.map(node => node.metadata?.content)).size).toBe(2);
        expect(graph.groups.some(group => images.some(node => group.nodeIds.includes(node.id)))).toBe(false);
        expect(images.every(node => !node.metadata?.generationOrigin && !node.metadata?.generationRecord && !node.metadata?.sourceTaskId)).toBe(true);
    });

    test("shared targets and one-image variants are independent editable graphs, not serial or mixed-reference tasks", () => {
        const graph = createCanvasExampleGraph();
        const shared = graph.nodes.find(node => node.type === "config" && node.id.startsWith(canvasExampleNodePrefix("batch", "shared")))!;
        const targets = getSharedConfigTargets(shared.id, graph.nodes, graph.connections);
        expect(targets).toHaveLength(3);
        expect(graph.connections.some(edge => edge.toNodeId === shared.id)).toBe(false);
        for (const target of targets) {
            const plan = resolveSharedGenerationPlan(target.id, shared.id, graph);
            expect(plan.context.referenceImages).toHaveLength(1);
            expect(plan.context.referenceImages[0]!.dataUrl).toBe(target.metadata!.content);
            expect(plan.prompt).toContain("图片1");
        }
        const branches = graph.nodes.filter(node => node.id.startsWith(canvasExampleNodePrefix("connections", "branches")));
        const source = branches.find(node => node.type === "image")!;
        const configs = branches.filter(node => node.type === "config");
        expect(configs).toHaveLength(3);
        for (const config of configs) {
            const inputs = graph.connections.filter(edge => edge.toNodeId === config.id);
            expect(inputs).toHaveLength(1);
            expect(inputs[0]!.fromNodeId).toBe(source.id);
            expect(inputs[0]!.kind).toBeUndefined();
            expect(config.metadata!.composerContent).toContain(`@[node:${source.id}]`);
        }
    });
});
