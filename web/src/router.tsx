import { lazy, Suspense, type ComponentType, type LazyExoticComponent } from "react";
import { createBrowserRouter, Outlet } from "react-router-dom";

import UserLayout from "@/layouts/user-layout";

const AdminPage = lazy(() => import("@/pages/admin"));
const AdminLoginPage = lazy(() => import("@/pages/admin/login"));
const AssetsPage = lazy(() => import("@/pages/assets"));
const CanvasPage = lazy(() => import("@/pages/canvas"));
const CanvasProjectPage = lazy(() => import("@/pages/canvas/project"));
const HomePage = lazy(() => import("@/pages/home"));
const ImagePage = lazy(() => import("@/pages/image"));
const LoginPage = lazy(() => import("@/pages/login"));
const NotFound = lazy(() => import("@/pages/not-found"));
const PromptsPage = lazy(() => import("@/pages/prompts"));
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

export const router = createBrowserRouter([
    {
        element: (
            <UserLayout>
                <Outlet />
            </UserLayout>
        ),
        children: [
            { path: "/", element: routeElement(HomePage) },
            { path: "/login", element: routeElement(LoginPage) },
            { path: "/image", element: routeElement(ImagePage) },
            { path: "/video", element: routeElement(VideoPage) },
            { path: "/assets", element: routeElement(AssetsPage) },
            { path: "/prompts", element: routeElement(PromptsPage) },
            { path: "/admin", element: routeElement(AdminPage) },
            { path: "/admin/login", element: routeElement(AdminLoginPage) },
            { path: "/canvas", element: routeElement(CanvasPage) },
            { path: "/canvas/:id", element: routeElement(CanvasProjectPage) },
        ],
    },
    { path: "*", element: routeElement(NotFound) },
]);
