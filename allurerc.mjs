import { env } from "node:process";
import { defineConfig } from "allure";

const workflow = env.ALLURE_WORKFLOW === "e2e" ? "e2e" : "ci";

export default defineConfig({
  name: workflow === "e2e" ? "SlugBase E2E" : "SlugBase CI",
  output: "./allure-report-out",
  historyPath: `./allure-history-${workflow}.jsonl`,
  historyLimit: 20,
  appendHistory: true,
  hideLabels: ["thread", "host", "_fallbackTestCaseId"],
  environments: {
    hosted: {
      matcher: ({ labels }) =>
        labels.some((l) => l.name === "edition" && l.value === "hosted"),
    },
    "self-hosted": {
      matcher: ({ labels }) =>
        labels.some((l) => l.name === "edition" && l.value === "self-hosted"),
    },
  },
  plugins: {
    awesome: {
      options: {
        groupBy: ["layer", "parentSuite", "suite"],
        reportLanguage: "en",
      },
    },
  },
});
