import common from "./en-common";
import canvas from "./en-canvas";
import creative from "./en-creative";
import management from "./en-management";
import controls from "./en-controls";
import conversationImages from "./en-conversation-images";
import interaction from "./en-ux";
import canvasLibrary from "./en-canvas-library";
import videoMotion from "./en-video-motion";
import uiPlan from "./en-ui-plan";

// Shared navigation/action terminology wins over domain-specific duplicates.
export default { ...canvas, ...creative, ...management, ...controls, ...common, ...conversationImages, ...interaction, ...canvasLibrary, ...videoMotion, ...uiPlan } satisfies Record<string, string>;
