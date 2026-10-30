import type { TimingForm } from "./scheduleTiming";
import { Button } from "./upstream";

const FIELD_CLASS = "h-8 w-full rounded-md border bg-background px-2 text-sm";
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** When a schedule fires and how often; the node and workflow schedule editors share it. */
export function ScheduleTimingFields(props: {
  readonly form: TimingForm;
  readonly onChange: (patch: Partial<TimingForm>) => void;
  /** Whose clock a time of day is read on. */
  readonly clock: string;
}) {
  const { form, onChange } = props;
  return (
    <>
      <label className="grid gap-1 text-xs text-muted-foreground">
        When
        <select
          className={FIELD_CLASS}
          value={form.mode}
          onChange={(event) => onChange({ mode: event.target.value as TimingForm["mode"] })}
        >
          <option value="interval">Every few minutes</option>
          <option value="time">At a time of day</option>
          <option value="once">Once, at a date and time</option>
        </select>
      </label>
      {form.mode === "interval" ? (
        <label className="grid gap-1 text-xs text-muted-foreground">
          Every (minutes, at least 1)
          <input
            className={FIELD_CLASS}
            type="number"
            min={1}
            value={form.minutes}
            onChange={(event) => onChange({ minutes: event.target.value })}
          />
        </label>
      ) : form.mode === "time" ? (
        <div className="grid gap-1 text-xs text-muted-foreground">
          <label className="grid gap-1">
            Time ({props.clock})
            <input
              className={FIELD_CLASS}
              type="time"
              value={form.timeOfDay}
              onChange={(event) => onChange({ timeOfDay: event.target.value })}
            />
          </label>
          <div
            className="flex flex-wrap gap-1"
            role="group"
            aria-label="Days (none means every day)"
          >
            {WEEKDAYS.map((day, index) => {
              const on = form.weekdays.includes(index);
              return (
                <Button
                  key={day}
                  size="micro"
                  variant={on ? "default" : "outline"}
                  aria-pressed={on}
                  onClick={() =>
                    onChange({
                      weekdays: on
                        ? form.weekdays.filter((entry) => entry !== index)
                        : [...form.weekdays, index],
                    })
                  }
                >
                  {day}
                </Button>
              );
            })}
          </div>
        </div>
      ) : (
        <label className="grid gap-1 text-xs text-muted-foreground">
          Date and time
          <input
            className={FIELD_CLASS}
            type="datetime-local"
            value={form.date}
            onChange={(event) => onChange({ date: event.target.value })}
          />
        </label>
      )}
      {form.mode === "once" ? null : (
        <label className="grid gap-1 text-xs text-muted-foreground">
          Times (empty: no limit)
          <input
            className={FIELD_CLASS}
            type="number"
            min={1}
            value={form.runs}
            onChange={(event) => onChange({ runs: event.target.value })}
          />
        </label>
      )}
    </>
  );
}
