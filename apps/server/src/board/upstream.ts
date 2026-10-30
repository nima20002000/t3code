// The board's only door into t3's server: every upstream module board code uses is re-exported here,
// so an upstream merge that breaks the board breaks this file. scripts/fork-boundary.mjs enforces it.
export * as AuthHttp from "../auth/http.ts";
export * as ServerEnvironment from "../environment/ServerEnvironment.ts";
export * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
export * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
export * as Scheduler from "../scheduling/Scheduler.ts";
export { forkParked } from "../serverActivation.ts";
export * as ProjectFolderRemoval from "../project/ProjectFolderRemoval.ts";
export * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
export * as ProjectService from "../project/ProjectService.ts";
export * as ScheduledTasks from "../scheduledTasks/ScheduledTaskService.ts";
export * as PreviewManager from "../preview/Manager.ts";
export * as TaskSchedule from "../scheduledTasks/Schedule.ts";
export * as ServerConfig from "../config.ts";
export * as ServerSelfUpdate from "../cloud/selfUpdate.ts";
export * as ServiceLauncherClient from "../cloud/serviceLauncherClient.ts";
export * as ServerLifecycleEvents from "../serverLifecycleEvents.ts";
export * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import packageJson from "../../package.json" with { type: "json" };
/** The t3 version this server runs. */
export const serverVersion = packageJson.version;
