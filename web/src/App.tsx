import { useState } from "react";

type RequestState = "idle" | "loading" | "success" | "error";

type PingResponse = {
  message: string;
};

export function App() {
  const [requestState, setRequestState] = useState<RequestState>("idle");

  const sendPing = async () => {
    setRequestState("loading");

    try {
      const response = await fetch("/api/ping", {
        headers: { Accept: "application/json" },
      });

      if (!response.ok) {
        throw new Error(`Ping returned HTTP ${response.status}`);
      }

      const data = (await response.json()) as PingResponse;
      if (data.message !== "pong") {
        throw new Error("Ping returned an unexpected response");
      }

      setRequestState("success");
    } catch {
      setRequestState("error");
    }
  };

  return (
    <main className="page-shell">
      <section className="card" aria-labelledby="page-title">
        <div className="eyebrow">
          <span className="status-dot" aria-hidden="true" />
          Shiori infrastructure spike
        </div>

        <div className="copy">
          <h1 id="page-title">Send a tiny signal.</h1>
          <p>
            This first slice checks that Shiori’s browser and API can reach one
            another in public. One click goes to the server and comes back.
          </p>
        </div>

        <div className="interaction">
          <button
            className="ping-button"
            type="button"
            onClick={() => void sendPing()}
            disabled={requestState === "loading"}
          >
            <span>{requestState === "loading" ? "Sending…" : "Ping"}</span>
            <span className="button-arrow" aria-hidden="true">
              →
            </span>
          </button>

          <div
            className={`response response--${requestState}`}
            role="status"
            aria-live="polite"
            aria-atomic="true"
          >
            {requestState === "idle" && (
              <span className="response-hint">Waiting for your signal</span>
            )}
            {requestState === "loading" && (
              <span className="response-hint">Crossing the network…</span>
            )}
            {requestState === "success" && (
              <>
                <span className="response-label">Server replied</span>
                <strong>Pong</strong>
              </>
            )}
            {requestState === "error" && (
              <>
                <span className="response-label">Signal interrupted</span>
                <strong>Ping failed. Please try again.</strong>
              </>
            )}
          </div>
        </div>

        <footer>
          <span>Browser</span>
          <span className="connection" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          <span>API</span>
        </footer>
      </section>
    </main>
  );
}
