import type { ReactElement } from "react";

export type ReferencePickerItem = { id: string; title: string; image: string; storageKey?: string; serverAssetId?: string; width?: number; height?: number; kind?: string };
export type ReferencePickerProps = {
    open: boolean;
    items?: ReferencePickerItem[];
    currentIds?: string[];
    onChoose?: (items: ReferencePickerItem[]) => void | Promise<void>;
    onClose?: () => void;
    max?: number;
    initialTab?: "canvas" | "assets";
    api?: { assets: (query: Record<string, string>) => Promise<{ assets: Array<{ id: string; kind: string; filename?: string; contentUrl: string }>; hasMore?: boolean; nextCursor?: string | null }> };
};

export function ReferencePicker(props: ReferencePickerProps): ReactElement;
