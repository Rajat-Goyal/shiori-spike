const GOOGLE_FREE_BUSY_URL =
  "https://www.googleapis.com/calendar/v3/freeBusy";
const GOOGLE_EVENTS_URL =
  "https://www.googleapis.com/calendar/v3/calendars/primary/events";
const OWNER_TIME_ZONE = "Asia/Singapore";
const MAX_RANGE_MILLISECONDS = 14 * 24 * 60 * 60 * 1_000;
const MAX_EVENT_SUMMARIES = 50;

export type GoogleCalendarFailure =
  | "authorization_expired"
  | "unavailable";

export type GoogleCalendarTokenResult =
  | Readonly<{ accessToken: string; status: "ok" }>
  | Readonly<{ status: GoogleCalendarFailure }>;

export interface GoogleCalendarTokenProvider {
  getToken(): Promise<GoogleCalendarTokenResult>;
}

export type CalendarRange = Readonly<{
  endAt: string;
  startAt: string;
}>;

export type CalendarBusyInterval = CalendarRange;

export type CalendarEventBoundary =
  | Readonly<{ date: string; kind: "date" }>
  | Readonly<{
      dateTime: string;
      kind: "date_time";
      timeZone: string | null;
    }>;

export type CalendarEventSummary = Readonly<{
  busyStatus: "busy" | "free";
  end: CalendarEventBoundary;
  id: string;
  recurrence: readonly string[];
  start: CalendarEventBoundary;
  status: "cancelled" | "confirmed" | "tentative" | "unknown";
  title: string | null;
}>;

export type GoogleCalendarResult =
  | Readonly<{
      busyIntervals: readonly CalendarBusyInterval[];
      checkedAt: string;
      eventSummaries: readonly CalendarEventSummary[];
      status: "ok";
    }>
  | Readonly<{ status: GoogleCalendarFailure }>;

export type GoogleCalendarRequest = Readonly<{
  calendarId: "primary";
  range: CalendarRange;
}>;

type GoogleCalendarAdapterOptions = Readonly<{
  fetch?: typeof fetch;
  now?: () => Date;
  tokenProvider: GoogleCalendarTokenProvider;
}>;

type ValidatedRange = Readonly<{
  endAt: string;
  endMillis: number;
  startAt: string;
  startMillis: number;
}>;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function boundedString(
  value: unknown,
  maximumLength: number,
): string | undefined {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximumLength
    ? value
    : undefined;
}

function validateRange(request: GoogleCalendarRequest): ValidatedRange | undefined {
  if (request.calendarId !== "primary") {
    return undefined;
  }
  const startMillis = Date.parse(request.range.startAt);
  const endMillis = Date.parse(request.range.endAt);
  if (
    !Number.isFinite(startMillis) ||
    !Number.isFinite(endMillis) ||
    endMillis <= startMillis ||
    endMillis - startMillis > MAX_RANGE_MILLISECONDS
  ) {
    return undefined;
  }
  return {
    endAt: new Date(endMillis).toISOString(),
    endMillis,
    startAt: new Date(startMillis).toISOString(),
    startMillis,
  };
}

function normalizeBusyIntervals(
  value: unknown,
  range: ValidatedRange,
): readonly CalendarBusyInterval[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const intervals: Array<{
    endMillis: number;
    startMillis: number;
  }> = [];
  for (const item of value) {
    const busy = record(item);
    const startMillis =
      typeof busy?.start === "string" ? Date.parse(busy.start) : Number.NaN;
    const endMillis =
      typeof busy?.end === "string" ? Date.parse(busy.end) : Number.NaN;
    if (
      !Number.isFinite(startMillis) ||
      !Number.isFinite(endMillis) ||
      endMillis <= startMillis
    ) {
      return undefined;
    }

    const boundedStart = Math.max(startMillis, range.startMillis);
    const boundedEnd = Math.min(endMillis, range.endMillis);
    if (boundedStart < boundedEnd) {
      intervals.push({
        endMillis: boundedEnd,
        startMillis: boundedStart,
      });
    }
  }

  intervals.sort(
    (left, right) =>
      left.startMillis - right.startMillis ||
      left.endMillis - right.endMillis,
  );
  const merged: typeof intervals = [];
  for (const interval of intervals) {
    const previous = merged.at(-1);
    if (previous && interval.startMillis < previous.endMillis) {
      previous.endMillis = Math.max(previous.endMillis, interval.endMillis);
    } else if (
      previous &&
      interval.startMillis === previous.startMillis &&
      interval.endMillis === previous.endMillis
    ) {
      continue;
    } else {
      merged.push({ ...interval });
    }
  }

  return merged.map((interval) => ({
    endAt: new Date(interval.endMillis).toISOString(),
    startAt: new Date(interval.startMillis).toISOString(),
  }));
}

function eventBoundary(value: unknown): CalendarEventBoundary | undefined {
  const boundary = record(value);
  if (!boundary) {
    return undefined;
  }

  if (
    typeof boundary.date === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(boundary.date)
  ) {
    return { date: boundary.date, kind: "date" };
  }

  if (typeof boundary.dateTime !== "string") {
    return undefined;
  }
  const millis = Date.parse(boundary.dateTime);
  if (!Number.isFinite(millis)) {
    return undefined;
  }
  const timeZone =
    boundary.timeZone === undefined
      ? null
      : boundedString(boundary.timeZone, 64);
  if (boundary.timeZone !== undefined && timeZone === undefined) {
    return undefined;
  }
  return {
    dateTime: new Date(millis).toISOString(),
    kind: "date_time",
    timeZone: timeZone ?? null,
  };
}

