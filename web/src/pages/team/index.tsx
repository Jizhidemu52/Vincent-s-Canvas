import { Alert, App, Button, Empty, Form, Input, InputNumber, Modal, Skeleton, Table, Tag } from "antd";
import { CheckCircle2, CircleDollarSign, Clock3, Download, HandCoins, Images, RefreshCw, RotateCcw, Send, UsersRound, XCircle } from "lucide-react";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Navigate } from "react-router-dom";

import { createClientId } from "@/lib/client-id";

import {
  contributeGroupCredits,
  decideTeamGroupCreditRequest,
  submitGroupCreditRequest,
  type ManagedGroupCredits,
  type MyGroupCredits,
} from "@/services/api/group-credits";
import { exportTeamHistory, type TeamAuditLog, type TeamHistory, type TeamOverview } from "@/services/api/groups";
import { recordServerAssetEvent, type AssetEventType, type ServerAsset } from "@/services/api/server-assets";
import { useUserStore } from "@/stores/use-user-store";
import { useModuleStore } from "@/stores/use-module-store";
import { loadTeamOverview } from "./team-overview";

const PerformanceDashboard = lazy(() => import("@/pages/performance/dashboard").then((module) => ({ default: module.PerformanceDashboard })));

const statusLabel: Record<string, string> = { unused: "未使用", candidate: "候选", project: "已入项目", editing: "继续编辑", downloaded: "已下载", adopted: "已采用", delivered: "已交付", pending: "待定", rejected: "废弃" };
const requestStatus: Record<string, { label: string; color: string }> = {
  pending: { label: "待审批", color: "orange" }, approved: { label: "已到账", color: "green" },
  rejected: { label: "已拒绝", color: "red" }, expired: { label: "已过期", color: "default" },
  cancelled: { label: "已取消", color: "default" },
};

