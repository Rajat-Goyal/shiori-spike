export type DashboardSummary = Readonly<{
  commitments: readonly [];
  counts: Readonly<{
    active: number;
    dueToday: number;
    overdue: number;
  }>;
  updatedAt: string;
}>;

export interface DashboardRepository {
  readSummary(now: Date): Promise<DashboardSummary>;
}

type CommitmentRow = {
  id: string;
  status: "active";
  target_at: string;
};

type SupabaseDashboardRepositoryOptions = {
  fetch?: typeof fetch;
  ownerTimeZone: string;
  supabaseSecretKey: string;
  supabaseUrl: string;
};

function dateKey(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    month: "2-digit",
    timeZone,
    year: "numeric",
  }).formatToParts(date);
  const byType = new Map(parts.map((part) => [part.type, part.value]));
  return `${byType.get("year")}-${byType.get("month")}-${byType.get("day")}`;
}

function isCommitmentRow(value: unknown): value is CommitmentRow {
  if (!value || typeof value !== "object") {
    return false;
  }

  const row = value as Record<string, unknown>;
  return (
    typeof row.id === "string" &&
    row.status === "active" &&
    typeof row.target_at === "string" &&
    !Number.isNaN(Date.parse(row.target_at))
  );
}

export class SupabaseDashboardRepository implements DashboardRepository {
  readonly #fetch: typeof fetch;
  readonly #ownerTimeZone: string;
  readonly #supabaseSecretKey: string;
  readonly #supabaseUrl: string;

  constructor(options: SupabaseDashboardRepositoryOptions) {
    this.#fetch = options.fetch ?? fetch;
    this.#ownerTimeZone = options.ownerTimeZone;
    this.#supabaseSecretKey = options.supabaseSecretKey;
    this.#supabaseUrl = options.supabaseUrl;
  }

  async readSummary(now: Date): Promise<DashboardSummary> {
    const response = await this.#fetch(
      `${this.#supabaseUrl}/rest/v1/commitments?select=id,status,target_at&status=eq.active&order=target_at.asc`,
      {
        headers: {
          Accept: "application/json",
          apikey: this.#supabaseSecretKey,
          Authorization: `Bearer ${this.#supabaseSecretKey}`,
        },
        signal: AbortSignal.timeout(5_000),
      },
    );

    if (!response.ok) {
      throw new Error(`Supabase dashboard read failed with HTTP ${response.status}`);
    }

    const body: unknown = await response.json();
    if (!Array.isArray(body) || !body.every(isCommitmentRow)) {
      throw new Error("Supabase dashboard read returned an invalid response");
    }

    const today = dateKey(now, this.#ownerTimeZone);
    let dueToday = 0;
    let overdue = 0;

    for (const commitment of body) {
      const targetDate = dateKey(new Date(commitment.target_at), this.#ownerTimeZone);
      if (targetDate === today) {
        dueToday += 1;
      } else if (targetDate < today) {
        overdue += 1;
      }
    }

    return {
      commitments: [],
      counts: {
        active: body.length,
        dueToday,
        overdue,
      },
      updatedAt: now.toISOString(),
    };
  }
}
