import type {
  BoardNodeScheduleBeforeRun,
  BoardSaveNodeScheduleInput,
} from "@t3tools/board-core/http";
import { timingOfTask } from "@t3tools/board-core/timing";
import type { ScheduledTask } from "@t3tools/contracts";

import { scheduleSummary, timingFormOf, timingOf, type TimingForm } from "./scheduleTiming";

export interface ScheduleForm {
  readonly prompt: string;
  readonly timing: TimingForm;
  readonly beforeRun: BoardNodeScheduleBeforeRun;
}

export function formOf(task: ScheduledTask | null): ScheduleForm {
  const runsLeft = task ? scheduleSummary(task).runsLeft : null;
  return {
    prompt: task?.prompt ?? "",
    timing: timingFormOf(
      task ? timingOfTask(task) : null,
      task === null ? "3" : runsLeft ? String(runsLeft) : "",
    ),
    // Compacting keeps what the agent learned while each firing starts from a small context.
    beforeRun: task === null ? "compact" : (task.beforeRun ?? "none"),
  };
}

/** The save request, or null while the form is incomplete. */
export function scheduleInput(form: ScheduleForm): BoardSaveNodeScheduleInput | null {
  const prompt = form.prompt.trim();
  const timing = timingOf(form.timing);
  if (prompt.length === 0 || timing === null) return null;
  return { prompt, beforeRun: form.beforeRun, ...timing };
}