function eventStatus(
  value: unknown,
): CalendarEventSummary["status"] {
  return value === "cancelled" ||
    value === "confirmed" ||
    value === "tentative"
    ? value
    : "unknown";
}

function eventSummaries(value: unknown): readonly CalendarEventSummary[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const summaries: CalendarEventSummary[] = [];
  for (const item of value.slice(0, MAX_EVENT_SUMMARIES)) {
    const event = record(item);
    const id = boundedString(event?.id, 256);
    const start = eventBoundary(event?.start);
    const end = eventBoundary(event?.end);
    if (!event || !id || !start || !end) {
      continue;
    }

    const title =
      event.summary === undefined
        ? null
        : boundedString(event.summary, 500);
    if (event.summary !== undefined && title === undefined) {
      continue;
    }
    const recurrence = Array.isArray(event.recurrence)
      ? event.recurrence
          .slice(0, 8)
          .map((item) => boundedString(item, 500))
      : [];
    if (recurrence.some((item) => item === undefined)) {
      continue;
    }

    summaries.push({
      busyStatus: event.transparency === "transparent" ? "free" : "busy",
      end,
      id,
      recurrence: recurrence as string[],
      start,
      status: eventStatus(event.status),
      title: title ?? null,
    });
  }
  return summaries;
}

function failureFor(response: Response): GoogleCalendarFailure {
  return response.status === 401 || response.status === 403
    ? "authorization_expired"
    : "unavailable";
}

export class GoogleCalendarAdapter {
  readonly #fetch: typeof fetch;
  readonly #now: () => Date;
  readonly #tokenProvider: GoogleCalendarTokenProvider;

  constructor(options: GoogleCalendarAdapterOptions) {
    this.#fetch = options.fetch ?? fetch;
    this.#now = options.now ?? (() => new Date());
    this.#tokenProvider = options.tokenProvider;
  }

  async read(request: GoogleCalendarRequest): Promise<GoogleCalendarResult> {
    const range = validateRange(request);
    if (!range) {
      return { status: "unavailable" };
    }

    let token: GoogleCalendarTokenResult;
    try {
      token = await this.#tokenProvider.getToken();
    } catch {
      return { status: "unavailable" };
    }
    if (token.status !== "ok") {
      return token;
    }
    if (
      token.accessToken.trim().length === 0 ||
      token.accessToken.length > 8_192
    ) {
      return { status: "unavailable" };
    }

    const headers = {
      Accept: "application/json",
      Authorization: `Bearer ${token.accessToken}`,
    };

    try {
      const freeBusyResponse = await this.#fetch(GOOGLE_FREE_BUSY_URL, {
        body: JSON.stringify({
          items: [{ id: "primary" }],
          timeMax: range.endAt,
          timeMin: range.startAt,
          timeZone: OWNER_TIME_ZONE,
        }),
        headers: {
          ...headers,
          "Content-Type": "application/json",
        },
        method: "POST",
        signal: AbortSignal.timeout(5_000),
      });
      if (!freeBusyResponse.ok) {
        return { status: failureFor(freeBusyResponse) };
      }
      const freeBusy = record(await freeBusyResponse.json());
      const calendars = record(freeBusy?.calendars);
      const primary = record(calendars?.primary);
      if (
        !primary ||
        (Array.isArray(primary.errors) && primary.errors.length > 0)
      ) {
        return { status: "unavailable" };
      }
      const busyIntervals = normalizeBusyIntervals(primary.busy, range);
      if (!busyIntervals) {
        return { status: "unavailable" };
      }

      const eventsUrl = new URL(GOOGLE_EVENTS_URL);
      eventsUrl.searchParams.set(
        "fields",
        "items(id,summary,start,end,transparency,recurrence,status)",
      );
      eventsUrl.searchParams.set("maxResults", String(MAX_EVENT_SUMMARIES));
      eventsUrl.searchParams.set("orderBy", "startTime");
      eventsUrl.searchParams.set("showDeleted", "true");
      eventsUrl.searchParams.set("singleEvents", "true");
      eventsUrl.searchParams.set("timeMax", range.endAt);
      eventsUrl.searchParams.set("timeMin", range.startAt);
      eventsUrl.searchParams.set("timeZone", OWNER_TIME_ZONE);

      const eventsResponse = await this.#fetch(eventsUrl, {
        headers,
        signal: AbortSignal.timeout(5_000),
      });
      if (!eventsResponse.ok) {
        return { status: failureFor(eventsResponse) };
      }
      const events = record(await eventsResponse.json());
      const summaries = eventSummaries(events?.items);
      if (!summaries) {
        return { status: "unavailable" };
      }

      return {
        busyIntervals,
        checkedAt: this.#now().toISOString(),
        eventSummaries: summaries,
        status: "ok",
      };
    } catch {
      return { status: "unavailable" };
    }
  }
}
