import { type FormEvent, useEffect, useRef, useState } from "react";

type DashboardSummary = {
  commitments: unknown[];
  counts: {
    active: number;
    dueToday: number;
    overdue: number;
  };
  updatedAt: string;
};

type LoginError = "failure" | "invalid" | "rate-limited";
type View = "checking-session" | "dashboard" | "initial-error" | "loading" | "login";
type GoogleOAuthOutcome =
  | "connected"
  | "denied"
  | "failed"
  | "identity_mismatch"
  | "invalid_state"
  | "reconnected";
type CalendarConnectionState =
  | {
      action: "connect";
      outcome?: GoogleOAuthOutcome;
      state: "disconnected";
    }
  | {
      action: "reconnect";
      lastSuccessfulCheckAt: string | null;
      outcome?: GoogleOAuthOutcome;
      state: "authorization-expired" | "connected";
      verifiedEmail: string;
    }
  | {
      action: "reconnect";
      lastSuccessfulCheckAt?: string | null;
      outcome?: GoogleOAuthOutcome;
      state: "unavailable";
      verifiedEmail?: string;
    };
type CalendarNotice =
  | "connected"
  | "denied"
  | "failed"
  | "identity_mismatch"
  | "invalid_state"
  | "reconnected"
  | "start_failed";

const loginErrorCopy: Record<LoginError, string> = {
  failure: "We couldn’t sign you in. Try again.",
  invalid: "That password wasn’t accepted. Try again.",
  "rate-limited": "Too many attempts. Wait a moment, then try again.",
};

const calendarNoticeCopy: Record<CalendarNotice, string> = {
  connected: "Google Calendar connected.",
  denied: "Google Calendar wasn’t connected. Try again when you’re ready.",
  failed: "Google Calendar wasn’t connected. Try again when you’re ready.",
  identity_mismatch:
    "That Google account doesn’t match the configured owner. Choose the configured account and try again.",
  invalid_state:
    "We couldn’t verify that Google connection attempt. Start again from this dashboard.",
  reconnected: "Google Calendar reconnected.",
  start_failed:
    "We couldn’t start the Google Calendar connection. Try again.",
};

function isDashboardSummary(value: unknown): value is DashboardSummary {
  if (!value || typeof value !== "object") {
    return false;
  }

  const summary = value as Record<string, unknown>;
  const counts =
    summary.counts && typeof summary.counts === "object"
      ? (summary.counts as Record<string, unknown>)
      : undefined;

  return (
    Array.isArray(summary.commitments) &&
    typeof summary.updatedAt === "string" &&
    !Number.isNaN(Date.parse(summary.updatedAt)) &&
    Boolean(counts) &&
    ["active", "dueToday", "overdue"].every(
      (key) =>
        typeof counts?.[key] === "number" &&
        Number.isInteger(counts[key]) &&
        Number(counts[key]) >= 0,
    )
  );
}

async function readSummary(): Promise<
  | { kind: "expired" }
  | { kind: "success"; summary: DashboardSummary }
  | { kind: "unavailable" }
> {
  try {
    const response = await fetch("/api/dashboard/summary", {
      headers: { Accept: "application/json" },
    });

    if (response.status === 401) {
      return { kind: "expired" };
    }

    if (!response.ok) {
      return { kind: "unavailable" };
    }

    const body: unknown = await response.json();
    return isDashboardSummary(body)
      ? { kind: "success", summary: body }
      : { kind: "unavailable" };
  } catch {
    return { kind: "unavailable" };
  }
}

function isGoogleOAuthOutcome(value: unknown): value is GoogleOAuthOutcome {
  return [
    "connected",
    "denied",
    "failed",
    "identity_mismatch",
    "invalid_state",
    "reconnected",
  ].includes(String(value));
}

