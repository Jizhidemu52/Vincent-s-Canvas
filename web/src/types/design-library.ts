export type DesignLibraryStatus = "published" | "withdrawn" | "taken_down";
export type DesignLibraryAction = "view" | "download" | "reuse" | "prompt_copy";
export type DesignLibraryImage = {
    id: string;
    filename: string;
    mimeType: string;
    byteSize: number;
    width: number | null;
    height: number | null;
    contentUrl: string;
};
export type DesignLibraryEntry = {
    id: string;
    title: string;
    thought: string;
    prompt: string;
    tags: string[];
    author: { id: string; name: string; departmentId: string | null; departmentName: string | null };
    status: DesignLibraryStatus;
    createdAt: string;
    updatedAt: string;
    images: DesignLibraryImage[];
    canWithdraw: boolean;
    canModerate: boolean;
    canViewStats: boolean;
};
export type DesignLibraryPublishInput = {
    title: string;
    thought: string;
    prompt: string;
    tags: string[];
    assetIds: string[];
    requestId: string;
};
export type DesignLibraryMetric = { count: number; people: number };
export type DesignLibraryCounts = Record<DesignLibraryAction, DesignLibraryMetric>;
export type DesignLibraryStats = {
    entryId: string;
    totals: DesignLibraryCounts;
    images: { imageId: string; filename: string; counts: DesignLibraryCounts }[];
    activity: {
        id: string;
        action: "download" | "reuse";
        imageId: string | null;
        filename: string | null;
        actor: { id: string; name: string; departmentName: string | null };
        createdAt: string;
    }[];
    activityTotal: number;
    page: number;
    pageSize: number;
};
export type DesignLibraryList = { items: DesignLibraryEntry[]; total: number; page: number; pageSize: number };
export type DesignLibraryReceiptInput = { action: DesignLibraryAction; requestId: string; imageId?: string; reusedAssetId?: string };
export type DesignLibraryReuse = { assetId: string; image: DesignLibraryImage; source: { entryId: string; imageId: string; title: string; authorName: string } };
