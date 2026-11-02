import { resolve } from "node:path";
import { defineConfig, mergeConfig } from "vite";
import e2eConfig from "./vite.config";
export default defineConfig(environment => mergeConfig(e2eConfig(environment), { cacheDir: resolve(import.meta.dirname, "../../output/chat-agent-v518/vite-cache") }));