function isCalendarConnectionState(
  value: unknown,
): value is CalendarConnectionState {
  if (!value || typeof value !== "object") {
    return false;
  }
  const connection = value as Record<string, unknown>;
  if (
    connection.outcome !== undefined &&
    !isGoogleOAuthOutcome(connection.outcome)
  ) {
    return false;
  }
  if (
    connection.state === "disconnected" &&
    connection.action === "connect"
  ) {
    return true;
  }
  if (
    ["connected", "authorization-expired"].includes(
      String(connection.state),
    ) &&
    connection.action === "reconnect"
  ) {
    return (
      typeof connection.verifiedEmail === "string" &&
      (connection.lastSuccessfulCheckAt === null ||
        (typeof connection.lastSuccessfulCheckAt === "string" &&
          !Number.isNaN(Date.parse(connection.lastSuccessfulCheckAt))))
    );
  }
  return (
    connection.state === "unavailable" &&
    connection.action === "reconnect" &&
    (connection.verifiedEmail === undefined ||
      typeof connection.verifiedEmail === "string") &&
    (connection.lastSuccessfulCheckAt === undefined ||
      connection.lastSuccessfulCheckAt === null ||
      (typeof connection.lastSuccessfulCheckAt === "string" &&
        !Number.isNaN(Date.parse(connection.lastSuccessfulCheckAt))))
  );
}

function knownCalendarDetails(
  connection: CalendarConnectionState,
): Pick<
  Extract<CalendarConnectionState, { state: "unavailable" }>,
  "lastSuccessfulCheckAt" | "verifiedEmail"
> {
  return connection.state === "disconnected"
    ? {}
    : {
        lastSuccessfulCheckAt: connection.lastSuccessfulCheckAt,
        verifiedEmail: connection.verifiedEmail,
      };
}

async function readCalendarConnection(
  previous: CalendarConnectionState,
): Promise<
  | { kind: "expired" }
  | { connection: CalendarConnectionState; kind: "success" }
> {
  try {
    const response = await fetch("/api/google-calendar/connection", {
      headers: { Accept: "application/json" },
    });
    if (response.status === 401) {
      return { kind: "expired" };
    }
    if (!response.ok) {
      throw new Error("Calendar state unavailable");
    }
    const body: unknown = await response.json();
    if (!isCalendarConnectionState(body)) {
      throw new Error("Calendar state is invalid");
    }
    return { connection: body, kind: "success" };
  } catch {
    return {
      connection: {
        action: "reconnect",
        ...knownCalendarDetails(previous),
        state: "unavailable",
      },
      kind: "success",
    };
  }
}

function SessionCheckState() {
  return (
    <main className="page-shell page-shell--centered">
      <section
        className="state-card"
        role="status"
        aria-live="polite"
        aria-busy="true"
      >
        <div className="eyebrow">
          <span className="status-dot" aria-hidden="true" />
          Shiori · Private dashboard
        </div>
        <div className="loading-orbit" aria-hidden="true">
          <span />
        </div>
        <h1>Opening your dashboard…</h1>
        <p>Checking your private session.</p>
      </section>
    </main>
  );
}

function LoadingState() {
  return (
    <main className="page-shell page-shell--centered">
      <section className="state-card" role="status" aria-live="polite" aria-busy="true">
        <div className="brand-mark" aria-hidden="true">
          S
        </div>
        <div className="loading-orbit" aria-hidden="true">
          <span />
        </div>
        <h1>Loading live dashboard…</h1>
        <p>Reading the latest saved state.</p>
      </section>
    </main>
  );
}

type LoginViewProps = {
  expired: boolean;
  loginError: LoginError | null;
  onSubmit: (password: string) => Promise<void>;
  opening: boolean;
};

function LoginView({ expired, loginError, onSubmit, opening }: LoginViewProps) {
  const [password, setPassword] = useState("");
  const passwordInput = useRef<HTMLInputElement>(null);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    await onSubmit(password);
    passwordInput.current?.focus();
    passwordInput.current?.select();
  };

  return (
    <main className="page-shell page-shell--centered">
      <section className="login-card" aria-labelledby="login-title">
        <div className="eyebrow">
          <span className="status-dot" aria-hidden="true" />
          Shiori · Private dashboard
        </div>

        <div className="login-copy">
          <h1 id="login-title">Open your dashboard</h1>
          <p>Enter the owner password to continue.</p>
        </div>

        {expired && (
          <p className="notice notice--session" role="alert">
            Your session ended. Enter your password to continue.
          </p>
        )}

        <form className="login-form" onSubmit={(event) => void submit(event)} aria-busy={opening}>
          <label htmlFor="owner-password">Password</label>
          <input
            ref={passwordInput}
            autoComplete="current-password"
            autoFocus
            disabled={opening}
            id="owner-password"
            name="password"
            onChange={(event) => setPassword(event.target.value)}
            required
            type="password"
            value={password}
          />
          <button className="primary-button" disabled={opening} type="submit">
            {opening ? "Opening…" : "Open dashboard"}
          </button>
        </form>

        <div className="login-message" aria-live="assertive" aria-atomic="true">
          {loginError && (
            <p className="notice notice--error" role="alert">
              {loginErrorCopy[loginError]}
            </p>
          )}
        </div>
      </section>
    </main>
  );
}

