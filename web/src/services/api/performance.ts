export const designDirectionLabels = {
  pattern: "花型图案",
  apparel: "服装款式",
  product: "商品图",
  image_edit: "图片编辑",
  detail_enhance: "细节增强",
  angle_control: "角度控制",
  batch_edit: "批量改图",
  seamless_stitch: "无缝拼接",
} as const;

export type DesignDirection = keyof typeof designDirectionLabels;
export type PerformancePreset = "today" | "week" | "month" | "custom";
export type PerformanceFilters = {
  preset: PerformancePreset;
  from?: string;
  to?: string;
  departmentId?: string;
  groupId?: string;
  userId?: string;
};

type Rate = number | null;
export type PerformanceDashboard = {
  period: Omit<PerformanceFilters, "preset">;
  metrics: {
    requestedOutputs: number; validOutputs: number; naturalDailyAverage: number; activeDailyAverage: number | null;
    successCount: number; failedCount: number; cancelledCount: number; successRate: Rate; batchCompletionRate: Rate;
    averageDurationSeconds: number | null; reworkRate: Rate; onTimeDeliveryRate: Rate; totalCredits: number;
    totalRmbCost: number; averageCreditsPerOutput: number | null; averageCostPerOutput: number | null;
    averageCostPerAdopted: number | null; downloadRate: Rate; averageUsabilityScore: number | null;
  };
  trend: Array<{ date: string; outputs: number; success: number; failed: number; credits: number }>;
  directions: Array<{ direction: DesignDirection; count: number; rate: Rate }>;
  funnel: Array<{ stage: "generated" | "candidate" | "reused" | "downloaded" | "adopted" | "delivered"; count: number; rate: Rate }>;
  designers: Array<{ userId: string; userName: string; departmentName: string; groupName: string | null; outputs: number;
    successRate: Rate; downloadRate: Rate; reuseRate: Rate; adoptionRate: Rate; deliveryRate: Rate;
    usabilityScore: number | null; credits: number; rmbCost: number; topDirection: DesignDirection | "unclassified" | null }>;
  failureReasons: Array<{ reason: string; count: number }>;
  tasks: Array<{ id: string; userName: string; operationType: string; modelName: string | null; prompt: string; status: string;
    credits: number; rmbCost: number; queuedAt: string; completedAt: string | null; failureReason: string | null }>;
  assets: Array<{ id: string; userName: string; departmentName: string | null; groupName: string | null; projectName: string | null;
    operationType: string | null; modelName: string | null; prompt: string; primaryDirection: DesignDirection | null;
    secondaryDirections: DesignDirection[]; adminDirectionTags: string[]; directionRuleVersion: string | null;
    createdAt: string; resultStatus: string; usabilityScore: number }>;
  options: {
    users: Array<{ value: string; label: string; departmentId: string | null; groupId: string | null }>;
    departments: Array<{ value: string; label: string }>;
    groups: Array<{ value: string; label: string; departmentId: string }>;
  };
  comparisons: null | {
    previousMonth: PerformanceDashboard["designers"][number] | null;
    sameGroupAverage: PerformanceDashboard["designers"][number] | null;
    departmentAverage: PerformanceDashboard["designers"][number] | null;
  };
};

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { credentials: "include", headers: { "content-type": "application/json", ...init?.headers }, ...init });
  const payload = await response.json().catch(() => ({})) as T & { message?: string };
  if (!response.ok) throw new Error(payload.message || "设计效能数据加载失败");
  return payload;
}

export function getPerformanceDashboard(filters: PerformanceFilters) {
  const search = new URLSearchParams();
  Object.entries(filters).forEach(([key, value]) => { if (value) search.set(key, value); });
  return request<PerformanceDashboard>(`/api/performance?${search.toString()}`);
}

export function updateAssetDirection(assetId: string, input: { primaryDirection: DesignDirection; secondaryDirections: DesignDirection[]; adminTags: string[] }) {
  return request(`/api/performance/assets/${assetId}/direction`, { method: "PATCH", body: JSON.stringify(input) });
}
