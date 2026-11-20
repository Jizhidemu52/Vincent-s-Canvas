export const designDiscussionRequest = {
    requestId: "design-wait-request-1", toolKey: "canvas-design-chat", tools: [], toolChoice: "none", webSearch: false,
    claude: { stream: false, thinking: false, maxTokens: 8192 }, gemini: { maxOutputTokens: 8192 },
    input: [
        { role: "system", content: "仅讨论服装设计，以 JSON 返回 message、questions、proposals、sources 和 trendStatus；不生成图片、不调用工具。" },
        { role: "user", content: "只讨论针织衫，保留六颗纽扣与两个口袋，不生成图片。" },
    ],
};