type ErrorViewProps = {
  onRetry: () => void;
};

function ErrorView({ onRetry }: ErrorViewProps) {
  return (
    <main className="page-shell page-shell--centered">
      <section className="state-card state-card--error" role="alert" aria-labelledby="error-title">
        <div className="error-symbol" aria-hidden="true">
          !
        </div>
        <h1 id="error-title">Dashboard unavailable</h1>
        <p>We couldn’t load the live dashboard. Try again.</p>
        <button className="secondary-button" onClick={onRetry} type="button">
          Try again
        </button>
      </section>
    </main>
  );
}

type DashboardViewProps = {
  calendarConnection: CalendarConnectionState;
  calendarInitiating: boolean;
  calendarNotice: CalendarNotice | null;
  onCalendarConnect: () => Promise<void>;
  onRefresh: () => Promise<void>;
  refreshFailed: boolean;
  refreshing: boolean;
  summary: DashboardSummary;
};

const singaporeTimestamp = new Intl.DateTimeFormat("en-SG", {
  day: "2-digit",
  hour: "2-digit",
  hour12: false,
  minute: "2-digit",
  month: "short",
  second: "2-digit",
  timeZone: "Asia/Singapore",
  timeZoneName: "short",
  year: "numeric",
});

type CalendarPanelProps = Pick<
  DashboardViewProps,
  | "calendarConnection"
  | "calendarInitiating"
  | "calendarNotice"
  | "onCalendarConnect"
>;

function CalendarPanel({
  calendarConnection,
  calendarInitiating,
  calendarNotice,
  onCalendarConnect,
}: CalendarPanelProps) {
  const noticeRef = useRef<HTMLParagraphElement>(null);
  const successfulNotice =
    calendarNotice === "connected" || calendarNotice === "reconnected";
  useEffect(() => {
    if (calendarNotice) {
      noticeRef.current?.focus();
    }
  }, [calendarNotice]);

  const reconnecting = calendarConnection.action === "reconnect";
  const status = calendarInitiating
    ? reconnecting
      ? "Reconnecting"
      : "Connecting"
    : calendarConnection.state === "disconnected"
      ? "Not connected"
      : calendarConnection.state === "connected"
        ? "Connected"
        : calendarConnection.state === "authorization-expired"
          ? "Authorization expired"
          : "Temporarily unavailable";
  const body = calendarInitiating
    ? "Redirecting to Google… You’ll return here when you’re done."
    : calendarConnection.state === "disconnected"
      ? "Connect your primary calendar so Shiori can check when you’re free."
      : calendarConnection.state === "connected"
        ? `Connected as ${calendarConnection.verifiedEmail}`
        : calendarConnection.state === "authorization-expired"
          ? "Google Calendar needs to be reconnected. Your promises and reminders still work."
          : "Google Calendar can’t be reached right now. Your promises and reminders still work.";
  const knownDetails =
    calendarConnection.state === "authorization-expired" ||
    calendarConnection.state === "unavailable"
      ? knownCalendarDetails(calendarConnection)
      : {};
  const lastCheck =
    calendarConnection.state === "connected"
      ? calendarConnection.lastSuccessfulCheckAt
      : knownDetails.lastSuccessfulCheckAt;

  return (
    <section
      className="calendar-panel"
      aria-busy={calendarInitiating}
      aria-labelledby="google-calendar-title"
    >
      {calendarNotice && (
        <p
          className="notice calendar-notice"
          ref={noticeRef}
          role={successfulNotice ? "status" : "alert"}
          tabIndex={-1}
        >
          {calendarNoticeCopy[calendarNotice]}
        </p>
      )}
      <div className="calendar-panel__content">
        <div className="calendar-panel__copy">
          <div className="calendar-panel__heading">
            <h2 id="google-calendar-title">Google Calendar</h2>
            <span className={`calendar-badge calendar-badge--${calendarConnection.state}`}>
              {status}
            </span>
          </div>
          <p className="calendar-body" aria-live="polite">
            {body}
          </p>
          {!calendarInitiating && (
            <div className="calendar-meta">
              {calendarConnection.state === "disconnected" ? (
                <span>Read-only access</span>
              ) : calendarConnection.state === "connected" ? (
                <span>Primary calendar · Read-only</span>
              ) : (
                knownDetails.verifiedEmail && (
                  <span>Connected as {knownDetails.verifiedEmail}</span>
                )
              )}
              {calendarConnection.state !== "disconnected" && (
                <span>
                  {lastCheck ? (
                    <>
                      Last successful check:{" "}
                      <time dateTime={lastCheck}>
                        {singaporeTimestamp.format(new Date(lastCheck))}
                      </time>
                    </>
                  ) : (
                    "Calendar not checked yet"
                  )}
                </span>
              )}
            </div>
          )}
        </div>
        <button
          className="calendar-action"
          disabled={calendarInitiating}
          onClick={() => void onCalendarConnect()}
          type="button"
        >
          {calendarInitiating
            ? "Opening Google…"
            : reconnecting
              ? "Reconnect Google Calendar"
              : "Connect Google Calendar"}
        </button>
      </div>
    </section>
  );
}

