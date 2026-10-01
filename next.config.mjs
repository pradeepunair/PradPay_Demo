import { assertProtectedSourceIsClean, resolveWorkflowBuildControl } from "./lib/workflows/build-control.mjs";

const nextConfig = {
  turbopack: {
    root: import.meta.dirname,
  },
};

const workflowBuild = resolveWorkflowBuildControl();
assertProtectedSourceIsClean(workflowBuild, import.meta.dirname);
const workflowConfig = workflowBuild.composeWorkflow
  ? (await import("workflow/next")).withWorkflow(nextConfig)
  : nextConfig;

export default workflowConfig;
