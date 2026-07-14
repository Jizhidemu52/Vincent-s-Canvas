import { lazy, Suspense, type ComponentType, type LazyExoticComponent } from "react";
import { createBrowserRouter, Outlet } from "react-router-dom";

import UserLayout from "@/layouts/user-layout";
import { AuthGate } from "@/components/auth/auth-gate";
import { ModuleGate } from "@/components/auth/module-gate";
import type { ModuleKey } from "@/services/api/modules";

const AdminPage = lazy(() => import("@/pages/admin"));
const AdminLoginPage = lazy(() => import("@/pages/admin/login"));
const AssetsPage = lazy(() => import("@/pages/assets"));
const CanvasPage = lazy(() => import("@/pages/canvas"));
const CanvasProjectPage = lazy(() => import("@/pages/canvas/project"));
const ChangePasswordPage = lazy(() => import("@/pages/change-password"));
const HomePage = lazy(() => import("@/pages/home"));
const ImagePage = lazy(() => import("@/pages/image"));
const LoginPage = lazy(() => import("@/pages/login"));
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
    return tool === "detail-enhance" || tool === "image-edit" || tool === "angle-control" || tool === "seamless-stitch" ? tool : "image";
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
            { path: "/login", element: routeElement(LoginPage) },
            { path: "/change-password", element: protectedRoute(ChangePasswordPage) },
            { path: "/image", element: moduleRoute(ImagePage, imageModule) },
            { path: "/video", element: moduleRoute(VideoPage, "video") },
            { path: "/assets", element: moduleRoute(AssetsPage, "assets") },
            { path: "/team", element: moduleRoute(TeamPage, "team") },
            { path: "/prompts", element: moduleRoute(PromptsPage, "prompts") },
            { path: "/my-prompts", element: moduleRoute(MyPromptsPage, "prompts") },
            { path: "/admin", element: protectedRoute(AdminPage, true) },
            { path: "/admin/login", element: routeElement(AdminLoginPage) },
            { path: "/canvas", element: moduleRoute(CanvasPage, canvasModule) },
            { path: "/canvas/:id", element: moduleRoute(CanvasProjectPage, "canvas") },
        ],
    },
    { path: "*", element: routeElement(NotFound) },
]);
