export type TryoutColor = { name: string; hex: string; library?: string; code?: string; part?: string };
export type TryoutMeta = {
    version: 1; rootNodeId: string; sourceNodeId: string;
    picked?: boolean; color?: TryoutColor; material?: { name: string; presetId?: string; assetId?: string };
    model?: { name: string; presetId?: string; assetId?: string };
    products?: string[];
    quickTaskId?: string;
    timing?: { droppedAt: number; submittedAt?: number; finishedAt?: number; shownAt?: number };
} & ({kind:"original"; tier?:never; prompt?:never} | {kind:"color" | "material" | "wear"; tier:"quick"|"hd"; prompt:string});

export type TryoutBoardCell = { styleNodeId: string; wearNodeIds: string[]; label: string; color?: TryoutColor };
export type TryoutBoardOptions = { columns: 2 | 3 | 4 | 5 | 6; orientation: "landscape" | "portrait"; showWear: boolean; showCode: boolean };
