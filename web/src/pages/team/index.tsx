import { displayNotice, useDisplayUiValue, useDisplayConfig  } from "@/hooks/use-display-text";
import { staticUiText } from "@/lib/static-ui-copy";
import { useUiText } from "@/lib/i18n";
import { adminLabel } from "@/pages/admin/admin-labels";
import { formatBeijingDateTime } from "@/lib/beijing-time";
import { Alert, App, Button, Empty, Skeleton, Table, Tag } from "antd";
import { CheckCircle2, Clock3, Download, Images, RefreshCw, RotateCcw, UsersRound, XCircle } from "lucide-react";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";

import { isFinancialAuditAction } from "@/lib/financial-presentation";
import { deploymentFeatures } from "@/lib/deployment-features";

import { exportTeamHistory, type TeamAuditLog, type TeamHistory, type TeamOverview } from "@/services/api/groups";
import { recordServerAssetEvent, type AssetEventType, type ServerAsset } from "@/services/api/server-assets";
import { useUserStore } from "@/stores/use-user-store";
import { useModuleStore } from "@/stores/use-module-store";
import { loadTeamOverview, nonFinancialTeamCsv } from "./team-overview";
import { WorkbenchImage } from "@/components/workbench-image";

const PerformanceDashboard = lazy(() => import("@/pages/performance/dashboard").then((module) => ({ default: module.PerformanceDashboard })));

const statusLabel: Record<string, string> = { unused: "未使用", candidate: "候选", project: "已入项目", editing: "继续编辑", downloaded: "已下载", adopted: "已采用", delivered: "已交付", pending: "待定", rejected: "废弃" };

