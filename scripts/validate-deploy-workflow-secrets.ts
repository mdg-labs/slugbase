import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const DEPLOY_WORKFLOW = resolve(REPO_ROOT, ".github/workflows/deploy.yml");
const CLOUD_IMAGE_WORKFLOW = resolve(
  REPO_ROOT,
  ".github/workflows/build-and-push-cloud-image.yml",
);

const REQUIRED_REPO_SECRETS = [
  "REGISTRY",
  "REGISTRY_USER",
  "REGISTRY_TOKEN",
] as const;

const REQUIRED_ENV_SECRETS = [
  "COOLIFY_DEPLOY_TOKEN",
  "COOLIFY_DEPLOY_WEBHOOK_API",
  "COOLIFY_DEPLOY_WEBHOOK_WEB",
  "COOLIFY_DEPLOY_WEBHOOK_MARKETING",
  "COOLIFY_DEPLOY_WEBHOOK_ADMIN",
] as const;

function readWorkflow(path: string): string {
  return readFileSync(path, "utf8");
}

function assertSecretReferences(
  label: string,
  workflowYaml: string,
  secretNames: readonly string[],
): void {
  const missing = secretNames.filter(
    (name) => !workflowYaml.includes(`secrets.${name}`),
  );
  if (missing.length > 0) {
    throw new Error(
      `${label} missing required secret references: ${missing.join(", ")}`,
    );
  }
}

function main(): void {
  const deployYaml = readWorkflow(DEPLOY_WORKFLOW);
  const cloudImageYaml = readWorkflow(CLOUD_IMAGE_WORKFLOW);

  assertSecretReferences("deploy.yml", deployYaml, [
    ...REQUIRED_REPO_SECRETS,
    ...REQUIRED_ENV_SECRETS,
  ]);
  assertSecretReferences(
    "build-and-push-cloud-image.yml",
    cloudImageYaml,
    REQUIRED_REPO_SECRETS,
  );

  if (deployYaml.includes("sync-secrets")) {
    throw new Error("deploy.yml must not reference removed sync-secrets workflow");
  }
  if (deployYaml.includes("flyctl") || deployYaml.includes("wrangler")) {
    throw new Error("deploy.yml must not reference Fly.io or Wrangler deploy tooling");
  }

  process.stdout.write("validate-deploy-workflow-secrets: ok\n");
}

main();
