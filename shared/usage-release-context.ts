/** Context only: publication is not deployment or proof that an employee loaded a version. */
export type UsageReleaseAnnotation = { version: string; title: string; publishedAt: string; day: string };
export type UsageReleaseContext = {
    source: "release_notes.published_at";
    scope: "global_publications_in_selected_dates";
    observedAt: string;
    limit: 200;
    truncated: boolean;
    releases: UsageReleaseAnnotation[];
};
export type UsageControlDaily = {
    source: "usage_events";
    mappingSource: "existing_control_keys_and_labels";
    totalControls: number;
    limit: 20;
    truncated: boolean;
    missingControlRecords: number;
    series: Array<{
        boardKey: string;
        boardLabel: string;
        controlKey: string;
        label: string;
        total: number;
        daily: Array<{ day: string; count: number }>;
    }>;
};