function DashboardView({
  calendarConnection,
  calendarInitiating,
  calendarNotice,
  onCalendarConnect,
  onRefresh,
  refreshFailed,
  refreshing,
  summary,
}: DashboardViewProps) {
  const counts = [
    { label: "Active", value: summary.counts.active },
    { label: "Due today", value: summary.counts.dueToday },
    { label: "Overdue", value: summary.counts.overdue },
  ];

  return (
    <main className="dashboard-shell">
      <div className="dashboard-frame" aria-busy={refreshing}>
        <header className="dashboard-header">
          <div>
            <div className="eyebrow">
              <span className="status-dot" aria-hidden="true" />
              Shiori · Owner dashboard
            </div>
            <h1>Your promises</h1>
          </div>

          <div className="refresh-cluster">
            <button
              className="refresh-button"
              disabled={refreshing}
              onClick={() => void onRefresh()}
              type="button"
            >
              <span className="refresh-icon" aria-hidden="true">
                ↻
              </span>
              {refreshing ? "Refreshing…" : "Refresh"}
            </button>
            <p className="last-updated" aria-live="polite">
              Last updated{" "}
              <time dateTime={summary.updatedAt}>
                {singaporeTimestamp.format(new Date(summary.updatedAt))}
              </time>
            </p>
          </div>
        </header>

        <p
          className="refresh-status"
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          {refreshing ? "Refreshing live data…" : ""}
        </p>

        {refreshFailed && (
          <div className="notice notice--refresh" role="alert">
            <span>Couldn’t refresh. Showing the last successful update.</span>
            <button
              className="inline-retry-button"
              onClick={() => void onRefresh()}
              type="button"
            >
              Try again
            </button>
          </div>
        )}

        <section className="count-grid" aria-label="Promise counts">
          {counts.map((count) => (
            <article className="count-card" key={count.label}>
              <span>{count.label}</span>
              <strong>{count.value}</strong>
            </article>
          ))}
        </section>

        <CalendarPanel
          calendarConnection={calendarConnection}
          calendarInitiating={calendarInitiating}
          calendarNotice={calendarNotice}
          onCalendarConnect={onCalendarConnect}
        />

        <section className="promise-panel" aria-labelledby="promises-empty-title">
          <div className="empty-illustration" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
          <h2 id="promises-empty-title">No active promises</h2>
          <p>Confirmed promises will appear here.</p>
        </section>
      </div>
    </main>
  );
}

