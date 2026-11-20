/** Pure declared-task schedule grammar shared by hosts and browser editors. */

export type ParsedDeclaredSchedule =
  | {
      kind: "interval";
      intervalMs: number;
      normalizedSchedule: string;
    }
  | {
      kind: "wall-clock";
      normalizedSchedule: string;
      timezone: string;
      hour: number;
      minute: number;
      days: "daily" | "weekday" | number[];
    };

export type ParseDeclaredScheduleResult =
  | { ok: true; schedule: ParsedDeclaredSchedule }
  | { ok: false; error: string };

export function validateTimezone(timezone: string): string {
  try {
    const formatter = new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    return formatter.resolvedOptions().timeZone;
  } catch {
    throw new Error(`Invalid timezone "${timezone}"`);
  }
}

function parseTime(value: string): { hour: number; minute: number } {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  if (!match) {
    throw new Error(`Invalid schedule time "${value}"; expected HH:mm`);
  }
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

const declaredScheduleDayNumbers: Record<string, number> = {
  sun: 0,
  sunday: 0,
  mon: 1,
  monday: 1,
  tue: 2,
  tuesday: 2,
  wed: 3,
  wednesday: 3,
  thu: 4,
  thursday: 4,
  fri: 5,
  friday: 5,
  sat: 6,
  saturday: 6
};

export function parseDeclaredTaskSchedule(
  rawSchedule: string,
  taskTimezone: string | undefined,
  defaultTimezone: string | undefined
): ParsedDeclaredSchedule {
  const result = tryParseDeclaredTaskSchedule(
    rawSchedule,
    taskTimezone,
    defaultTimezone
  );
  if (!result.ok) throw new Error(result.error);
  return result.schedule;
}

export function tryParseDeclaredTaskSchedule(
  rawSchedule: string,
  taskTimezone: string | undefined,
  defaultTimezone: string | undefined
): ParseDeclaredScheduleResult {
  try {
    return {
      ok: true,
      schedule: parseDeclaredTaskScheduleUnchecked(
        rawSchedule,
        taskTimezone,
        defaultTimezone
      )
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

function parseDeclaredTaskScheduleUnchecked(
  rawSchedule: string,
  taskTimezone: string | undefined,
  defaultTimezone: string | undefined
): ParsedDeclaredSchedule {
  const trimmed = rawSchedule.trim().replace(/\s+/g, " ").toLowerCase();
  const inlineTimezoneMatch = /^(.*) in ([A-Za-z_][A-Za-z0-9_+\-/]*)$/.exec(
    trimmed
  );
  const schedule = inlineTimezoneMatch?.[1] ?? trimmed;
  const inlineTimezone = inlineTimezoneMatch?.[2];
  if (
    inlineTimezone &&
    taskTimezone &&
    validateTimezone(inlineTimezone) !== validateTimezone(taskTimezone)
  ) {
    throw new Error(
      `Schedule timezone "${inlineTimezone}" does not match task timezone "${taskTimezone}"`
    );
  }

  const intervalMatch = /^every ([1-9]\d*) (minute|minutes|hour|hours)$/.exec(
    schedule
  );
  if (intervalMatch) {
    if (inlineTimezone || taskTimezone) {
      throw new Error("Interval schedules cannot specify a timezone");
    }
    const count = Number(intervalMatch[1]);
    const unit = intervalMatch[2];
    if (count === 1 && unit.endsWith("s")) {
      throw new Error(`Use singular unit for "${rawSchedule}"`);
    }
    if (count !== 1 && !unit.endsWith("s")) {
      throw new Error(`Use plural unit for "${rawSchedule}"`);
    }
    return {
      kind: "interval",
      intervalMs: count * (unit.startsWith("hour") ? 60 * 60_000 : 60_000),
      normalizedSchedule: `every ${count} ${unit}`
    };
  }

  const timezone = inlineTimezone ?? taskTimezone ?? defaultTimezone;
  if (!timezone) {
    throw new Error(
      `Wall-clock schedule "${rawSchedule}" requires a timezone or getDefaultTimezone()`
    );
  }
  const resolvedTimezone = validateTimezone(timezone);

  const dailyMatch = /^every day at ([0-2]\d:[0-5]\d)$/.exec(schedule);
  if (dailyMatch) {
    const { hour, minute } = parseTime(dailyMatch[1]);
    return {
      kind: "wall-clock",
      normalizedSchedule: `every day at ${dailyMatch[1]}`,
      timezone: resolvedTimezone,
      hour,
      minute,
      days: "daily"
    };
  }

  const weekdayMatch = /^every weekday at ([0-2]\d:[0-5]\d)$/.exec(schedule);
  if (weekdayMatch) {
    const { hour, minute } = parseTime(weekdayMatch[1]);
    return {
      kind: "wall-clock",
      normalizedSchedule: `every weekday at ${weekdayMatch[1]}`,
      timezone: resolvedTimezone,
      hour,
      minute,
      days: "weekday"
    };
  }

  const weeklyMatch = /^every week on ([a-z,\s]+) at ([0-2]\d:[0-5]\d)$/.exec(
    schedule
  );
  if (weeklyMatch) {
    const seen = new Set<number>();
    const days = weeklyMatch[1].split(",").map((day) => {
      const normalized = day.trim();
      const dayNumber = declaredScheduleDayNumbers[normalized];
      if (dayNumber === undefined) {
        throw new Error(`Invalid schedule day "${normalized}"`);
      }
      if (seen.has(dayNumber)) {
        throw new Error(`Duplicate schedule day "${normalized}"`);
      }
      seen.add(dayNumber);
      return dayNumber;
    });
    if (days.length === 0) {
      throw new Error("Weekly schedule requires at least one day");
    }
    const { hour, minute } = parseTime(weeklyMatch[2]);
    return {
      kind: "wall-clock",
      normalizedSchedule: `every week on ${weeklyMatch[1]
        .split(",")
        .map((day) => day.trim())
        .join(",")} at ${weeklyMatch[2]}`,
      timezone: resolvedTimezone,
      hour,
      minute,
      days
    };
  }

  throw new Error(`Unsupported schedule DSL "${rawSchedule}"`);
}
