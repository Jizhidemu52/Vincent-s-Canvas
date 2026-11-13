import { displayNotice, useDisplayUiValue, useDisplayConfig  } from "@/hooks/use-display-text";
import { staticUiText } from "@/lib/static-ui-copy";
import { useUiLocale } from "@/lib/i18n";
import { Alert, App, Button, Form, Input, Modal, Select, Skeleton, Space, Table, Tag } from "antd";
import { Crown, Plus, Power, Trash2, UserMinus, UserPlus } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import type { ApiUser } from "@/services/api/auth";
import type { Department } from "@/services/api/admin-accounts";
import { createGroup, deleteGroup, listGroups, putGroupMember, removeGroupMember, updateGroup, type DesignerGroup, type GroupMember } from "@/services/api/groups";

type GroupForm = { name: string; code: string; departmentId: string };
type MemberForm = { userId: string; role: "member" | "leader" };

export function GroupManagementPanel({ accounts, departments }: { accounts: ApiUser[]; departments: Department[] }) {
    const displayUi = useDisplayUiValue();
    const displayConfig = useDisplayConfig();
    useUiLocale();
  const { message, modal } = App.useApp();
  const [groupForm] = Form.useForm<GroupForm>();
  const [memberForm] = Form.useForm<MemberForm>();
  const [groups, setGroups] = useState<DesignerGroup[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [pendingAction, setPendingAction] = useState("");
  const pendingActionRef = useRef("");
  const groupsRequest = useRef(0);
  const selected = groups.find((group) => group.id === selectedId) ?? groups[0];

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
      await createGroup(values); setCreateOpen(false); groupForm.resetFields(); message.success(staticUiText("小组已创建")); await refresh();
    } catch (error) { message.error(displayNotice(error instanceof Error ? error.message : staticUiText("创建失败"))); }
  });
  const submitMember = (values: MemberForm) => runAction("member", async () => {
    if (!selected) return;
    try {
      await putGroupMember(selected.id, values.userId, values.role); memberForm.resetFields(); memberForm.setFieldValue("role", "member"); message.success(displayNotice(values.role === "leader" ? staticUiText("组长已任命") : staticUiText("成员已加入"))); await refresh();
    } catch (error) { message.error(displayNotice(error instanceof Error ? error.message : staticUiText("成员调整失败"))); }
  });
  const removeMember = (member: GroupMember) => {
    if (!selected) return;
    modal.confirm({ title: staticUiText("将 {p0} 移出小组？", { p0: `${member.displayName}` }), content: staticUiText("移出后其本组权限立即失效，历史记录仍保留原小组归属。"), okText: staticUiText("移出"), cancelText: staticUiText("取消"), okButtonProps: { danger: true }, onOk: async () => { await removeGroupMember(selected.id, member.userId); message.success(staticUiText("成员已移出")); await refresh(); } });
  };
  const toggleGroup = async () => {
    if (!selected) return;
    await runAction("status", async () => {
      try {
        await updateGroup(selected.id, { status: selected.status === "active" ? "disabled" : "active" });
        message.success(displayNotice(selected.status === "active" ? staticUiText("小组已停用") : staticUiText("小组已启用"))); await refresh();
      } catch (error) { message.error(displayNotice(error instanceof Error ? error.message : staticUiText("小组状态更新失败"))); }
    });
  };
  const removeGroup = () => {
    if (!selected) return;
    modal.confirm({ title: staticUiText("删除小组“{p0}”？", { p0: `${selected.name}` }), content: staticUiText("只有从未产生成员和历史记录的小组可以删除；其他小组请停用。"), okText: staticUiText("删除"), cancelText: staticUiText("取消"), okButtonProps: { danger: true }, onOk: async () => { await deleteGroup(selected.id); message.success(staticUiText("小组已删除")); await refresh(); } });
  };

  return (
    <div className="grid min-h-[560px] gap-4 lg:grid-cols-[300px_minmax(0,1fr)]">
      <aside className="min-w-0 border-b border-[var(--border)] pb-4 lg:border-r lg:border-b-0 lg:pr-5">
        <div className="mb-3 flex items-center justify-between">
          <div><div className="text-base font-semibold">{staticUiText("设计师小组")}</div><div className="text-xs text-[var(--muted-foreground)]">{groups.length}{staticUiText(" 个小组")}</div></div>
          <Button className="!h-10" type="primary" disabled={Boolean(pendingAction)} icon={<Plus className="size-4" />} onClick={() => setCreateOpen(true)}>{staticUiText("新建")}</Button>
        </div>
        <div className="space-y-2">
          {loadError ? <Alert type="warning" title={staticUiText("小组列表暂未更新")} description={displayUi(loadError)} action={<Button loading={loading} onClick={() => void refresh()}>{staticUiText("重试")}</Button>} /> : null}
          {loading && !groups.length ? <Skeleton active paragraph={{ rows: 4 }} /> : null}
          {groups.map((group) => (
            <button key={group.id} type="button" aria-pressed={selected?.id === group.id} disabled={Boolean(pendingAction)} onClick={() => { if (!pendingActionRef.current) setSelectedId(group.id); }} className="w-full rounded-xl border px-4 py-3 text-left transition hover:opacity-80 disabled:cursor-wait" style={{ borderColor: selected?.id === group.id ? "var(--foreground)" : "var(--border)", background: selected?.id === group.id ? "var(--muted)" : "var(--card)" }}>
              <div className="flex items-center justify-between gap-2"><span className="truncate font-medium">{displayUi(group.name)}</span><Tag color={group.status === "active" ? "green" : "default"}>{group.status === "active" ? staticUiText("启用") : staticUiText("停用")}</Tag></div>
              <div className="mt-1 text-xs text-[var(--muted-foreground)]">{displayUi(group.departmentName)} · {group.members.length}{staticUiText(" 人")}</div>
            </button>
          ))}
          {!loading && !groups.length ? <div className="border border-dashed border-stone-300 px-4 py-10 text-center text-sm text-[var(--muted-foreground)]">{staticUiText("尚未创建小组")}</div> : null}
        </div>
      </aside>

      <section className="min-w-0">
        {selected ? <>
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3 border-b border-[var(--border)] pb-4">
            <div><h2 className="text-xl font-semibold">{displayUi(selected.name)}</h2><p className="text-sm text-[var(--muted-foreground)]">{displayUi(selected.departmentName)}{staticUiText(" · 编码 ")}{selected.code}</p></div>
            <Space wrap><Button className="!h-10" loading={pendingAction === "status"} disabled={Boolean(pendingAction)} icon={<Power className="size-4" />} onClick={() => void toggleGroup()}>{selected.status === "active" ? staticUiText("停用") : staticUiText("启用")}</Button><Button className="!h-10" disabled={Boolean(pendingAction)} danger icon={<Trash2 className="size-4" />} onClick={removeGroup}>{staticUiText("删除")}</Button></Space>
          </div>
          <Form form={memberForm} disabled={Boolean(pendingAction)} layout="inline" initialValues={{ role: "member" }} onFinish={submitMember} className="mb-4 flex gap-2">
            <Form.Item name="userId" rules={[{ required: true, message: staticUiText("请选择设计师") }]} className="min-w-[240px] flex-1"><Select showSearch optionFilterProp="label" placeholder={staticUiText("选择本部门设计师")} options={displayConfig(availableDesigners.map((account) => ({ value: account.id, label: `${account.displayName}（${account.username}）` })), "options")} /></Form.Item>
            <Form.Item name="role"><Select className="w-28" options={displayConfig([{ value: "member", label: staticUiText("普通成员") }, { value: "leader", label: staticUiText("任命组长") }], "options")} /></Form.Item>
            <Form.Item><Button className="!h-10" loading={pendingAction === "member"} type="primary" htmlType="submit" icon={<UserPlus className="size-4" />} disabled={selected.status !== "active"}>{staticUiText("加入小组")}</Button></Form.Item>
          </Form>
          <Table className="wb-surface overflow-hidden" rowKey="id" size="small" scroll={{ x: 640 }} pagination={false} dataSource={selected.members} columns={displayConfig([
            { title: staticUiText("姓名"), dataIndex: "displayName" },
            { title: staticUiText("账号"), dataIndex: "username" },
            { title: staticUiText("小组身份"), render: (_, member: GroupMember) => <Tag color={member.role === "leader" ? "orange" : "default"} icon={member.role === "leader" ? <Crown className="size-3" /> : undefined}>{member.role === "leader" ? staticUiText("组长") : staticUiText("成员")}</Tag> },
            { title: staticUiText("加入时间"), dataIndex: "effectiveAt", render: (value: string) => new Date(value).toLocaleString("zh-CN") },
            { title: staticUiText("操作"), width: 100, render: (_, member: GroupMember) => <Button size="small" danger icon={<UserMinus className="size-3.5" />} onClick={() => removeMember(member)}>{staticUiText("移出")}</Button> },
          ], "columns", selected.members)} />
        </> : <div className="flex h-full items-center justify-center text-[var(--muted-foreground)]">{staticUiText("请先创建或选择小组")}</div>}
      </section>

      <Modal title={staticUiText("新建设计师小组")} open={createOpen} onCancel={() => { if (!pendingAction) setCreateOpen(false); }} keyboard={!pendingAction} maskClosable={!pendingAction} footer={null} destroyOnHidden>
        <Form form={groupForm} disabled={Boolean(pendingAction)} layout="vertical" onFinish={submitGroup}>
          <Form.Item name="name" label={staticUiText("小组名称")} rules={[{ required: true }]}><Input placeholder={staticUiText("例如：花型设计一组")} /></Form.Item>
          <Form.Item name="code" label={staticUiText("小组编码")} rules={[{ required: true }]}><Input placeholder={staticUiText("例如：pattern-a")} /></Form.Item>
          <Form.Item name="departmentId" label={staticUiText("所属部门")} rules={[{ required: true }]}><Select options={displayConfig(departments.map((department) => ({ value: department.id, label: department.name })), "options")} /></Form.Item>
          <Button className="!h-10" loading={pendingAction === "group"} type="primary" htmlType="submit" block>{staticUiText("创建小组")}</Button>
        </Form>
      </Modal>
    </div>
  );
}
