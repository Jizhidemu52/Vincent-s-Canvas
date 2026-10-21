import { lazy, Suspense, type ComponentType, type LazyExoticComponent } from "react";
import { createBrowserRouter, Navigate, Outlet } from "react-router-dom";

import UserLayout from "@/layouts/user-layout";
import { AuthGate } from "@/components/auth/auth-gate";
import { ModuleGate } from "@/components/auth/module-gate";
import { standaloneEdition } from "@/lib/standalone-edition";
import { deploymentFeatures } from "@/lib/deployment-features";
import type { ModuleKey } from "@/services/api/modules";

const AdminPage = lazy(() => import("@/pages/admin"));
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
const CreativeVectorPage = lazy(() => import("@/pages/creative/vector-workspace"));
const PatternLayersPage = lazy(() => import("@/pages/creative/pattern-layers"));
const PatternPlacementPage = lazy(() => import("@/pages/design-workbench/placement"));
const PatternRepeatPage = lazy(() => import("@/pages/design-workbench/repeat"));
const SeriesRecipePage = lazy(() => import("@/pages/design-workbench/recipe"));
const ChangePasswordPage = lazy(() => import("@/pages/change-password"));
const HomePage = lazy(() => import("@/pages/home"));
const ImagePage = lazy(() => import("@/pages/image"));
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
    return tool === "detail-enhance" || tool === "image-edit" || tool === "angle-control" || tool === "seamless-stitch" || tool === "midjourney-blend" ? tool : "image";
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
            { path: "/creative/series-recipe", element: moduleRoute(SeriesRecipePage, "series-recipe") },
            { path: "/creative/sketch-vectorization", element: moduleRoute(CreativeVectorPage, "creative-sketch-vectorization") },
            { path: "/creative/pattern-vectorization", element: moduleRoute(CreativeVectorPage, "creative-pattern-vectorization") },
            { path: "/creative/pattern-layers", element: moduleRoute(PatternLayersPage, "creative-pattern-layers") },
            { path: "/creative/:presetId", element: protectedRoute(CreativeScenePage) },
            { path: "/login", element: !standaloneEdition && deploymentFeatures.authenticationEnabled && !deploymentFeatures.oaLoginEnabled ? routeElement(LoginPage) : <Navigate to="/" replace /> },
            { path: "/image", element: moduleRoute(ImagePage, imageModule) },
            { path: "/video", element: moduleRoute(VideoPage, "video") },
            { path: "/assets", element: moduleRoute(AssetsPage, "assets") },
            { path: "/reference-import", element: moduleRoute(ReferenceImportPage, "reference-import") },
            { path: "/team", element: moduleRoute(TeamPage, "team") },
            { path: "/prompts", element: moduleRoute(PromptsPage, "prompts") },
            { path: "/my-prompts", element: moduleRoute(MyPromptsPage, "prompts") },
            { path: "/design-library", element: moduleRoute(DesignLibraryPage, "design-library") },
            ...(!standaloneEdition ? [
                { path: "/admin", element: protectedRoute(AdminPage, true) },
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