export function App() {
  const [view, setView] = useState<View>("checking-session");
  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  const [opening, setOpening] = useState(false);
  const [loginError, setLoginError] = useState<LoginError | null>(null);
  const [sessionExpired, setSessionExpired] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshFailed, setRefreshFailed] = useState(false);
  const [calendarConnection, setCalendarConnection] =
    useState<CalendarConnectionState>({
      action: "reconnect",
      state: "unavailable",
    });
  const [calendarInitiating, setCalendarInitiating] = useState(false);
  const [calendarNotice, setCalendarNotice] =
    useState<CalendarNotice | null>(null);

  const showLogin = (expired: boolean) => {
    setSummary(null);
    setSessionExpired(expired);
    setLoginError(null);
    setRefreshFailed(false);
    setCalendarInitiating(false);
    setCalendarNotice(null);
    setView("login");
  };

  const loadCalendarConnection = async (
    previous: CalendarConnectionState = calendarConnection,
  ) => {
    const result = await readCalendarConnection(previous);
    if (result.kind === "expired") {
      showLogin(true);
      return;
    }
    setCalendarConnection(result.connection);
    setCalendarNotice(result.connection.outcome ?? null);
  };

  const loadInitialSummary = async () => {
    setView("loading");
    void loadCalendarConnection();
    const result = await readSummary();

    if (result.kind === "success") {
      setSummary(result.summary);
      setRefreshFailed(false);
      setView("dashboard");
    } else if (result.kind === "expired") {
      showLogin(true);
    } else {
      setView("initial-error");
    }
  };

  const start = async () => {
    setView("checking-session");

    try {
      const response = await fetch("/api/owner/session", {
        headers: { Accept: "application/json" },
      });

      if (response.ok) {
        await loadInitialSummary();
      } else if (response.status === 401) {
        const body: unknown = await response.json().catch(() => null);
        const expired =
          Boolean(body) &&
          typeof body === "object" &&
          (body as Record<string, unknown>).error === "session_expired";
        showLogin(expired);
      } else {
        setView("initial-error");
      }
    } catch {
      setView("initial-error");
    }
  };

  useEffect(() => {
    void start();
    // The bootstrap request runs once for this mounted application.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submitPassword = async (password: string) => {
    setOpening(true);
    setLoginError(null);

    try {
      const response = await fetch("/api/owner/login", {
        body: JSON.stringify({ password }),
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        method: "POST",
      });

      if (response.ok) {
        setSessionExpired(false);
        await loadInitialSummary();
      } else if (response.status === 401) {
        setLoginError("invalid");
      } else if (response.status === 429) {
        setLoginError("rate-limited");
      } else {
        setLoginError("failure");
      }
    } catch {
      setLoginError("failure");
    } finally {
      setOpening(false);
    }
  };

  const refresh = async () => {
    setRefreshing(true);
    setRefreshFailed(false);
    const [result, calendarResult] = await Promise.all([
      readSummary(),
      readCalendarConnection(calendarConnection),
    ]);

    if (result.kind === "success") {
      setSummary(result.summary);
    } else if (result.kind === "expired") {
      showLogin(true);
    } else {
      setRefreshFailed(true);
    }
    if (calendarResult.kind === "expired") {
      showLogin(true);
    } else {
      setCalendarConnection(calendarResult.connection);
      setCalendarNotice(calendarResult.connection.outcome ?? null);
    }

    setRefreshing(false);
  };

  const connectCalendar = async () => {
    setCalendarInitiating(true);
    setCalendarNotice(null);
    try {
      const response = await fetch("/api/google-calendar/connect", {
        headers: { Accept: "application/json" },
        method: "POST",
      });
      if (response.status === 401) {
        showLogin(true);
        return;
      }
      if (!response.ok) {
        throw new Error("Calendar connection could not start");
      }
      const body: unknown = await response.json();
      const authorizationUrl =
        body && typeof body === "object"
          ? (body as Record<string, unknown>).authorizationUrl
          : undefined;
      if (typeof authorizationUrl !== "string") {
        throw new Error("Calendar authorization URL is invalid");
      }
      const url = new URL(authorizationUrl);
      if (
        url.protocol !== "https:" ||
        url.origin !== "https://accounts.google.com"
      ) {
        throw new Error("Calendar authorization URL is invalid");
      }
      window.location.assign(url);
    } catch {
      setCalendarInitiating(false);
      setCalendarNotice("start_failed");
    }
  };

  if (view === "checking-session") {
    return <SessionCheckState />;
  }

  if (view === "loading") {
    return <LoadingState />;
  }

  if (view === "login") {
    return (
      <LoginView
        expired={sessionExpired}
        loginError={loginError}
        onSubmit={submitPassword}
        opening={opening}
      />
    );
  }

  if (view === "initial-error") {
    return <ErrorView onRetry={() => void start()} />;
  }

  if (!summary) {
    return <ErrorView onRetry={() => void start()} />;
  }

  return (
    <DashboardView
      calendarConnection={calendarConnection}
      calendarInitiating={calendarInitiating}
      calendarNotice={calendarNotice}
      onCalendarConnect={connectCalendar}
      onRefresh={refresh}
      refreshFailed={refreshFailed}
      refreshing={refreshing}
      summary={summary}
    />
  );
}
