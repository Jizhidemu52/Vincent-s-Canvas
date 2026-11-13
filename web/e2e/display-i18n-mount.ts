// Native-browser component mounting uses Vite's dependency resolution, not a
// bare module specifier inside page.evaluate. This helper is test-only.
import React from "react";
export { React };
export { createRoot } from "react-dom/client";
