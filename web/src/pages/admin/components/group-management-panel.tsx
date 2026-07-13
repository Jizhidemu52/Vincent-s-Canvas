import { App, Button, Form, Input, Modal, Select, Space, Table, Tag } from "antd";
import { Crown, Plus, Power, Trash2, UserMinus, UserPlus } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import type { ApiUser } from "@/services/api/auth";
import type { Department } from "@/services/api/admin-accounts";
import { createGroup, deleteGroup, listGroups, putGroupMember, removeGroupMember, updateGroup, type DesignerGroup, type GroupMember } from "@/services/api/groups";

type GroupForm = { name: string; code: string; departmentId: string };
type MemberForm = { userId: string; role: "member" | "leader" };

export function GroupManagementPanel({ accounts, departments }: { accounts: ApiUser[]; departments: Department[] }) {
  const { message, modal } = App.useApp();
  const [groupForm] = Form.useForm<GroupForm>();
  const [memberForm] = Form.useForm<MemberForm>();
  const [groups, setGroups] = useState<DesignerGroup[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const selected = groups.find((group) => group.id === selectedId) ?? groups[0];

  const refresh = async () => {
    setLoading(true);
    try {
      const result = await listGroups();
      setGroups(result.groups);
      setSelectedId((current) => result.groups.some((group) => group.id === current) ? current : result.groups[0]?.id);
    } catch (error) { message.error(error instanceof Error ? error.message : "小组数据加载失败"); }
    finally { setLoading(false); }
  };
  useEffect(() => { void refresh(); }, []);

  const availableDesigners = useMemo(() => accounts.filter((account) =>
    account.role === "designer" && account.status === "active" && account.departmentId === selected?.departmentId &&
    !groups.some((group) => group.id !== selected?.id && group.members.some((member) => member.userId === account.id)),
  ), [accounts, groups, selected]);

  const submitGroup = async (values: GroupForm) => {
    try {
      await createGroup(values); setCreateOpen(false); groupForm.resetFields(); message.success("小组已创建"); await refresh();
    } catch (error) { message.error(error instanceof Error ? error.message : "创建失败"); }
  };
  const submitMember = async (values: MemberForm) => {
    if (!selected) return;
    try {
      await putGroupMember(selected.id, values.userId, values.role); memberForm.resetFields(); memberForm.setFieldValue("role", "member"); message.success(values.role === "leader" ? "组长已任命" : "成员已加入"); await refresh();
    } catch (error) { message.error(error instanceof Error ? error.message : "成员调整失败"); }
  };
  const removeMember = (member: GroupMember) => {
    if (!selected) return;
    modal.confirm({ title: `将 ${member.displayName} 移出小组？`, content: "移出后其本组权限立即失效，历史记录仍保留原小组归属。", okText: "移出", cancelText: "取消", okButtonProps: { danger: true }, onOk: async () => { await removeGroupMember(selected.id, member.userId); message.success("成员已移出"); await refresh(); } });
  };
  const toggleGroup = async () => {
    if (!selected) return;
    await updateGroup(selected.id, { status: selected.status === "active" ? "disabled" : "active" });
    message.success(selected.status === "active" ? "小组已停用" : "小组已启用"); await refresh();
  };
  const removeGroup = () => {
    if (!selected) return;
    modal.confirm({ title: `删除小组“${selected.name}”？`, content: "只有从未产生成员和历史记录的小组可以删除；其他小组请停用。", okText: "删除", cancelText: "取消", okButtonProps: { danger: true }, onOk: async () => { await deleteGroup(selected.id); message.success("小组已删除"); await refresh(); } });
  };

  return (
    <div className="grid min-h-[560px] gap-4 lg:grid-cols-[300px_minmax(0,1fr)]">
      <aside className="border-r border-stone-200 pr-4 dark:border-stone-800">
        <div className="mb-3 flex items-center justify-between">
          <div><div className="text-base font-semibold">设计师小组</div><div className="text-xs text-stone-500">{groups.length} 个小组</div></div>
          <Button type="primary" icon={<Plus className="size-4" />} onClick={() => setCreateOpen(true)}>新建</Button>
        </div>
        <div className="space-y-2">
          {groups.map((group) => (
            <button key={group.id} type="button" onClick={() => setSelectedId(group.id)} className={`w-full rounded-md border px-3 py-3 text-left transition ${selected?.id === group.id ? "border-orange-500 bg-orange-50" : "border-stone-200 bg-white hover:border-orange-300"}`}>
              <div className="flex items-center justify-between gap-2"><span className="truncate font-medium">{group.name}</span><Tag color={group.status === "active" ? "green" : "default"}>{group.status === "active" ? "启用" : "停用"}</Tag></div>
              <div className="mt-1 text-xs text-stone-500">{group.departmentName} · {group.members.length} 人</div>
            </button>
          ))}
          {!loading && !groups.length ? <div className="border border-dashed border-stone-300 px-4 py-10 text-center text-sm text-stone-500">尚未创建小组</div> : null}
        </div>
      </aside>

      <section className="min-w-0">
        {selected ? <>
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3 border-b border-stone-200 pb-4">
            <div><h2 className="text-xl font-semibold">{selected.name}</h2><p className="text-sm text-stone-500">{selected.departmentName} · 编码 {selected.code}</p></div>
            <Space wrap><Button icon={<Power className="size-4" />} onClick={() => void toggleGroup()}>{selected.status === "active" ? "停用" : "启用"}</Button><Button danger icon={<Trash2 className="size-4" />} onClick={removeGroup}>删除</Button></Space>
          </div>
          <Form form={memberForm} layout="inline" initialValues={{ role: "member" }} onFinish={submitMember} className="mb-4 flex gap-2">
            <Form.Item name="userId" rules={[{ required: true, message: "请选择设计师" }]} className="min-w-[240px] flex-1"><Select showSearch optionFilterProp="label" placeholder="选择本部门设计师" options={availableDesigners.map((account) => ({ value: account.id, label: `${account.displayName}（${account.username}）` }))} /></Form.Item>
            <Form.Item name="role"><Select className="w-28" options={[{ value: "member", label: "普通成员" }, { value: "leader", label: "任命组长" }]} /></Form.Item>
            <Form.Item><Button type="primary" htmlType="submit" icon={<UserPlus className="size-4" />} disabled={selected.status !== "active"}>加入小组</Button></Form.Item>
          </Form>
          <Table rowKey="id" size="small" pagination={false} dataSource={selected.members} columns={[
            { title: "姓名", dataIndex: "displayName" },
            { title: "账号", dataIndex: "username" },
            { title: "小组身份", render: (_, member: GroupMember) => <Tag color={member.role === "leader" ? "orange" : "default"} icon={member.role === "leader" ? <Crown className="size-3" /> : undefined}>{member.role === "leader" ? "组长" : "成员"}</Tag> },
            { title: "加入时间", dataIndex: "effectiveAt", render: (value: string) => new Date(value).toLocaleString("zh-CN") },
            { title: "操作", width: 100, render: (_, member: GroupMember) => <Button size="small" danger icon={<UserMinus className="size-3.5" />} onClick={() => removeMember(member)}>移出</Button> },
          ]} />
        </> : <div className="flex h-full items-center justify-center text-stone-500">请先创建或选择小组</div>}
      </section>

      <Modal title="新建设计师小组" open={createOpen} onCancel={() => setCreateOpen(false)} footer={null} destroyOnHidden>
        <Form form={groupForm} layout="vertical" onFinish={submitGroup}>
          <Form.Item name="name" label="小组名称" rules={[{ required: true }]}><Input placeholder="例如：花型设计一组" /></Form.Item>
          <Form.Item name="code" label="小组编码" rules={[{ required: true }]}><Input placeholder="例如：pattern-a" /></Form.Item>
          <Form.Item name="departmentId" label="所属部门" rules={[{ required: true }]}><Select options={departments.map((department) => ({ value: department.id, label: department.name }))} /></Form.Item>
          <Button type="primary" htmlType="submit" block>创建小组</Button>
        </Form>
      </Modal>
    </div>
  );
}
