import { Alert, App, Button, Form, Input, Modal, Select, Table } from "antd";
import { useQuery } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { useUserStore } from "@/stores/use-user-store";
import { listTaskReconciliation, resolveUncertainChat, resolveUncertainTask, type TaskResolution, type UncertainChat, type UncertainTask } from "@/services/api/task-reconciliation";

type Selection = { kind: "task"; row: UncertainTask } | { kind: "chat"; row: UncertainChat };
type Values = { decision: string; reason: string; evidenceReference: string; upstreamTaskId?: string; assetIds?: string };

export function TaskReconciliationPanel({ active, onResolved }: { active: boolean; onResolved: () => Promise<unknown> }) {
  const { message } = App.useApp();
  const userId = useUserStore(state => state.user?.id);
  const [selected, setSelected] = useState<Selection | null>(null);
  const [saving, setSaving] = useState(false);
  const submitting = useRef(false);
  const [form] = Form.useForm<Values>();
  const decision = Form.useWatch("decision", form);
  const query = useQuery({ queryKey: ["task-reconciliation", userId], queryFn: listTaskReconciliation, enabled: active, retry: false, refetchOnWindowFocus: false });
  function open(value: Selection) { form.resetFields(); setSelected(value); }
  async function submit(values: Values) {
    if (!selected || submitting.current) return;
    submitting.current = true; setSaving(true);
    try {
      const evidence = { reason: values.reason.trim(), evidenceReference: values.evidenceReference.trim() };
      if (selected.kind === "chat") await resolveUncertainChat(selected.row.requestId, { ...evidence, action: values.decision as "capture" | "release" });
      else {
        const body: TaskResolution = values.decision === "attach_upstream"
          ? { ...evidence, decision: "attach_upstream", upstreamTaskId: values.upstreamTaskId!.trim() }
          : values.decision === "confirmed_success"
            ? { ...evidence, decision: "confirmed_success", ...(values.assetIds?.trim() ? { resultAssetIds: values.assetIds.trim().split(/[\s,，]+/) } : {}) }
            : { ...evidence, decision: values.decision as "confirmed_failed" | "confirmed_not_submitted" };
        const result = await resolveUncertainTask(selected.row.id, body);
        if (result.queuePending) message.warning("原上游编号已保存，队列恢复后继续查询；请勿重新生成");
      }
      message.success("核查结论已保存并写入审计日志"); setSelected(null);
      await Promise.all([query.refetch(), onResolved()]);
    } catch (error) { message.error(error instanceof Error ? error.message : "核查未完成"); await query.refetch(); }
    finally { submitting.current = false; setSaving(false); }
  }
  const commonColumns = [
    { title: "员工", dataIndex: "displayName", width: 110 }, { title: "模型", dataIndex: "modelName", width: 150 },
    { title: "请求编号", dataIndex: "requestId", ellipsis: true }, { title: "冻结积分", dataIndex: "credits", width: 100 },
  ];
  return <section className="wb-surface grid min-w-0 gap-3 p-4" aria-label="待核查结算">
    <div className="flex items-center justify-between gap-3"><h3>待核查结算</h3><Button loading={query.isFetching} onClick={() => void query.refetch()}>刷新核查列表</Button></div>
    <Alert type="warning" showIcon title="先核实供应商记录，再结案" description={`超时不等于未扣费；未知任务不会自动退款或重提。下方包括暂停任务，以及超过 ${query.data?.minimumChatAgeMinutes ?? 30} 分钟仍冻结的对话。每类最多展示 100 条。`} />
    {query.error ? <Alert type="error" title="核查列表未能加载" description={query.error.message} /> : null}
    <Table<UncertainTask> className="min-w-0 overflow-hidden" size="small" rowKey="id" loading={query.isPending} dataSource={query.data?.tasks ?? []} pagination={false} scroll={{ x: 850 }} columns={[
      ...commonColumns, { title: "原因", dataIndex: "failureReason", ellipsis: true },
      { title: "操作", width: 90, render: (_, row) => <Button onClick={() => open({ kind: "task", row })}>核查任务</Button> },
    ]} />
    <Table<UncertainChat> className="min-w-0 overflow-hidden" size="small" rowKey="id" dataSource={query.data?.chats ?? []} pagination={false} scroll={{ x: 850 }} columns={[
      ...commonColumns, { title: "开始时间", dataIndex: "createdAt", width: 180 },
      { title: "操作", width: 90, render: (_, row) => <Button onClick={() => open({ kind: "chat", row })}>核查对话</Button> },
    ]} />
    <Modal open={Boolean(selected)} title="核查原任务并结案" onCancel={() => { if (!saving) setSelected(null); }} onOk={() => form.submit()} confirmLoading={saving} okText="保存核查结论" cancelText="返回" mask={{ closable: false }}>
      <p className="mb-3 break-all text-xs">{selected?.row.requestId}</p>
      <Form form={form} layout="vertical" onFinish={submit} disabled={saving}>
        <Form.Item name="decision" label="已核实结论" rules={[{ required: true, message: "请选择核实后的结论" }]}><Select options={selected?.kind === "chat" ? [
          { value: "capture", label: "已确认有效输出：结算积分" }, { value: "release", label: "已确认失败 / 未提交：释放积分" },
        ] : [
          { value: "confirmed_failed", label: "供应商已确认失败：释放积分" }, { value: "confirmed_not_submitted", label: "已确认未提交：取消并释放积分" },
          { value: "confirmed_success", label: "已确认成功：交付结果并结算" },
          ...(selected?.kind === "task" && selected.row.canAttachUpstream ? [{ value: "attach_upstream", label: "按原上游编号恢复查询，不重新生成" }] : []),
        ]} /></Form.Item>
        {selected?.kind === "task" && decision === "attach_upstream" ? <Form.Item name="upstreamTaskId" label="原上游任务编号" initialValue={selected.row.upstreamTaskId ?? ""} rules={[{ required: true, whitespace: true, max: 500 }]}><Input /></Form.Item> : null}
        {selected?.kind === "task" && decision === "confirmed_success" ? <Form.Item name="assetIds" label="结果素材 UUID（逗号或换行分隔）" extra="必须属于原员工且媒体类型正确；留空只会使用已有且已验证的任务结果。"><Input.TextArea rows={2} /></Form.Item> : null}
        <Form.Item name="reason" label="核查理由" rules={[{ required: true, whitespace: true, min: 2, max: 1000 }]}><Input.TextArea rows={3} maxLength={1000} /></Form.Item>
        <Form.Item name="evidenceReference" label="供应商工单 / 账单 / 核查记录编号" rules={[{ required: true, whitespace: true, min: 3, max: 1000 }]}><Input maxLength={1000} /></Form.Item>
      </Form>
    </Modal>
  </section>;
}
