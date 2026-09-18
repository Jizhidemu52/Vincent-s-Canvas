export function CompanyOaEntry() {
    return (
        <main role="alert" className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-background px-6 text-center text-foreground">
            <h1 className="text-xl font-semibold">请从公司 OA 重新进入</h1>
            <p className="max-w-md text-sm leading-6 text-muted-foreground">当前无法确认员工身份，未打开任何员工画布。请回到企业微信中的公司 OA，再点击画布入口。</p>
            <button type="button" className="rounded-lg bg-primary px-5 py-3 text-sm text-primary-foreground" onClick={() => window.location.reload()}>重新检查连接</button>
        </main>
    );
}
