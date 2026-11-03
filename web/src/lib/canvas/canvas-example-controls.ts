import { canvasExampleLessons, type CanvasExampleLessonId } from "./canvas-example-lessons";
import { canvasShellControlGuides } from "./canvas-example-controls-shell";
import { canvasDetailControlGuides } from "./canvas-example-controls-detail";

/** Each step teaches one actual control. These descriptions never run the described action. */
export type CanvasControlGuide = {
    id: string;
    lessonId: CanvasExampleLessonId;
    title: string;
    scenario: string;
    prepare: string;
    steps: Array<{ control: string; action: string; result: string }>;
    caution: string;
    practiceArea?: "practice" | "branches" | "shared";
};

const lessonOrder = new Map(canvasExampleLessons.map((lesson, index) => [lesson.id, index]));
export const canvasExampleControlGuides: CanvasControlGuide[] = [...canvasShellControlGuides, ...canvasDetailControlGuides]
    .sort((a, b) => (lessonOrder.get(a.lessonId) || 0) - (lessonOrder.get(b.lessonId) || 0));
export const canvasExampleControlSteps = canvasExampleControlGuides.flatMap(guide => guide.steps.map((step, index) => ({
    key: `${guide.id}--${index}`, guide, step,
})));
export const canvasExampleControlPrefix = (key: string) => `canvas-example-control-${key}--`;
