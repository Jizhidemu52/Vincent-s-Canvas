import { Alert, App, Button, Form, Input, InputNumber, Modal, Select, Skeleton, Space, Switch, Table, Tag } from "antd";
import { Crown, HandCoins, Plus, Power, Trash2, UserMinus, UserPlus } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import type { ApiUser } from "@/services/api/auth";
import type { Department } from "@/services/api/admin-accounts";
import { createGroup, deleteGroup, listGroups, putGroupMember, removeGroupMember, updateGroup, type DesignerGroup, type GroupMember } from "@/services/api/groups";
import { decideAdminGroupCreditRequest, getAdminGroupCredits, updateGroupCreditPolicy, type GroupCreditPolicy, type ManagedGroupCredits } from "@/services/api/group-credits";

type GroupForm = { name: string; code: string; departmentId: string };
type MemberForm = { userId: string; role: "member" | "leader" };
type CreditPolicyForm = GroupCreditPolicy & { applyCurrentPeriod: boolean };

export function GroupManagementPanel({ accounts, departments }: { accounts: ApiUser[]; departments: Department[] }) {
  const { message, modal } = App.useApp();
  const [groupForm] = Form.useForm<GroupForm>();
  const [memberForm] = Form.useForm<MemberForm>();
  const [creditForm] = Form.useForm<CreditPolicyForm>();
  const [groups, setGroups] = useState<DesignerGroup[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [credits, setCredits] = useState<ManagedGroupCredits>();
  const [creditsLoading, setCreditsLoading] = useState(false);
  const [creditsRevision, setCreditsRevision] = useState(0);
  const [creditsError, setCreditsError] = useState("");
  const [loadError, setLoadError] = useState("");
  const [pendingAction, setPendingAction] = useState("");
  const pendingActionRef = useRef("");
  const groupsRequest = useRef(0);
  const selectedGroupRef = useRef<string | undefined>(undefined);
  const selected = groups.find((group) => group.id === selectedId) ?? groups[0];
  selectedGroupRef.current = selected?.id;

  const refresh = async () => {
    const request = ++groupsRequest.current;
    setLoading(true);
    try {
      const result = await listGroups();
      if (request !== groupsRequest.current) return;
      setGroups(result.groups);
      setSelectedId((current) => result.groups.some((group) => group.id === current) ? current : result.groups[0]?.id);
      setLoadError("");
    } catch (error) { if (request === groupsRequest.current) setLoadError(error instanceof Error ? error.message : "小组数据加载失败"); }
    finally { if (request === groupsRequest.current) setLoading(false); }
  };
  useEffect(() => { void refresh(); return () => { groupsRequest.current++; }; }, []);
  useEffect(() => {
    let cancelled = false;
    setCredits(undefined); setCreditsError(""); creditForm.resetFields();
    if (!selected?.id) { setCreditsLoading(false); return; }
    setCreditsLoading(true);
    void getAdminGroupCredits(selected.id).then((result) => {
      if (cancelled) return;
      setCredits(result);
      creditForm.setFieldsValue({ ...result.policy, applyCurrentPeriod: false });
    }).catch((error) => { if (!cancelled) setCreditsError(error instanceof Error ? error.message : "共享池数据加载失败"); })
      .finally(() => { if (!cancelled) setCreditsLoading(false); });
    return () => { cancelled = true; };
  }, [selected?.id, creditsRevision]);

  const runAction = async (key: string, action: () => Promise<void>) => {
    if (pendingActionRef.current) return;
    pendingActionRef.current = key; setPendingAction(key);
    try { await action(); }
    finally { pendingActionRef.current = ""; setPendingAction(""); }
  };

  const availableDesigners = useMemo(() => accounts.filter((account) =>
    account.role === "designer" && account.status === "active" && account.departmentId === selected?.departmentId &&
    !groups.some((group) => group.id !== selected?.id && group.members.some((member) => member.userId === account.id)),
  ), [accounts, groups, selected]);

  const submitGroup = (values: GroupForm) => runAction("group", async () => {
    try {
      await createGroup(values); setCreateOpen(false); groupForm.resetFields(); message.success("小组已创建"); await refresh();
    } catch (error) { message.error(error instanceof Error ? error.message : "创建失败"); }
  });
  const submitMember = (values: MemberForm) => runAction("member", async () => {
    if (!selected) return;
    try {
      await putGroupMember(selected.id, values.userId, values.role); memberForm.resetFields(); memberForm.setFieldValue("role", "member"); message.success(values.role === "leader" ? "组长已任命" : "成员已加入"); await refresh();
    } catch (error) { message.error(error instanceof Error ? error.message : "成员调整失败"); }
  });
  const removeMember = (member: GroupMember) => {
    if (!selected) return;
    modal.confirm({ title: `将 ${member.displayName} 移出小组？`, content: "移出后其本组权限立即失效，历史记录仍保留原小组归属。", okText: "移出", cancelText: "取消", okButtonProps: { danger: true }, onOk: async () => { await removeGroupMember(selected.id, member.userId); message.success("成员已移出"); await refresh(); } });
  };
  const toggleGroup = async () => {
    if (!selected) return;
    await runAction("status", async () => {
      try {
        await updateGroup(selected.id, { status: selected.status === "active" ? "disabled" : "active" });
        message.success(selected.status === "active" ? "小组已停用" : "小组已启用"); await refresh();
      } catch (error) { message.error(error instanceof Error ? error.message : "小组状态更新失败"); }
    });
  };
  const removeGroup = () => {
    if (!selected) return;
    modal.confirm({ title: `删除小组“${selected.name}”？`, content: "只有从未产生成员和历史记录的小组可以删除；其他小组请停用。", okText: "删除", cancelText: "取消", okButtonProps: { danger: true }, onOk: async () => { await deleteGroup(selected.id); message.success("小组已删除"); await refresh(); } });
  };
  const saveCreditPolicy = (values: CreditPolicyForm) => runAction("policy", async () => {
    if (!selected || !credits || creditsLoading) return;
    const groupId = selected.id;
    try {
      await updateGroupCreditPolicy(groupId, values);
      message.success(values.applyCurrentPeriod ? "共享额度规则已保存，并同步调整本月共享池" : "共享额度规则已保存，下月固定池按新值恢复");
      const result = await getAdminGroupCredits(groupId);
      if (selectedGroupRef.current !== groupId) return;
      setCredits(result);
      creditForm.setFieldsValue({ ...result.policy, applyCurrentPeriod: false });
    } catch (error) { message.error(error instanceof Error ? error.message : "共享额度规则保存失败"); }
  });
  const decideCredit = (id: string, decision: "approved" | "rejected") => runAction(`decision:${id}`, async () => {
    if (!selected) return;
    const groupId = selected.id;
    try {
      await decideAdminGroupCreditRequest(groupId, id, decision);
      message.success(decision === "approved" ? "额度已审批到账" : "申请已拒绝");
      const result = await getAdminGroupCredits(groupId);
      if (selectedGroupRef.current === groupId) setCredits(result);
    } catch (error) { message.error(error instanceof Error ? error.message : "审批失败"); }
  });

  return (
    <div className="grid min-h-[560px] gap-4 lg:grid-cols-[300px_minmax(0,1fr)]">
      <aside className="min-w-0 border-b border-[var(--border)] pb-4 lg:border-r lg:border-b-0 lg:pr-5">
        <div className="mb-3 flex items-center justify-between">
          <div><div className="text-base font-semibold">设计师小组</div><div className="text-xs text-[var(--muted-foreground)]">{groups.length} 个小组</div></div>
          <Button className="!h-10" type="primary" disabled={Boolean(pendingAction)} icon={<Plus className="size-4" />} onClick={() => setCreateOpen(true)}>新建</Button>
        </div>
        <div className="space-y-2">
          {loadError ? <Alert type="warning" title="小组列表暂未更新" description={loadError} action={<Button loading={loading} onClick={() => void refresh()}>重试</Button>} /> : null}
          {loading && !groups.length ? <Skeleton active paragraph={{ rows: 4 }} /> : null}
          {groups.map((group) => (
            <button key={group.id} type="button" aria-pressed={selected?.id === group.id} disabled={Boolean(pendingAction)} onClick={() => { if (!pendingActionRef.current) setSelectedId(group.id); }} className="w-full rounded-xl border px-4 py-3 text-left transition hover:opacity-80 disabled:cursor-wait" style={{ borderColor: selected?.id === group.id ? "var(--foreground)" : "var(--border)", background: selected?.id === group.id ? "var(--muted)" : "var(--card)" }}>
              <div className="flex items-center justify-between gap-2"><span className="truncate font-medium">{group.name}</span><Tag color={group.status === "active" ? "green" : "default"}>{group.status === "active" ? "启用" : "停用"}</Tag></div>
              <div className="mt-1 text-xs text-[var(--muted-foreground)]">{group.departmentName} · {group.members.length} 人</div>
            </button>
          ))}
          {!loading && !groups.length ? <div className="border border-dashed border-stone-300 px-4 py-10 text-center text-sm text-[var(--muted-foreground)]">尚未创建小组</div> : null}
        </div>
      </aside>

      <section className="min-w-0">
        {selected ? <>
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3 border-b border-[var(--border)] pb-4">
            <div><h2 className="text-xl font-semibold">{selected.name}</h2><p className="text-sm text-[var(--muted-foreground)]">{selected.departmentName} · 编码 {selected.code}</p></div>
            <Space wrap><Button className="!h-10" loading={pendingAction === "status"} disabled={Boolean(pendingAction)} icon={<Power className="size-4" />} onClick={() => void toggleGroup()}>{selected.status === "active" ? "停用" : "启用"}</Button><Button className="!h-10" disabled={Boolean(pendingAction)} danger icon={<Trash2 className="size-4" />} onClick={removeGroup}>删除</Button></Space>
          </div>
          <section className="wb-surface mb-5 p-5" aria-busy={creditsLoading}>
            <div className="mb-4 flex flex-wrap items-start justify-between gap-3"><div><div className="flex items-center gap-2 font-semibold"><HandCoins className="size-4" />小组共享积分池</div><p className="mt-1 text-xs text-[var(--muted-foreground)]">只有管理员可设置总池和上限；领取额度本月有效，月底统一清零</p></div><div className="text-right"><div className="text-xs text-[var(--muted-foreground)]">本月可用池</div><div className="text-2xl font-semibold tabular-nums">{credits ? `${credits.period.poolBalance} 积分` : "—"}</div></div></div>
            {creditsLoading ? <p className="mb-4 text-sm text-[var(--muted-foreground)]" role="status">正在读取当前小组的额度规则…</p> : null}
            {creditsError ? <Alert className="mb-4" type="warning" title="共享池规则暂不可用" description={creditsError} action={<Button onClick={() => setCreditsRevision((current) => current + 1)}>重试</Button>} /> : null}
            <Form form={creditForm} disabled={creditsLoading || !credits || Boolean(pendingAction)} layout="vertical" onFinish={saveCreditPolicy}>
              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                <Form.Item name="monthlySharedCreditLimit" label="每月固定共享池" rules={[{ required: true }]}><InputNumber className="w-full" min={0} max={10000000} /></Form.Item>
                <Form.Item name="perRequestLimit" label="单次领取上限" rules={[{ required: true }]}><InputNumber className="w-full" min={0} max={10000000} /></Form.Item>
                <Form.Item name="dailyUserLimit" label="每人每日上限" rules={[{ required: true }]}><InputNumber className="w-full" min={0} max={10000000} /></Form.Item>
                <Form.Item name="monthlyUserLimit" label="每人每月上限" rules={[{ required: true }]}><InputNumber className="w-full" min={0} max={10000000} /></Form.Item>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-3"><div className="flex items-center"><Form.Item name="applyCurrentPeriod" valuePropName="checked" noStyle><Switch /></Form.Item><span className="ml-2 text-sm">同步调整本月固定池</span></div><Button className="!h-10" loading={pendingAction === "policy"} type="primary" htmlType="submit">保存共享额度规则</Button></div>
            </Form>
          </section>
          <Form form={memberForm} disabled={Boolean(pendingAction)} layout="inline" initialValues={{ role: "member" }} onFinish={submitMember} className="mb-4 flex gap-2">
            <Form.Item name="userId" rules={[{ required: true, message: "请选择设计师" }]} className="min-w-[240px] flex-1"><Select showSearch optionFilterProp="label" placeholder="选择本部门设计师" options={availableDesigners.map((account) => ({ value: account.id, label: `${account.displayName}（${account.username}）` }))} /></Form.Item>
            <Form.Item name="role"><Select className="w-28" options={[{ value: "member", label: "普通成员" }, { value: "leader", label: "任命组长" }]} /></Form.Item>
            <Form.Item><Button className="!h-10" loading={pendingAction === "member"} type="primary" htmlType="submit" icon={<UserPlus className="size-4" />} disabled={selected.status !== "active"}>加入小组</Button></Form.Item>
          </Form>
          <Table className="wb-surface overflow-hidden" rowKey="id" size="small" scroll={{ x: 640 }} pagination={false} dataSource={selected.members} columns={[
            { title: "姓名", dataIndex: "displayName" },
            { title: "账号", dataIndex: "username" },
            { title: "小组身份", render: (_, member: GroupMember) => <Tag color={member.role === "leader" ? "orange" : "default"} icon={member.role === "leader" ? <Crown className="size-3" /> : undefined}>{member.role === "leader" ? "组长" : "成员"}</Tag> },
            { title: "加入时间", dataIndex: "effectiveAt", render: (value: string) => new Date(value).toLocaleString("zh-CN") },
            { title: "操作", width: 100, render: (_, member: GroupMember) => <Button size="small" danger icon={<UserMinus className="size-3.5" />} onClick={() => removeMember(member)}>移出</Button> },
          ]} />
          <div className="mt-5 border-t border-[var(--border)] pt-4"><div className="mb-3 font-semibold">共享额度申请</div><Table loading={creditsLoading} rowKey="id" size="small" scroll={{ x: 640 }} pagination={{ pageSize: 8 }} dataSource={credits?.requests ?? []} columns={[
            { title: "成员", dataIndex: "userName" }, { title: "积分", dataIndex: "amount" }, { title: "用途", dataIndex: "reason" },
            { title: "状态", dataIndex: "status", render: (value: string) => <Tag color={value === "approved" ? "green" : value === "pending" ? "orange" : value === "rejected" ? "red" : "default"}>{value === "approved" ? "已到账" : value === "pending" ? "待审批" : value === "rejected" ? "已拒绝" : "已过期"}</Tag> },
            { title: "操作", render: (_, row) => row.status === "pending" ? <Space><Button size="small" loading={pendingAction === `decision:${row.id}`} disabled={Boolean(pendingAction)} type="primary" onClick={() => void decideCredit(row.id, "approved")}>通过</Button><Button size="small" disabled={Boolean(pendingAction)} danger onClick={() => void decideCredit(row.id, "rejected")}>拒绝</Button></Space> : "-" },
          ]} /></div>
        </> : <div className="flex h-full items-center justify-center text-[var(--muted-foreground)]">请先创建或选择小组</div>}
      </section>

      <Modal title="新建设计师小组" open={createOpen} onCancel={() => { if (!pendingAction) setCreateOpen(false); }} keyboard={!pendingAction} maskClosable={!pendingAction} footer={null} destroyOnHidden>
        <Form form={groupForm} disabled={Boolean(pendingAction)} layout="vertical" onFinish={submitGroup}>
          <Form.Item name="name" label="小组名称" rules={[{ required: true }]}><Input placeholder="例如：花型设计一组" /></Form.Item>
          <Form.Item name="code" label="小组编码" rules={[{ required: true }]}><Input placeholder="例如：pattern-a" /></Form.Item>
          <Form.Item name="departmentId" label="所属部门" rules={[{ required: true }]}><Select options={departments.map((department) => ({ value: department.id, label: department.name }))} /></Form.Item>
          <Button className="!h-10" loading={pendingAction === "group"} type="primary" htmlType="submit" block>创建小组</Button>
        </Form>
      </Modal>
    </div>
  );
}
