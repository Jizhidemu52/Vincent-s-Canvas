import { lazy, Suspense, type ComponentType, type LazyExoticComponent } from "react";
import { createBrowserRouter, Navigate, Outlet, useLocation } from "react-router-dom";

import UserLayout from "@/layouts/user-layout";
import { AuthGate } from "@/components/auth/auth-gate";
import { ModuleGate } from "@/components/auth/module-gate";
import { standaloneEdition } from "@/lib/standalone-edition";
import { deploymentFeatures } from "@/lib/deployment-features";
import type { ModuleKey } from "@/services/api/modules";
import { standaloneCreativePresetIds } from "@/lib/creative-presets";
import { retiredWorkbenchName } from "@/lib/retired-workbenches";

const AdminPage = lazy(() => import("@/pages/admin"));
const AdminPromptRecipesPage = lazy(() => import("@/pages/admin/prompt-recipes"));
const AdminLoginPage = lazy(() => import("@/pages/admin/login"));
const LoginPage = lazy(() => import("@/pages/login"));
const AssetsPage = lazy(() => import("@/pages/assets"));
const ReferenceImportPage = lazy(() => import("@/pages/reference-import"));
const CanvasPage = lazy(() => import("@/pages/canvas"));
const CanvasProjectPage = lazy(() => import("@/pages/canvas/project"));
const DesignLibraryPage = lazy(() => import("@/pages/design-library"));
const ChatPage = lazy(() => import("@/pages/chat"));
const CreativePage = lazy(() => import("@/pages/creative"));
const CreativeScenePage = lazy(() => import("@/pages/creative/scene"));
const PatternPlacementPage = lazy(() => import("@/pages/design-workbench/placement"));
const PatternRepeatPage = lazy(() => import("@/pages/design-workbench/repeat"));
const RetiredWorkbenchPage = lazy(() => import("@/pages/retired-workbench"));
const ChangePasswordPage = lazy(() => import("@/pages/change-password"));
const HomePage = lazy(() => import("@/pages/home"));
const ImagePage = lazy(() => import("@/pages/image"));
const LayerStudioPage = lazy(() => import("@/pages/layer-studio"));
const MyPromptsPage = lazy(() => import("@/pages/my-prompts"));
const NotFound = lazy(() => import("@/pages/not-found"));
const PromptsPage = lazy(() => import("@/pages/prompts"));
const TeamPage = lazy(() => import("@/pages/team"));
const VideoPage = lazy(() => import("@/pages/video"));

type RoutePage = LazyExoticComponent<ComponentType>;

function RouteFallback() {
    return (
        <div className="flex h-full items-center justify-center bg-background text-sm text-muted-foreground">
            <div className="size-5 animate-spin rounded-full border-2 border-orange-200 border-t-orange-600" />
        </div>
    );
}

function routeElement(Page: RoutePage) {
    return (
        <Suspense fallback={<RouteFallback />}>
            <Page />
        </Suspense>
    );
}

function protectedRoute(Page: RoutePage, admin = false) {
    return <AuthGate admin={admin}>{routeElement(Page)}</AuthGate>;
}

function moduleRoute(Page: RoutePage, moduleKey: ModuleKey | ((search: string) => ModuleKey)) {
    return <AuthGate><ModuleGate moduleKey={moduleKey}>{routeElement(Page)}</ModuleGate></AuthGate>;
}

function imageModule(search: string): ModuleKey {
    const tool = new URLSearchParams(search).get("tool");
    if (tool === "remove-background" || tool === "item-extract") return "image-edit";
    if (tool === "hd-upscale") return "detail-enhance";
    return tool === "image-edit" || tool === "seamless-stitch" || tool === "midjourney-blend" ? tool : "image";
}

function ImageToolRoute() {
    const { pathname, search } = useLocation();
    return retiredWorkbenchName(pathname, search) ? routeElement(RetiredWorkbenchPage) : <ModuleGate moduleKey={imageModule}>{routeElement(ImagePage)}</ModuleGate>;
}

function canvasModule(search: string): ModuleKey {
    return new URLSearchParams(search).get("tool") === "gpt-chat" ? "gpt-chat" : "canvas";
}

export const router = createBrowserRouter([
    {
        element: (
            <UserLayout>
                <Outlet />
            </UserLayout>
        ),
        children: [
            { path: "/", element: protectedRoute(HomePage) },
            { path: "/creative", element: moduleRoute(CreativePage, "creative") },
            { path: "/creative/pattern-placement", element: moduleRoute(PatternPlacementPage, "pattern-placement") },
            { path: "/creative/pattern-repeat", element: moduleRoute(PatternRepeatPage, "pattern-repeat") },
            ...["/creative/series-recipe", "/series-recipe", "/detail-enhance", "/angle-control"].map(path => ({ path, element: protectedRoute(RetiredWorkbenchPage) })),
            ...standaloneCreativePresetIds.map(id => ({ path: `/${id}`, element: protectedRoute(CreativeScenePage) })),
            { path: "/creative/:presetId", element: protectedRoute(CreativeScenePage) },
            { path: "/login", element: !standaloneEdition && deploymentFeatures.authenticationEnabled && !deploymentFeatures.oaLoginEnabled ? routeElement(LoginPage) : <Navigate to="/" replace /> },
            { path: "/image", element: <AuthGate><ImageToolRoute /></AuthGate> },
            // Keep saved originals/editing accessible when new generation is disabled.
            { path: "/layer-studio", element: protectedRoute(LayerStudioPage) },
            { path: "/remove-background", element: moduleRoute(ImagePage, "image-edit") },
            { path: "/hd-upscale", element: moduleRoute(ImagePage, "detail-enhance") },
            { path: "/item-extract", element: moduleRoute(ImagePage, "image-edit") },
            { path: "/video", element: moduleRoute(VideoPage, "video") },
            { path: "/assets", element: moduleRoute(AssetsPage, "assets") },
            { path: "/reference-import", element: moduleRoute(ReferenceImportPage, "reference-import") },
            { path: "/team", element: moduleRoute(TeamPage, "team") },
            { path: "/prompts", element: moduleRoute(PromptsPage, "prompts") },
            { path: "/my-prompts", element: moduleRoute(MyPromptsPage, "prompts") },
            { path: "/design-library", element: moduleRoute(DesignLibraryPage, "design-library") },
            ...(!standaloneEdition ? [
                { path: "/admin", element: protectedRoute(AdminPage, true) },
                { path: "/admin/prompt-recipes", element: protectedRoute(AdminPromptRecipesPage, true) },
                { path: "/admin/design-library", element: protectedRoute(DesignLibraryPage, true) },
                // Hiding role entrances must not lock operators out of maintenance.
                { path: "/admin/login", element: routeElement(AdminLoginPage) },
                { path: "/change-password", element: <AuthGate passwordChange>{routeElement(ChangePasswordPage)}</AuthGate> },
            ] : []),
            { path: "/canvas", element: moduleRoute(CanvasPage, canvasModule) },
            { path: "/chat", element: moduleRoute(ChatPage, "gpt-chat") },
            { path: "/canvas/:id", element: moduleRoute(CanvasProjectPage, "canvas") },
        ],
    },
    { path: "*", element: routeElement(NotFound) },
]);
