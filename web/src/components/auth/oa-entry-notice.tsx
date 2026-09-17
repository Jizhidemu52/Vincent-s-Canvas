import { OA_ENTRY_URL } from "@/lib/oa-login";

export function OaEntryNotice({ unavailable = false }: { unavailable?: boolean }) {
    return (
        <main className="flex h-full min-h-dvh flex-col items-center justify-center gap-4 bg-background px-6 text-center text-foreground">
            <h1 className="text-xl font-semibold">{unavailable ? "暂时无法连接登录服务" : "请从企业微信 OA 入口打开"}</h1>
            <p role="alert" className="max-w-md text-sm leading-6 text-muted-foreground">
                {unavailable ? "请稍后通过企业微信 OA 入口重新打开无线画布。" : "登录凭证缺失、已失效或会话已过期，请返回企业微信 OA，重新打开无线画布。"}
            </p>
            <a href={OA_ENTRY_URL} rel="noreferrer" className="rounded-lg bg-primary px-5 py-3 text-sm text-primary-foreground">返回企业微信 OA</a>
        </main>
    );
}
