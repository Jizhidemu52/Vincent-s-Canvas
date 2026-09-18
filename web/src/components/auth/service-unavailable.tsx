export function ServiceUnavailable({ onRetry }: { onRetry: () => void }) {
    return (
        <div role="alert" className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-background px-6 text-center text-foreground">
            <h1 className="text-xl font-semibold">暂时无法连接服务</h1>
            <p className="max-w-md text-sm text-muted-foreground">请确认画布服务已启动且网络连接正常，然后重试。</p>
            <button type="button" onClick={onRetry} className="rounded-lg bg-primary px-5 py-3 text-sm text-primary-foreground">重新连接</button>
        </div>
    );
}
