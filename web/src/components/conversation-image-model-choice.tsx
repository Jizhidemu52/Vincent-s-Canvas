import { useEffect, useState } from "react";
import { ChevronDown } from "lucide-react";
import { getBusinessConfig } from "@/services/api/business-config";

type Choice = { id: string; name: string };

export function ConversationImageModelChoice({ value, onChange, disabled }: {
    value?: Choice;
    onChange: (value?: Choice) => void;
    disabled: boolean;
}) {
    const [open, setOpen] = useState(false);
    const [choices, setChoices] = useState<Choice[] | null>(null);
    const [failed, setFailed] = useState(false);
    useEffect(() => {
        if (!open || choices) return;
        let current = true;
        setFailed(false);
        void getBusinessConfig().then(config => {
            if (current) setChoices(config.models.filter(model => model.conversationImage).map(({ id, name }) => ({ id, name })));
        }).catch(() => { if (current) setFailed(true); });
        return () => { current = false; };
    }, [open, choices]);
    return <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <button type="button" disabled={disabled} aria-expanded={open} onClick={() => setOpen(!open)}
            className="inline-flex min-h-8 items-center gap-1 hover:text-foreground">
            生图模型：{value?.name || "默认"} <ChevronDown aria-hidden className="size-3" />
        </button>
        {open && <select aria-label="选择生图模型" disabled={disabled} value={value?.id || ""}
            className="max-w-full rounded border border-border bg-background px-2 py-1 text-foreground"
            onChange={event => { onChange(choices?.find(item => item.id === event.target.value)); setOpen(false); }}>
            <option value="">默认（跟随后台配置）</option>
            {value && !choices?.some(item => item.id === value.id) && <option value={value.id} disabled>{value.name}</option>}
            {choices?.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select>}
        {open && !choices && <span role="status">{failed ? "模型列表未读取，可收起后重试" : "读取可用模型…"}</span>}
    </div>;
}
