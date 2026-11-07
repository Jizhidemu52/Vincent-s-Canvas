import { resolve } from "node:path";
import { defineConfig, mergeConfig } from "vite";
import base from "./vite.config";
export default defineConfig(environment => mergeConfig(base(environment), { cacheDir: resolve(import.meta.dirname, "../../output/chat-agent-iteration/vite-cache") }));
