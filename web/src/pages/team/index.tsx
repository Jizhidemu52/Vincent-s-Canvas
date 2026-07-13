import { App, Button, Empty, Table, Tag } from "antd";
import { CheckCircle2, CircleDollarSign, Clock3, Download, Images, RotateCcw, UsersRound, XCircle } from "lucide-react";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { Navigate } from "react-router-dom";

import { exportTeamHistory, getTeamAudit, getTeamHistory, getTeamOverview, type TeamAuditLog, type TeamHistory, type TeamOverview } from "@/services/api/groups";
import { listServerAssets, recordServerAssetEvent, type AssetEventType, type ServerAsset } from "@/services/api/server-assets";
import { useUserStore } from "@/stores/use-user-store";

const statusLabel: Record<string, string> = { unused: "未使用", candidate: "候选", project: "已入项目", editing: "继续编辑", downloaded: "已下载", adopted: "已采用", delivered: "已交付", pending: "待定", rejected: "废弃" };

export default function TeamPage() {
  const { message } = App.useApp();
  const user = useUserStore((state) => state.user);
  const [overview, setOverview] = useState<TeamOverview>();
  const [history, setHistory] = useState<TeamHistory[]>([]);
  const [auditLogs, setAuditLogs] = useState<TeamAuditLog[]>([]);
  const [assets, setAssets] = useState<ServerAsset[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = async () => {
    setLoading(true);
    try {
      const [team, historyResult, assetResult, auditResult] = await Promise.all([getTeamOverview(), getTeamHistory(), listServerAssets(), getTeamAudit()]);
      setOverview(team); setHistory(historyResult.history); setAssets(assetResult.assets); setAuditLogs(auditResult.auditLogs);
    } catch (error) { message.error(error instanceof Error ? error.message : "本组数据加载失败"); }
    finally { setLoading(false); }
  };
  useEffect(() => { if (user?.groupRole === "leader") void refresh(); }, [user?.groupRole]);

  if (!user || user.groupRole !== "leader") return <Navigate to="/" replace />;

  const setResult = async (asset: ServerAsset, eventType: AssetEventType) => {
    try { await recordServerAssetEvent(asset.id, eventType, { channel: "team-dashboard" }); message.success("成果状态已更新"); await refresh(); }
    catch (error) { message.error(error instanceof Error ? error.message : "状态更新失败"); }
  };
  const successRate = overview?.summary.taskCount ? Math.round(overview.summary.successCount / overview.summary.taskCount * 100) : 0;
  const downloadReport = async () => {
    try {
      const blob = await exportTeamHistory();
      const url = URL.createObjectURL(blob); const link = document.createElement("a");
      link.href = url; link.download = `${overview?.group.name || "本组"}-历史报表.csv`; link.click(); URL.revokeObjectURL(url);
      message.success("本组报表已导出并记录审计");
    } catch (error) { message.error(error instanceof Error ? error.message : "报表导出失败"); }
  };

  return (
    <div className="h-full overflow-y-auto bg-stone-50 text-stone-950">
      <main className="mx-auto w-full max-w-7xl space-y-5 px-6 py-6">
        <header className="border-b border-stone-200 pb-4">
          <div className="text-xs font-semibold text-orange-600">组长工作台</div>
          <h1 className="mt-1 text-2xl font-semibold">{overview?.group.name || user.groupName}</h1>
          <p className="mt-1 text-sm text-stone-500">{overview?.group.departmentName} · 只展示本组归属期间产生的数据和完整提示词</p>
        </header>

        <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <Metric icon={<UsersRound className="size-4" />} label="当前成员" value={String(overview?.group.memberCount ?? 0)} />
          <Metric icon={<Images className="size-4" />} label="历史任务" value={String(overview?.summary.taskCount ?? 0)} />
          <Metric icon={<CheckCircle2 className="size-4" />} label="任务成功率" value={`${successRate}%`} />
          <Metric icon={<CircleDollarSign className="size-4" />} label="累计成本" value={`¥${Number(overview?.summary.rmbCost ?? 0).toFixed(2)}`} />
        </section>

        <section className="bg-white">
          <div className="border-b border-stone-200 px-4 py-3 text-base font-semibold">本组成员</div>
          <Table loading={loading} rowKey="id" size="small" pagination={false} dataSource={overview?.members ?? []} columns={[
            { title: "姓名", dataIndex: "displayName" }, { title: "账号", dataIndex: "username" },
            { title: "身份", render: (_, record) => <Tag color={record.role === "leader" ? "orange" : "default"}>{record.role === "leader" ? "组长" : "成员"}</Tag> },
            { title: "本月剩余", dataIndex: "creditBalance" }, { title: "每月固定额度", dataIndex: "monthlyCreditLimit" },
          ]} />
        </section>

        <section>
          <div className="mb-3 flex items-end justify-between"><div><h2 className="text-lg font-semibold">最近成果</h2><p className="text-sm text-stone-500">组长可确认采用、最终交付、待定或废弃</p></div><Tag>{assets.length} 张</Tag></div>
          {assets.length ? <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {assets.slice(0, 12).map((asset) => <article key={asset.id} className="overflow-hidden border border-stone-200 bg-white">
              {asset.kind === "image" ? <img src={`/api/assets/${asset.id}/content`} alt={asset.filename} className="aspect-[4/3] w-full object-cover" /> : <div className="flex aspect-[4/3] items-center justify-center bg-stone-100 text-stone-400">{asset.kind}</div>}
              <div className="space-y-3 p-3">
                <div className="flex items-start justify-between gap-2"><div><div className="font-medium">{asset.filename}</div><div className="text-xs text-stone-500">{asset.ownerName} · {asset.modelName || "未记录模型"}</div></div><Tag color="orange">{statusLabel[asset.resultStatus] || asset.resultStatus}</Tag></div>
                <p className="line-clamp-3 min-h-[60px] text-sm leading-5 text-stone-600">{asset.prompt || "未记录提示词"}</p>
                <div className="grid grid-cols-2 gap-2">
                  <Button size="small" icon={<CheckCircle2 className="size-3.5" />} onClick={() => void setResult(asset, "asset.adopted")}>确认采用</Button>
                  <Button size="small" type="primary" icon={<Clock3 className="size-3.5" />} onClick={() => void setResult(asset, "asset.delivered")}>最终交付</Button>
                  <Button size="small" icon={<RotateCcw className="size-3.5" />} onClick={() => void setResult(asset, "asset.pending")}>标记待定</Button>
                  <Button size="small" danger icon={<XCircle className="size-3.5" />} onClick={() => void setResult(asset, "asset.rejected")}>标记废弃</Button>
                </div>
              </div>
            </article>)}
          </div> : <div className="bg-white py-16"><Empty description="本组暂无成果" /></div>}
        </section>

        <section className="bg-white">
          <div className="flex items-center justify-between border-b border-stone-200 px-4 py-3"><div className="text-base font-semibold">本组任务与完整提示词</div><Button icon={<Download className="size-4" />} onClick={() => void downloadReport()}>导出本组报表</Button></div>
          <Table loading={loading} rowKey="id" size="small" scroll={{ x: 900 }} pagination={{ pageSize: 20 }} dataSource={history} columns={[
            { title: "时间", dataIndex: "createdAt", width: 170, render: (value: string) => new Date(value).toLocaleString("zh-CN") },
            { title: "设计师", dataIndex: "userName", width: 120 }, { title: "板块", dataIndex: "operationType", width: 130 },
            { title: "模型", dataIndex: "modelName", width: 130, render: (value: string | null) => value || "-" },
            { title: "完整提示词", dataIndex: "prompt", width: 360 }, { title: "积分", dataIndex: "credits", width: 80 },
            { title: "状态", dataIndex: "status", width: 90, render: (value: string) => <Tag color={value === "success" ? "green" : "red"}>{value}</Tag> },
          ]} />
        </section>

        <section className="bg-white">
          <div className="border-b border-stone-200 px-4 py-3 text-base font-semibold">本组审计记录</div>
          <Table rowKey="id" size="small" pagination={{ pageSize: 20 }} dataSource={auditLogs} columns={[
            { title: "时间", dataIndex: "createdAt", width: 180, render: (value: string) => new Date(value).toLocaleString("zh-CN") },
            { title: "操作人", dataIndex: "actorName", width: 120, render: (value: string | null) => value || "系统" },
            { title: "行为", dataIndex: "action", width: 180 }, { title: "目标", dataIndex: "targetId", width: 220 },
            { title: "结果", dataIndex: "result", width: 90, render: (value: string) => <Tag color={value === "success" ? "green" : "red"}>{value}</Tag> },
          ]} />
        </section>
      </main>
    </div>
  );
}

function Metric({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  return <div className="border border-stone-200 bg-white px-4 py-3"><div className="flex items-center gap-2 text-xs text-stone-500">{icon}{label}</div><div className="mt-2 text-2xl font-semibold">{value}</div></div>;
}
