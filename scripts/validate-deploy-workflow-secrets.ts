import { existsSync } from "node:fs";
import { resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..");

const CLOUD_WORKFLOW_PATHS = [
  ".github/workflows/deploy.yml",
  ".github/workflows/build-and-push-cloud-image.yml",
] as const;

function main(): void {
  const present = CLOUD_WORKFLOW_PATHS.filter((relativePath) =>
    existsSync(resolve(REPO_ROOT, relativePath)),
  );
  if (present.length > 0) {
    throw new Error(
      `CE repo must not contain cloud deploy workflows (moved to slugbase-cloud): ${present.join(", ")}`,
    );
  }

  process.stdout.write("validate-deploy-workflow-secrets: ok (CE — cloud workflows in slugbase-cloud)\n");
}

main();
