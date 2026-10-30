import { useUserStore } from "@/stores/use-user-store";
import { isCanvasPerformanceModeEnabled } from "./canvas-performance-scenario-mode";

export function useCanvasDiagnosticsEnabled() {
    const admin = useUserStore(state => state.status === "authenticated" && state.user?.role === "super_admin");
    return admin || isCanvasPerformanceModeEnabled(import.meta.env.DEV, import.meta.env.VITE_ENABLE_CANVAS_PERFORMANCE_SCENARIO === "true", typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("perf"));
}
