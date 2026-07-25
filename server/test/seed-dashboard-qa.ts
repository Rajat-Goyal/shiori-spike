import { readServerConfig } from "../src/config.js";
import { seedDashboardQaFixture } from "./support/dashboard-fixture.js";

const { summary } = await seedDashboardQaFixture(readServerConfig());

console.log(
  JSON.stringify({
    active: summary.counts.active,
    events: summary.events.length,
    sessions: summary.sessionHistory.reduce(
      (count, item) => count + item.sessions.length,
      0,
    ),
    terminal: summary.terminalCommitments.length,
  }),
);
