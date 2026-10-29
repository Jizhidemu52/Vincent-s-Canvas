import common from "./en-common";
import canvas from "./en-canvas";
import creative from "./en-creative";
import management from "./en-management";
import controls from "./en-controls";
import conversationImages from "./en-conversation-images";

// Shared navigation/action terminology wins over domain-specific duplicates.
export default { ...canvas, ...creative, ...management, ...controls, ...common, ...conversationImages } satisfies Record<string, string>;
