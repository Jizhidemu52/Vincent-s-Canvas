export const workflowPollWindow = `(CASE WHEN upstream_workflow_context->>'timeoutSeconds' ~ '^[0-9]{1,4}$'
  THEN LEAST(7200,GREATEST(30,(upstream_workflow_context->>'timeoutSeconds')::int)) ELSE 600 END * interval '1 second')`;
