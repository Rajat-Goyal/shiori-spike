import { defineConfig } from "vitest/config";
import { BaseSequencer, type TestSpecification } from "vitest/node";

class DatabaseSequencer extends BaseSequencer {
  async sort(files: TestSpecification[]): Promise<TestSpecification[]> {
    return [...files].sort((left, right) => {
      const leftIsEmptyDashboard =
        left.moduleId.endsWith("/dashboard-db.integration.ts");
      const rightIsEmptyDashboard =
        right.moduleId.endsWith("/dashboard-db.integration.ts");

      if (leftIsEmptyDashboard !== rightIsEmptyDashboard) {
        return leftIsEmptyDashboard ? -1 : 1;
      }
      return left.moduleId.localeCompare(right.moduleId);
    });
  }
}

export default defineConfig({
  test: {
    fileParallelism: false,
    include: ["server/test/**/*.integration.ts"],
    sequence: {
      sequencer: DatabaseSequencer,
    },
  },
});
