import { FlaskConical } from "lucide-react";
import { Button } from "antd";
import { useEffect, useState } from "react";

import { getDemoAccounts, type DemoLoginAccount } from "@/services/api/auth";

export function DemoAccountList({ portal, onSelect }: { portal: "designer" | "admin"; onSelect: (account: DemoLoginAccount) => void }) {
    const [accounts, setAccounts] = useState<DemoLoginAccount[]>([]);

    useEffect(() => {
        getDemoAccounts().then((result) => setAccounts(result.accounts.filter((account) => account.portal === portal))).catch(() => setAccounts([]));
    }, [portal]);

    if (!accounts.length) return null;
    return (
        <section className="rounded-md border border-orange-200 bg-orange-50 p-3 text-orange-950">
            <div className="flex items-center gap-2 text-xs font-black"><FlaskConical className="size-4" />本地测试账号</div>
            <div className="mt-2 grid gap-2">
                {accounts.map((account) => (
                    <Button key={`${account.portal}:${account.identifier}`} className="!h-auto !justify-start !px-3 !py-2 !text-left" onClick={() => onSelect(account)}>
                        <span className="min-w-0">
                            <span className="block text-xs font-bold">{account.label}</span>
                            <span className="block break-all font-mono text-xs text-stone-500">{account.identifier} / {account.password}</span>
                        </span>
                    </Button>
                ))}
            </div>
            <p className="mb-0 mt-2 text-xs leading-5 text-orange-800">点击账号会自动填入；此区域只在本地演示服务运行时出现。</p>
        </section>
    );
}
