import { lazy, Suspense, type ComponentType, type LazyExoticComponent } from "react";
import { createBrowserRouter, Outlet } from "react-router-dom";

import UserLayout from "@/layouts/user-layout";
import { AuthGate } from "@/components/auth/auth-gate";

const AdminPage = lazy(() => import("@/pages/admin"));
const AdminLoginPage = lazy(() => import("@/pages/admin/login"));
const AssetsPage = lazy(() => import("@/pages/assets"));
const CanvasPage = lazy(() => import("@/pages/canvas"));
const CanvasProjectPage = lazy(() => import("@/pages/canvas/project"));
const ChangePasswordPage = lazy(() => import("@/pages/change-password"));
const HomePage = lazy(() => import("@/pages/home"));
const ImagePage = lazy(() => import("@/pages/image"));
const LoginPage = lazy(() => import("@/pages/login"));
const NotFound = lazy(() => import("@/pages/not-found"));
const PromptsPage = lazy(() => import("@/pages/prompts"));
const SetupMfaPage = lazy(() => import("@/pages/setup-mfa"));
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
            { path: "/setup-mfa", element: protectedRoute(SetupMfaPage, true) },
            { path: "/image", element: protectedRoute(ImagePage) },
            { path: "/video", element: protectedRoute(VideoPage) },
            { path: "/assets", element: protectedRoute(AssetsPage) },
            { path: "/prompts", element: protectedRoute(PromptsPage) },
            { path: "/admin", element: protectedRoute(AdminPage, true) },
            { path: "/admin/login", element: routeElement(AdminLoginPage) },
            { path: "/canvas", element: protectedRoute(CanvasPage) },
            { path: "/canvas/:id", element: protectedRoute(CanvasProjectPage) },
        ],
    },
    { path: "*", element: routeElement(NotFound) },
]);