export default function TeamPage() {
  const { message, modal } = App.useApp();
  const user = useUserStore((state) => state.user);
  const hydrateSession = useUserStore((state) => state.hydrateSession);
  const [requestForm] = Form.useForm<{ amount: number; reason: string }>();
  const [contributionForm] = Form.useForm<{ amount: number }>();
  const [requestOpen, setRequestOpen] = useState(false);
  const [contributionOpen, setContributionOpen] = useState(false);
  const [myCredits, setMyCredits] = useState<MyGroupCredits>();
  const [managedCredits, setManagedCredits] = useState<ManagedGroupCredits>();
  const [overview, setOverview] = useState<TeamOverview>();
  const [history, setHistory] = useState<TeamHistory[]>([]);
  const [auditLogs, setAuditLogs] = useState<TeamAuditLog[]>([]);
  const [assets, setAssets] = useState<ServerAsset[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [pendingAction, setPendingAction] = useState("");
  const pendingActionRef = useRef("");
  const requestSequence = useRef(0);
  const isLeader = user?.groupRole === "leader";
  const performanceEnabled = useModuleStore((state) => state.flags.performance);

  const refresh = async (background = false) => {
    if (!user?.groupId) return;
    const sequence = ++requestSequence.current;
    if (!background) setLoading(true);
    try {
      const result = await loadTeamOverview(isLeader);
      if (sequence !== requestSequence.current) return;
      if (result.myCredits) setMyCredits(result.myCredits);
      if (result.overview) setOverview(result.overview);
      if (result.history) setHistory(result.history);
      if (result.assets) setAssets(result.assets);
      if (result.auditLogs) setAuditLogs(result.auditLogs);
      if (result.managedCredits) setManagedCredits(result.managedCredits);
      setLoadError(result.errors.join("；"));
    } catch (error) { if (sequence === requestSequence.current) setLoadError(error instanceof Error ? error.message : "本组数据加载失败"); }
    finally { if (sequence === requestSequence.current) setLoading(false); }
  };
  useEffect(() => {
    setMyCredits(undefined); setManagedCredits(undefined); setOverview(undefined); setHistory([]); setAssets([]); setAuditLogs([]); setLoadError("");
    void refresh();
    return () => { requestSequence.current++; };
  }, [user?.id, user?.groupId, user?.groupRole]);

  const runAction = async (key: string, action: () => Promise<void>) => {
    if (pendingActionRef.current) return;
    pendingActionRef.current = key; setPendingAction(key);
    try { await action(); }
    finally { pendingActionRef.current = ""; setPendingAction(""); }
  };

  if (!user || !user.groupId) return <Navigate to="/" replace />;

  const applyCredits = (values: { amount: number; reason: string }) => runAction("request", async () => {
    try {
      await submitGroupCreditRequest({ requestId: `group-claim-${createClientId()}`, ...values });
      message.success("额度申请已提交，等待组长审批"); setRequestOpen(false); requestForm.resetFields(); await refresh(true);
    } catch (error) { message.error(error instanceof Error ? error.message : "申请失败"); }
  });
  const contribute = (values: { amount: number }) => runAction("contribution", async () => {
    try {
      await contributeGroupCredits({ requestId: `group-contribution-${createClientId()}`, ...values });
      message.success("积分已归还到本组共享池，本月个人额度同步减少"); setContributionOpen(false);
      contributionForm.resetFields(); await Promise.all([hydrateSession(), refresh(true)]);
    } catch (error) { message.error(error instanceof Error ? error.message : "归还失败"); }
  });
  const decide = (id: string, decision: "approved" | "rejected") => runAction(`decision:${id}`, async () => {
    try {
      await decideTeamGroupCreditRequest(id, decision);
      message.success(decision === "approved" ? "审批通过，额度已到账" : "申请已拒绝"); await refresh(true);
    } catch (error) { message.error(error instanceof Error ? error.message : "审批失败"); }
  });
  const setResult = (asset: ServerAsset, eventType: AssetEventType) => runAction(`asset:${asset.id}:${eventType}`, async () => {
    try { await recordServerAssetEvent(asset.id, eventType, { channel: "team-dashboard" }); message.success("成果状态已更新"); await refresh(true); }
    catch (error) { message.error(error instanceof Error ? error.message : "状态更新失败"); }
  });
  const successRate = overview?.summary.taskCount ? Math.round(overview.summary.successCount / overview.summary.taskCount * 100) : 0;
  const downloadReport = () => runAction("export", async () => {
    try {
      const blob = await exportTeamHistory(); const url = URL.createObjectURL(blob); const link = document.createElement("a");
      link.href = url; link.download = `${overview?.group.name || "本组"}-历史报表.csv`; link.click(); window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      message.success("本组报表已导出并记录审计");
    } catch (error) { message.error(error instanceof Error ? error.message : "报表导出失败"); }
  });

  return (
    <div className="wb-page h-full overflow-y-auto">
      <main className="mx-auto w-full max-w-7xl space-y-6 px-4 py-6 sm:px-6 lg:px-8">
        <header className="wb-header !mb-0">
          <div><div className="wb-eyebrow">{isLeader ? "组长工作台" : "我的小组"}</div><h1 className="wb-title">{overview?.group.name || user.groupName || "团队协作"}</h1><p className="wb-description">查看小组额度与协作成果。优先使用个人月度额度，不足时再使用已审批的小组额度。</p></div>
          <div className="wb-toolbar"><Button className="!h-10" loading={loading} icon={<RefreshCw className="size-4" />} onClick={() => void refresh()}>刷新</Button><Button className="!h-10" disabled={loading || !myCredits || Boolean(pendingAction) || user.creditBalance <= 0} icon={<HandCoins className="size-4" />} onClick={() => setContributionOpen(true)}>归还个人额度</Button><Button className="!h-10" disabled={loading || !myCredits || Boolean(pendingAction) || myCredits.policy.perRequestLimit <= 0} type="primary" icon={<Send className="size-4" />} onClick={() => setRequestOpen(true)}>申请小组额度</Button></div>
        </header>
        {loadError ? <Alert type="warning" showIcon title="部分小组数据暂未更新" description={loadError} action={<Button loading={loading} onClick={() => void refresh()}>重试</Button>} /> : null}

        <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <Metric icon={<CircleDollarSign className="size-4" />} label="已领取可用" value={myCredits ? `${myCredits.wallet.availableCredits} 积分` : "—"} />
          <Metric icon={<HandCoins className="size-4" />} label="本月累计领取" value={myCredits ? `${myCredits.wallet.grantedCredits} 积分` : "—"} />
          <Metric icon={<CheckCircle2 className="size-4" />} label="已使用小组额度" value={myCredits ? `${myCredits.wallet.spentCredits} 积分` : "—"} />
          <Metric icon={<Clock3 className="size-4" />} label="小组池当前可用" value={myCredits ? `${myCredits.poolBalance} 积分` : "—"} />
        </section>

        <section className="wb-surface overflow-hidden">
          <div className="border-b border-[var(--border)] px-4 py-3"><div className="font-semibold">我的额度申请</div><div className="text-xs text-[var(--muted-foreground)]">领取额度仅本月有效，月底自动清零，不能转给其他成员</div></div>
          <Table loading={loading} rowKey="id" size="small" scroll={{ x: 760 }} pagination={{ pageSize: 8 }} dataSource={myCredits?.requests ?? []} columns={[
            { title: "申请时间", dataIndex: "createdAt", render: (value: string) => new Date(value).toLocaleString("zh-CN") },
            { title: "积分", dataIndex: "amount" }, { title: "用途", dataIndex: "reason" },
            { title: "状态", dataIndex: "status", render: (value: string) => <Tag color={requestStatus[value]?.color}>{requestStatus[value]?.label || value}</Tag> },
            { title: "审批备注", dataIndex: "decisionNote", render: (value: string | null) => value || "-" },
          ]} />
        </section>

        {isLeader ? <>
          {performanceEnabled ? <Suspense fallback={<div className="wb-surface p-6" role="status" aria-label="正在加载团队效能"><Skeleton active /></div>}><PerformanceDashboard teamOnly /></Suspense> : null}
          <section className="wb-surface overflow-hidden">
            <div className="border-b border-[var(--border)] px-4 py-3"><div className="font-semibold">共享池审批</div><div className="text-xs text-[var(--muted-foreground)]">只能审批本组有效成员；单次、每日和每月上限由管理员统一设置</div></div>
            <Table loading={loading} rowKey="id" size="small" scroll={{ x: 720 }} pagination={{ pageSize: 10 }} dataSource={managedCredits?.requests ?? []} columns={[
              { title: "成员", dataIndex: "userName" }, { title: "积分", dataIndex: "amount" }, { title: "用途", dataIndex: "reason" },
              { title: "状态", dataIndex: "status", render: (value: string) => <Tag color={requestStatus[value]?.color}>{requestStatus[value]?.label || value}</Tag> },
              { title: "操作", render: (_, row) => row.status === "pending" ? <div className="flex gap-2"><Button size="small" type="primary" loading={pendingAction === `decision:${row.id}`} disabled={Boolean(pendingAction)} onClick={() => void decide(row.id, "approved")}>通过</Button><Button size="small" danger disabled={Boolean(pendingAction)} onClick={() => modal.confirm({ title: "拒绝该额度申请？", okText: "拒绝", okButtonProps: { danger: true }, onOk: () => decide(row.id, "rejected") })}>拒绝</Button></div> : "-" },
            ]} />
          </section>

          <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <Metric icon={<UsersRound className="size-4" />} label="当前成员" value={overview ? String(overview.group.memberCount) : "—"} />
            <Metric icon={<Images className="size-4" />} label="历史任务" value={overview ? String(overview.summary.taskCount) : "—"} />
            <Metric icon={<CheckCircle2 className="size-4" />} label="任务成功率" value={overview ? `${successRate}%` : "—"} />
            <Metric icon={<CircleDollarSign className="size-4" />} label="累计成本" value={overview ? `¥${Number(overview.summary.rmbCost).toFixed(2)}` : "—"} />
          </section>

          <section className="wb-surface overflow-hidden"><div className="border-b border-[var(--border)] px-4 py-3 text-base font-semibold">本组成员</div><Table loading={loading} rowKey="id" size="small" pagination={false} scroll={{ x: 640 }} dataSource={overview?.members ?? []} columns={[
            { title: "姓名", dataIndex: "displayName" }, { title: "账号", dataIndex: "username" },
            { title: "身份", render: (_, record) => <Tag color={record.role === "leader" ? "orange" : "default"}>{record.role === "leader" ? "组长" : "成员"}</Tag> },
            { title: "个人本月剩余", dataIndex: "creditBalance" }, { title: "每月固定额度", dataIndex: "monthlyCreditLimit" },
          ]} /></section>

          <section><div className="mb-3 flex items-end justify-between"><div><h2 className="text-lg font-semibold">最近成果</h2><p className="text-sm text-[var(--muted-foreground)]">组长可确认采用、最终交付、待定或废弃</p></div><Tag>{assets.length} 张</Tag></div>
            {assets.length ? <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">{assets.slice(0, 12).map((asset) => <article key={asset.id} className="wb-surface overflow-hidden">
              {asset.kind === "image" ? <img src={`/api/assets/${asset.id}/content`} alt={asset.filename} loading="lazy" decoding="async" className="aspect-[4/3] w-full object-cover" /> : <div className="flex aspect-[4/3] items-center justify-center bg-[var(--muted)] text-[var(--muted-foreground)]">{asset.kind}</div>}
              <div className="space-y-3 p-3"><div className="flex items-start justify-between gap-2"><div><div className="break-all font-medium">{asset.filename}</div><div className="text-xs text-[var(--muted-foreground)]">{asset.ownerName} · {asset.modelName || "未记录模型"}</div></div><Tag color="orange">{statusLabel[asset.resultStatus] || asset.resultStatus}</Tag></div><p className="line-clamp-3 min-h-[60px] text-sm leading-5 text-[var(--muted-foreground)]">{asset.prompt || "未记录提示词"}</p><div className="grid grid-cols-2 gap-2"><Button className="!h-10" loading={pendingAction === `asset:${asset.id}:asset.adopted`} disabled={Boolean(pendingAction) || asset.resultStatus === "adopted"} icon={<CheckCircle2 className="size-3.5" />} onClick={() => void setResult(asset, "asset.adopted")}>确认采用</Button><Button className="!h-10" loading={pendingAction === `asset:${asset.id}:asset.delivered`} disabled={Boolean(pendingAction) || asset.resultStatus === "delivered"} type="primary" icon={<Clock3 className="size-3.5" />} onClick={() => void setResult(asset, "asset.delivered")}>最终交付</Button><Button className="!h-10" loading={pendingAction === `asset:${asset.id}:asset.pending`} disabled={Boolean(pendingAction) || asset.resultStatus === "pending"} icon={<RotateCcw className="size-3.5" />} onClick={() => void setResult(asset, "asset.pending")}>标记待定</Button><Button className="!h-10" loading={pendingAction === `asset:${asset.id}:asset.rejected`} disabled={Boolean(pendingAction) || asset.resultStatus === "rejected"} danger icon={<XCircle className="size-3.5" />} onClick={() => void setResult(asset, "asset.rejected")}>标记废弃</Button></div></div>
            </article>)}</div> : <div className="wb-surface p-6">{loading ? <Skeleton active paragraph={{ rows: 4 }} /> : <Empty description="本组暂无成果，成员完成生成后会显示在这里" />}</div>}
          </section>

          <section className="wb-surface overflow-hidden"><div className="flex items-center justify-between border-b border-[var(--border)] px-4 py-3"><div className="text-base font-semibold">本组任务与完整提示词</div><Button className="!h-10" loading={pendingAction === "export"} disabled={Boolean(pendingAction) || loading || !history.length} icon={<Download className="size-4" />} onClick={() => void downloadReport()}>导出本组报表</Button></div><Table loading={loading} rowKey="id" size="small" scroll={{ x: 900 }} pagination={{ pageSize: 20 }} dataSource={history} columns={[
            { title: "时间", dataIndex: "createdAt", width: 170, render: (value: string) => new Date(value).toLocaleString("zh-CN") }, { title: "设计师", dataIndex: "userName", width: 120 }, { title: "板块", dataIndex: "operationType", width: 130 }, { title: "模型", dataIndex: "modelName", width: 130, render: (value: string | null) => value || "-" }, { title: "完整提示词", dataIndex: "prompt", width: 360 }, { title: "积分", dataIndex: "credits", width: 80 }, { title: "状态", dataIndex: "status", width: 90, render: (value: string) => <Tag color={value === "success" ? "green" : "red"}>{value}</Tag> },
          ]} /></section>

          <section className="wb-surface overflow-hidden"><div className="border-b border-[var(--border)] px-4 py-3 text-base font-semibold">本组审计记录</div><Table loading={loading} scroll={{ x: 850 }} rowKey="id" size="small" pagination={{ pageSize: 20 }} dataSource={auditLogs} columns={[
            { title: "时间", dataIndex: "createdAt", width: 180, render: (value: string) => new Date(value).toLocaleString("zh-CN") }, { title: "操作人", dataIndex: "actorName", width: 120, render: (value: string | null) => value || "系统" }, { title: "行为", dataIndex: "action", width: 180 }, { title: "目标", dataIndex: "targetId", width: 220 }, { title: "结果", dataIndex: "result", width: 90, render: (value: string) => <Tag color={value === "success" ? "green" : "red"}>{value}</Tag> },
          ]} /></section>
        </> : null}
      </main>

      <Modal title="申请小组共享额度" open={requestOpen} onCancel={() => { if (!pendingAction) setRequestOpen(false); }} keyboard={!pendingAction} maskClosable={!pendingAction} footer={null} destroyOnHidden><Form form={requestForm} disabled={Boolean(pendingAction)} layout="vertical" onFinish={applyCredits}><Form.Item name="amount" label={`申请积分（单次最多 ${myCredits?.policy.perRequestLimit ?? 0}）`} rules={[{ required: true }]}><InputNumber className="w-full" min={1} max={myCredits?.policy.perRequestLimit || 1} /></Form.Item><Form.Item name="reason" label="用途说明" rules={[{ required: true, min: 2 }]}><Input.TextArea rows={4} maxLength={500} showCount placeholder="例如：本周商品图批量改图任务" /></Form.Item><Button className="!h-10" loading={pendingAction === "request"} type="primary" htmlType="submit" block>提交申请</Button></Form></Modal>
      <Modal title="归还个人额度到本组共享池" open={contributionOpen} onCancel={() => { if (!pendingAction) setContributionOpen(false); }} keyboard={!pendingAction} maskClosable={!pendingAction} footer={null} destroyOnHidden><Form form={contributionForm} disabled={Boolean(pendingAction)} layout="vertical" onFinish={contribute}><p className="mb-4 text-sm text-[var(--muted-foreground)]">只可归还本月尚未使用的个人积分。归还后不能撤回或跨组转移，月底共享池余额统一清零。</p><Form.Item name="amount" label={`归还积分（个人当前剩余 ${user.creditBalance}）`} rules={[{ required: true }]}><InputNumber className="w-full" min={1} max={user.creditBalance} /></Form.Item><Button className="!h-10" loading={pendingAction === "contribution"} type="primary" htmlType="submit" block disabled={user.creditBalance <= 0}>确认归还</Button></Form></Modal>
    </div>
  );
}

function Metric({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  return <div className="wb-surface px-5 py-4"><div className="flex items-center gap-2 text-xs text-[var(--muted-foreground)]">{icon}{label}</div><div className="mt-3 text-[28px] font-semibold tracking-tight tabular-nums">{value}</div></div>;
}
