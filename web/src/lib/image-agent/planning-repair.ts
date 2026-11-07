import { isImageAgentPlanningIssue, type ImageAgentPlanningIssue } from "../../../../shared/image-agent-iteration";

export type ImageAgentRepairBudget = { used: boolean };
/** At most one new planning call, exclusively after a known validation refusal and before any execution. */
export async function requestImageAgentPlanWithRepair<Result, Value>(options: {
    budget: ImageAgentRepairBudget;
    request: (issue?: ImageAgentPlanningIssue) => Promise<Result>;
    validate: (result: Result) => Value;
    signal?: AbortSignal;
    canRepair?: () => boolean;
    onRepair?: () => void;
}): Promise<Value> {
    options.signal?.throwIfAborted();
    try {
        const result = await options.request();
        options.signal?.throwIfAborted();
        return options.validate(result);
    } catch (error) {
        options.signal?.throwIfAborted();
        if (options.budget.used || !isImageAgentPlanningIssue(error) || options.canRepair?.() === false) throw error;
        options.budget.used = true;
        options.onRepair?.();
        const issue: ImageAgentPlanningIssue = { code: error.code, message: error.message, repairable: true, submitted: false };
        const result = await options.request(issue);
        options.signal?.throwIfAborted();
        return options.validate(result);
    }
}