export default function TeamPage() {
    const displayUi = useDisplayUiValue();
    const displayConfig = useDisplayConfig();
    const t = useUiText();
  const { message } = App.useApp();
  const user = useUserStore((state) => state.user);
  const [overview, setOverview] = useState<TeamOverview>();
  const [history, setHistory] = useState<TeamHistory[]>([]);
  const [auditLogs, setAuditLogs] = useState<TeamAuditLog[]>([]);
  const [assets, setAssets] = useState<ServerAsset[]>([]);
  const [assetTotal, setAssetTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [pendingAction, setPendingAction] = useState("");
  const pendingActionRef = useRef<object | null>(null);
  const actionScopeRef = useRef({ userId: user?.id, groupId: user?.groupId, active: true });
  if (actionScopeRef.current.userId !== user?.id || actionScopeRef.current.groupId !== user?.groupId) {
    actionScopeRef.current.active = false;
    actionScopeRef.current = { userId: user?.id, groupId: user?.groupId, active: true };
    pendingActionRef.current = null;
  }
  const actionScope = actionScopeRef.current;
  const isCurrentScope = () => {
    const current = useUserStore.getState().user;
    return actionScope.active && actionScopeRef.current === actionScope && current?.id === actionScope.userId && current?.groupId === actionScope.groupId;
  };
  const requestSequence = useRef(0);
  const isLeader = user?.groupRole === "leader";
  const performanceEnabled = useModuleStore((state) => state.flags.performance);

  const refresh = async (background = false) => {
    if (!deploymentFeatures.creditsEnabled || !user?.groupId) return;
    const sequence = ++requestSequence.current;
    if (!background) setLoading(true);
    try {
      const result = await loadTeamOverview(isLeader);
      if (sequence !== requestSequence.current) return;
      if (result.overview) setOverview(result.overview);
      if (result.history) setHistory(result.history);
      if (result.assets) setAssets(result.assets);
      if (result.assetTotal !== undefined) setAssetTotal(result.assetTotal);
      if (result.auditLogs) setAuditLogs(result.auditLogs);
      setLoadError(result.errors.join("；"));
    } catch (error) { if (sequence === requestSequence.current) setLoadError(error instanceof Error ? error.message : t("本组数据加载失败")); }
    finally { if (sequence === requestSequence.current) setLoading(false); }
  };
  useEffect(() => {
    setOverview(undefined); setHistory([]); setAssets([]); setAssetTotal(0); setAuditLogs([]); setLoadError("");
    setPendingAction("");
    void refresh();
    return () => { requestSequence.current++; };
  }, [user?.id, user?.groupId, user?.groupRole]);
  useEffect(() => { actionScope.active = true; return () => { actionScope.active = false; }; }, [actionScope]);

  const runAction = async (key: string, action: () => Promise<void>) => {
    if (!isCurrentScope() || pendingActionRef.current) return;
    const pending = {}; pendingActionRef.current = pending; setPendingAction(key);
    try { await action(); }
    finally { if (pendingActionRef.current === pending) { pendingActionRef.current = null; if (isCurrentScope()) setPendingAction(""); } }
  };

  if (!deploymentFeatures.creditsEnabled || !user || !user.groupId) return <main role="alert" className="flex h-full flex-col items-center justify-center gap-4 p-6 text-center"><h1 className="text-xl font-semibold">{t("小组功能暂不可用")}</h1><p className="text-sm text-muted-foreground">{!deploymentFeatures.creditsEnabled ? t("当前未启用小组功能。") : t("当前账号尚未分配小组，请联系管理员。")}</p><Link to="/" className="underline">{t("返回工作台")}</Link></main>;

  const setResult = (asset: ServerAsset, eventType: AssetEventType) => runAction(`asset:${asset.id}:${eventType}`, async () => {
    try { await recordServerAssetEvent(asset.id, eventType, { channel: "team-dashboard" }); if (!isCurrentScope()) return; message.success(t("成果状态已更新")); await refresh(true); }
    catch (error) { if (isCurrentScope()) message.error(displayNotice(error instanceof Error ? error.message : t("状态更新失败"))); }
  });
  const successRate = overview?.summary.taskCount ? Math.round(overview.summary.successCount / overview.summary.taskCount * 100) : 0;
  const downloadReport = () => runAction("export", async () => {
    try {
      const original = await exportTeamHistory(); if (!isCurrentScope()) return; const blob = new Blob([nonFinancialTeamCsv(await original.text())], { type: "text/csv;charset=utf-8" }); if (!isCurrentScope()) return; const url = URL.createObjectURL(blob); const link = document.createElement("a");
      link.href = url; link.download = t("{p0}-历史报表.csv", { p0: String(overview?.group.name || t("本组")) }); link.click(); window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      message.success(t("本组报表已导出并记录审计"));
    } catch (error) { if (isCurrentScope()) message.error(displayNotice(error instanceof Error ? error.message : t("报表导出失败"))); }
  });

  return (
    <div className="wb-page h-full overflow-y-auto">
      <main className="wb-content space-y-6 px-4 py-6 sm:px-6 lg:px-8">
        <header className="wb-header !mb-0">
          <div><div className="wb-eyebrow">{isLeader ? t("组长工作台") : t("我的小组")}</div><h1 className="wb-title">{displayUi(overview?.group.name || user.groupName || t("团队协作"))}</h1><p className="wb-description">{t("查看小组成员、任务进展与协作成果。")}</p></div>
          <div className="wb-toolbar"><Button className="!h-10" loading={loading} icon={<RefreshCw className="size-4" />} onClick={() => void refresh()}>{t("刷新")}</Button></div>
        </header>
        {loadError ? <Alert type="warning" showIcon title={t("部分小组数据暂未更新")} description={displayUi(loadError)} action={<Button loading={loading} onClick={() => void refresh()}>{t("重试")}</Button>} /> : null}

        {isLeader ? <>
          {performanceEnabled ? <Suspense fallback={<div className="wb-surface p-6" role="status" aria-label={t("正在加载团队效能")}><Skeleton active /></div>}><PerformanceDashboard teamOnly /></Suspense> : null}
          <section className="grid gap-3 sm:grid-cols-3">
            <Metric icon={<UsersRound className="size-4" />} label={t("当前成员")} value={overview ? String(overview.group.memberCount) : "—"} />
            <Metric icon={<Images className="size-4" />} label={t("历史任务")} value={overview ? String(overview.summary.taskCount) : "—"} />
            <Metric icon={<CheckCircle2 className="size-4" />} label={t("任务成功率")} value={overview ? `${successRate}%` : "—"} />
          </section>

          <section className="wb-surface overflow-hidden"><div className="border-b border-[var(--border)] px-4 py-3 text-base font-semibold">{t("本组成员")}</div><Table loading={loading} rowKey="id" size="small" pagination={false} scroll={{ x: 640 }} dataSource={overview?.members ?? []} columns={displayConfig([
            { title: t("姓名"), dataIndex: "displayName" }, { title: t("账号"), dataIndex: "username" },
            { title: t("身份"), render: (_, record) => <Tag color={record.role === "leader" ? "orange" : "default"}>{record.role === "leader" ? t("组长") : t("成员")}</Tag> },
          ], "columns", overview?.members ?? [])} /></section>

          <section><div className="mb-3 flex items-end justify-between"><div><h2 className="text-lg font-semibold">{t("最近成果")}</h2><p className="text-sm text-[var(--muted-foreground)]">{t("组长可确认采用、最终交付、待定或废弃")}</p></div><Tag>{t("共")} {assetTotal} {t("个 · 显示最近")} {assets.length} {t("个")}</Tag></div>
            {assets.length ? <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">{assets.slice(0, 12).map((asset) => <article key={asset.id} className="wb-surface overflow-hidden">
              {asset.kind === "image" ? <WorkbenchImage src={`/api/assets/${asset.id}/content`} alt={asset.filename} loading="lazy" decoding="async" className="aspect-[4/3] w-full object-cover" /> : <div className="flex aspect-[4/3] items-center justify-center bg-[var(--muted)] text-[var(--muted-foreground)]">{asset.kind}</div>}
              <div className="space-y-3 p-3"><div className="flex items-start justify-between gap-2"><div><div className="break-all font-medium">{asset.filename}</div><div className="text-xs text-[var(--muted-foreground)]">{displayUi(asset.ownerName)} · {displayUi(asset.modelName || t("未记录模型"))}</div></div><Tag color="orange">{t(statusLabel[asset.resultStatus]) || asset.resultStatus}</Tag></div><p className="line-clamp-3 min-h-[60px] text-sm leading-5 text-[var(--muted-foreground)]">{displayUi(asset.prompt || t("未记录提示词"))}</p><div className="grid grid-cols-2 gap-2"><Button className="!h-10" loading={pendingAction === `asset:${asset.id}:asset.adopted`} disabled={Boolean(pendingAction) || asset.resultStatus === "adopted"} icon={<CheckCircle2 className="size-3.5" />} onClick={() => void setResult(asset, "asset.adopted")}>{t("确认采用")}</Button><Button className="!h-10" loading={pendingAction === `asset:${asset.id}:asset.delivered`} disabled={Boolean(pendingAction) || asset.resultStatus === "delivered"} type="primary" icon={<Clock3 className="size-3.5" />} onClick={() => void setResult(asset, "asset.delivered")}>{t("最终交付")}</Button><Button className="!h-10" loading={pendingAction === `asset:${asset.id}:asset.pending`} disabled={Boolean(pendingAction) || asset.resultStatus === "pending"} icon={<RotateCcw className="size-3.5" />} onClick={() => void setResult(asset, "asset.pending")}>{t("标记待定")}</Button><Button className="!h-10" loading={pendingAction === `asset:${asset.id}:asset.rejected`} disabled={Boolean(pendingAction) || asset.resultStatus === "rejected"} danger icon={<XCircle className="size-3.5" />} onClick={() => void setResult(asset, "asset.rejected")}>{t("标记废弃")}</Button></div></div>
            </article>)}</div> : <div className="wb-surface p-6">{loading ? <Skeleton active paragraph={{ rows: 4 }} /> : <Empty description={t("本组暂无成果，成员完成生成后会显示在这里")} />}</div>}
          </section>

          <section className="wb-surface overflow-hidden"><div className="flex items-center justify-between border-b border-[var(--border)] px-4 py-3"><div className="text-base font-semibold">{t("本组任务与完整提示词")}</div><Button className="!h-10" loading={pendingAction === "export"} disabled={Boolean(pendingAction) || loading || !history.length} icon={<Download className="size-4" />} onClick={() => void downloadReport()}>{t("导出本组报表")}</Button></div><Table loading={loading} rowKey="id" size="small" scroll={{ x: 900 }} pagination={{ pageSize: 20 }} dataSource={history} columns={displayConfig([
            { title: `${t("时间")} (${t("北京时间")})`, dataIndex: "createdAt", width: 200, render: (value: string) => formatBeijingDateTime(value) }, { title: t("设计师"), dataIndex: "userName", width: 120 }, { title: t("板块"), dataIndex: "operationType", width: 130, render: adminLabel }, { title: t("模型"), dataIndex: "modelName", width: 130, render: (value: string | null) => value || "-" }, { title: t("完整提示词"), dataIndex: "prompt", width: 360 }, { title: t("状态"), dataIndex: "status", width: 90, render: (value: string) => <Tag color={value === "success" ? "green" : "red"}>{adminLabel(value)}</Tag> },
          ], "columns", history)} /></section>

          <section className="wb-surface overflow-hidden"><div className="border-b border-[var(--border)] px-4 py-3 text-base font-semibold">{t("本组审计记录")}</div><Table loading={loading} scroll={{ x: 850 }} rowKey="id" size="small" pagination={{ pageSize: 20 }} dataSource={auditLogs.filter(log => !isFinancialAuditAction(log.action))} columns={displayConfig([
            { title: staticUiText("{p0}（北京时间）", { p0: `${t("时间")}` }), dataIndex: "createdAt", width: 180, render: formatBeijingDateTime }, { title: t("操作人"), dataIndex: "actorName", width: 120, render: (value: string | null) => value || t("系统") }, { title: t("行为"), dataIndex: "action", width: 180, render: adminLabel }, { title: t("目标"), dataIndex: "targetId", width: 220 }, { title: t("结果"), dataIndex: "result", width: 90, render: (value: string) => <Tag color={value === "success" ? "green" : "red"}>{adminLabel(value)}</Tag> },
          ], "columns", auditLogs.filter(log => !isFinancialAuditAction(log.action)))} /></section>
        </> : null}
      </main>

    </div>
  );
}

function Metric({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
    const displayUi = useDisplayUiValue();
  return <div className="wb-surface px-5 py-4"><div className="flex items-center gap-2 text-xs text-[var(--muted-foreground)]">{icon}{displayUi(label)}</div><div className="mt-3 text-[28px] font-semibold tracking-tight tabular-nums">{value}</div></div>;
}
