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

const loginErrorCopy: Record<LoginError, string> = {
  failure: "We couldn’t sign you in. Try again.",
  invalid: "That password wasn’t accepted. Try again.",
  "rate-limited": "Too many attempts. Wait a moment, then try again.",
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

function DashboardView({
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

  const showLogin = (expired: boolean) => {
    setSummary(null);
    setSessionExpired(expired);
    setLoginError(null);
    setRefreshFailed(false);
    setView("login");
  };

  const loadInitialSummary = async () => {
    setView("loading");
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
        showLogin(false);
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
    const result = await readSummary();

    if (result.kind === "success") {
      setSummary(result.summary);
    } else if (result.kind === "expired") {
      showLogin(true);
    } else {
      setRefreshFailed(true);
    }

    setRefreshing(false);
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
      onRefresh={refresh}
      refreshFailed={refreshFailed}
      refreshing={refreshing}
      summary={summary}
    />
  );
}
