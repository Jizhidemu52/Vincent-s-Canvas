import { App, Button, Empty, Form, Input, InputNumber, Modal, Table, Tag } from "antd";
import { CheckCircle2, CircleDollarSign, Clock3, Download, HandCoins, Images, RotateCcw, Send, UsersRound, XCircle } from "lucide-react";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { Navigate } from "react-router-dom";

import {
  contributeGroupCredits,
  decideTeamGroupCreditRequest,
  getMyGroupCredits,
  getTeamGroupCredits,
  submitGroupCreditRequest,
  type ManagedGroupCredits,
  type MyGroupCredits,
} from "@/services/api/group-credits";
import { exportTeamHistory, getTeamAudit, getTeamHistory, getTeamOverview, type TeamAuditLog, type TeamHistory, type TeamOverview } from "@/services/api/groups";
import { listServerAssets, recordServerAssetEvent, type AssetEventType, type ServerAsset } from "@/services/api/server-assets";
import { useUserStore } from "@/stores/use-user-store";

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
  const isLeader = user?.groupRole === "leader";

  const refresh = async () => {
    if (!user?.groupId) return;
    setLoading(true);
    try {
      const mine = await getMyGroupCredits();
      setMyCredits(mine);
      if (isLeader) {
        const [team, historyResult, assetResult, auditResult, credits] = await Promise.all([
          getTeamOverview(), getTeamHistory(), listServerAssets(), getTeamAudit(), getTeamGroupCredits(),
        ]);
        setOverview(team); setHistory(historyResult.history); setAssets(assetResult.assets);
        setAuditLogs(auditResult.auditLogs); setManagedCredits(credits);
      }
    } catch (error) { message.error(error instanceof Error ? error.message : "本组数据加载失败"); }
    finally { setLoading(false); }
  };
  useEffect(() => { void refresh(); }, [user?.groupId, user?.groupRole]);

  if (!user || !user.groupId) return <Navigate to="/" replace />;

  const applyCredits = async (values: { amount: number; reason: string }) => {
    try {
      await submitGroupCreditRequest({ requestId: `group-claim-${crypto.randomUUID()}`, ...values });
      message.success("额度申请已提交，等待组长审批"); setRequestOpen(false); requestForm.resetFields(); await refresh();
    } catch (error) { message.error(error instanceof Error ? error.message : "申请失败"); }
  };
  const contribute = async (values: { amount: number }) => {
    try {
      await contributeGroupCredits({ requestId: `group-contribution-${crypto.randomUUID()}`, ...values });
      message.success("积分已归还到本组共享池，本月个人额度同步减少"); setContributionOpen(false);
      contributionForm.resetFields(); await Promise.all([hydrateSession(), refresh()]);
    } catch (error) { message.error(error instanceof Error ? error.message : "归还失败"); }
  };
  const decide = async (id: string, decision: "approved" | "rejected") => {
    try {
      await decideTeamGroupCreditRequest(id, decision);
      message.success(decision === "approved" ? "审批通过，额度已到账" : "申请已拒绝"); await refresh();
    } catch (error) { message.error(error instanceof Error ? error.message : "审批失败"); }
  };
  const setResult = async (asset: ServerAsset, eventType: AssetEventType) => {
    try { await recordServerAssetEvent(asset.id, eventType, { channel: "team-dashboard" }); message.success("成果状态已更新"); await refresh(); }
    catch (error) { message.error(error instanceof Error ? error.message : "状态更新失败"); }
  };
  const successRate = overview?.summary.taskCount ? Math.round(overview.summary.successCount / overview.summary.taskCount * 100) : 0;
  const downloadReport = async () => {
    try {
      const blob = await exportTeamHistory(); const url = URL.createObjectURL(blob); const link = document.createElement("a");
      link.href = url; link.download = `${overview?.group.name || "本组"}-历史报表.csv`; link.click(); URL.revokeObjectURL(url);
      message.success("本组报表已导出并记录审计");
    } catch (error) { message.error(error instanceof Error ? error.message : "报表导出失败"); }
  };

  return (
    <div className="h-full overflow-y-auto bg-stone-50 text-stone-950">
      <main className="mx-auto w-full max-w-7xl space-y-5 px-6 py-6">
        <header className="flex flex-wrap items-end justify-between gap-3 border-b border-stone-200 pb-4">
          <div><div className="text-xs font-semibold text-orange-600">{isLeader ? "组长工作台" : "我的小组"}</div><h1 className="mt-1 text-2xl font-semibold">{overview?.group.name || user.groupName}</h1><p className="mt-1 text-sm text-stone-500">个人月度额度优先使用，不足部分才会使用已审批的小组额度</p></div>
          <div className="flex gap-2"><Button icon={<HandCoins className="size-4" />} onClick={() => setContributionOpen(true)}>归还个人额度</Button><Button type="primary" icon={<Send className="size-4" />} onClick={() => setRequestOpen(true)}>申请小组额度</Button></div>
        </header>

        <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <Metric icon={<CircleDollarSign className="size-4" />} label="已领取可用" value={`${myCredits?.wallet.availableCredits ?? 0} 积分`} />
          <Metric icon={<HandCoins className="size-4" />} label="本月累计领取" value={`${myCredits?.wallet.grantedCredits ?? 0} 积分`} />
          <Metric icon={<CheckCircle2 className="size-4" />} label="已使用小组额度" value={`${myCredits?.wallet.spentCredits ?? 0} 积分`} />
          <Metric icon={<Clock3 className="size-4" />} label="小组池当前可用" value={`${myCredits?.poolBalance ?? 0} 积分`} />
        </section>

        <section className="bg-white">
          <div className="border-b border-stone-200 px-4 py-3"><div className="font-semibold">我的额度申请</div><div className="text-xs text-stone-500">领取额度仅本月有效，月底自动清零，不能转给其他成员</div></div>
          <Table loading={loading} rowKey="id" size="small" scroll={{ x: 760 }} pagination={{ pageSize: 8 }} dataSource={myCredits?.requests ?? []} columns={[
            { title: "申请时间", dataIndex: "createdAt", render: (value: string) => new Date(value).toLocaleString("zh-CN") },
            { title: "积分", dataIndex: "amount" }, { title: "用途", dataIndex: "reason" },
            { title: "状态", dataIndex: "status", render: (value: string) => <Tag color={requestStatus[value]?.color}>{requestStatus[value]?.label || value}</Tag> },
            { title: "审批备注", dataIndex: "decisionNote", render: (value: string | null) => value || "-" },
          ]} />
        </section>

        {isLeader ? <>
          <section className="bg-white">
            <div className="border-b border-stone-200 px-4 py-3"><div className="font-semibold">共享池审批</div><div className="text-xs text-stone-500">只能审批本组有效成员；单次、每日和每月上限由管理员统一设置</div></div>
            <Table loading={loading} rowKey="id" size="small" scroll={{ x: 720 }} pagination={{ pageSize: 10 }} dataSource={managedCredits?.requests ?? []} columns={[
              { title: "成员", dataIndex: "userName" }, { title: "积分", dataIndex: "amount" }, { title: "用途", dataIndex: "reason" },
              { title: "状态", dataIndex: "status", render: (value: string) => <Tag color={requestStatus[value]?.color}>{requestStatus[value]?.label || value}</Tag> },
              { title: "操作", render: (_, row) => row.status === "pending" ? <div className="flex gap-2"><Button size="small" type="primary" onClick={() => void decide(row.id, "approved")}>通过</Button><Button size="small" danger onClick={() => modal.confirm({ title: "拒绝该额度申请？", okText: "拒绝", okButtonProps: { danger: true }, onOk: () => decide(row.id, "rejected") })}>拒绝</Button></div> : "-" },
            ]} />
          </section>

          <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <Metric icon={<UsersRound className="size-4" />} label="当前成员" value={String(overview?.group.memberCount ?? 0)} />
            <Metric icon={<Images className="size-4" />} label="历史任务" value={String(overview?.summary.taskCount ?? 0)} />
            <Metric icon={<CheckCircle2 className="size-4" />} label="任务成功率" value={`${successRate}%`} />
            <Metric icon={<CircleDollarSign className="size-4" />} label="累计成本" value={`¥${Number(overview?.summary.rmbCost ?? 0).toFixed(2)}`} />
          </section>

          <section className="bg-white"><div className="border-b border-stone-200 px-4 py-3 text-base font-semibold">本组成员</div><Table loading={loading} rowKey="id" size="small" pagination={false} dataSource={overview?.members ?? []} columns={[
            { title: "姓名", dataIndex: "displayName" }, { title: "账号", dataIndex: "username" },
            { title: "身份", render: (_, record) => <Tag color={record.role === "leader" ? "orange" : "default"}>{record.role === "leader" ? "组长" : "成员"}</Tag> },
            { title: "个人本月剩余", dataIndex: "creditBalance" }, { title: "每月固定额度", dataIndex: "monthlyCreditLimit" },
          ]} /></section>

          <section><div className="mb-3 flex items-end justify-between"><div><h2 className="text-lg font-semibold">最近成果</h2><p className="text-sm text-stone-500">组长可确认采用、最终交付、待定或废弃</p></div><Tag>{assets.length} 张</Tag></div>
            {assets.length ? <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">{assets.slice(0, 12).map((asset) => <article key={asset.id} className="overflow-hidden border border-stone-200 bg-white">
              {asset.kind === "image" ? <img src={`/api/assets/${asset.id}/content`} alt={asset.filename} className="aspect-[4/3] w-full object-cover" /> : <div className="flex aspect-[4/3] items-center justify-center bg-stone-100 text-stone-400">{asset.kind}</div>}
              <div className="space-y-3 p-3"><div className="flex items-start justify-between gap-2"><div><div className="font-medium">{asset.filename}</div><div className="text-xs text-stone-500">{asset.ownerName} · {asset.modelName || "未记录模型"}</div></div><Tag color="orange">{statusLabel[asset.resultStatus] || asset.resultStatus}</Tag></div><p className="line-clamp-3 min-h-[60px] text-sm leading-5 text-stone-600">{asset.prompt || "未记录提示词"}</p><div className="grid grid-cols-2 gap-2"><Button size="small" icon={<CheckCircle2 className="size-3.5" />} onClick={() => void setResult(asset, "asset.adopted")}>确认采用</Button><Button size="small" type="primary" icon={<Clock3 className="size-3.5" />} onClick={() => void setResult(asset, "asset.delivered")}>最终交付</Button><Button size="small" icon={<RotateCcw className="size-3.5" />} onClick={() => void setResult(asset, "asset.pending")}>标记待定</Button><Button size="small" danger icon={<XCircle className="size-3.5" />} onClick={() => void setResult(asset, "asset.rejected")}>标记废弃</Button></div></div>
            </article>)}</div> : <div className="bg-white py-16"><Empty description="本组暂无成果" /></div>}
          </section>

          <section className="bg-white"><div className="flex items-center justify-between border-b border-stone-200 px-4 py-3"><div className="text-base font-semibold">本组任务与完整提示词</div><Button icon={<Download className="size-4" />} onClick={() => void downloadReport()}>导出本组报表</Button></div><Table loading={loading} rowKey="id" size="small" scroll={{ x: 900 }} pagination={{ pageSize: 20 }} dataSource={history} columns={[
            { title: "时间", dataIndex: "createdAt", width: 170, render: (value: string) => new Date(value).toLocaleString("zh-CN") }, { title: "设计师", dataIndex: "userName", width: 120 }, { title: "板块", dataIndex: "operationType", width: 130 }, { title: "模型", dataIndex: "modelName", width: 130, render: (value: string | null) => value || "-" }, { title: "完整提示词", dataIndex: "prompt", width: 360 }, { title: "积分", dataIndex: "credits", width: 80 }, { title: "状态", dataIndex: "status", width: 90, render: (value: string) => <Tag color={value === "success" ? "green" : "red"}>{value}</Tag> },
          ]} /></section>

          <section className="bg-white"><div className="border-b border-stone-200 px-4 py-3 text-base font-semibold">本组审计记录</div><Table rowKey="id" size="small" pagination={{ pageSize: 20 }} dataSource={auditLogs} columns={[
            { title: "时间", dataIndex: "createdAt", width: 180, render: (value: string) => new Date(value).toLocaleString("zh-CN") }, { title: "操作人", dataIndex: "actorName", width: 120, render: (value: string | null) => value || "系统" }, { title: "行为", dataIndex: "action", width: 180 }, { title: "目标", dataIndex: "targetId", width: 220 }, { title: "结果", dataIndex: "result", width: 90, render: (value: string) => <Tag color={value === "success" ? "green" : "red"}>{value}</Tag> },
          ]} /></section>
        </> : null}
      </main>

      <Modal title="申请小组共享额度" open={requestOpen} onCancel={() => setRequestOpen(false)} footer={null} destroyOnHidden><Form form={requestForm} layout="vertical" onFinish={applyCredits}><Form.Item name="amount" label={`申请积分（单次最多 ${myCredits?.policy.perRequestLimit ?? 0}）`} rules={[{ required: true }]}><InputNumber className="w-full" min={1} max={myCredits?.policy.perRequestLimit || 1} /></Form.Item><Form.Item name="reason" label="用途说明" rules={[{ required: true, min: 2 }]}><Input.TextArea rows={4} maxLength={500} showCount placeholder="例如：本周商品图批量改图任务" /></Form.Item><Button type="primary" htmlType="submit" block>提交申请</Button></Form></Modal>
      <Modal title="归还个人额度到本组共享池" open={contributionOpen} onCancel={() => setContributionOpen(false)} footer={null} destroyOnHidden><Form form={contributionForm} layout="vertical" onFinish={contribute}><p className="mb-4 text-sm text-stone-500">只可归还本月尚未使用的个人积分。归还后不能撤回或跨组转移，月底共享池余额统一清零。</p><Form.Item name="amount" label={`归还积分（个人当前剩余 ${user.creditBalance}）`} rules={[{ required: true }]}><InputNumber className="w-full" min={1} max={user.creditBalance} /></Form.Item><Button type="primary" htmlType="submit" block disabled={user.creditBalance <= 0}>确认归还</Button></Form></Modal>
    </div>
  );
}

function Metric({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  return <div className="border border-stone-200 bg-white px-4 py-3"><div className="flex items-center gap-2 text-xs text-stone-500">{icon}{label}</div><div className="mt-2 text-2xl font-semibold">{value}</div></div>;
}
