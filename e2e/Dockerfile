# The image the browser journeys run in (doc 08 section 6.1, 6.2): the official
# Playwright image, which has the three engines and the system libraries they need,
# so no job installs them from a package mirror. The tag is the version of
# @playwright/test that pnpm-lock.yaml resolves (e2e/support/playwright-image.test.ts
# fails when they differ) and the digest pins the image; Renovate updates both
# together with the package (renovate.json). e2e/in-image.sh runs the journeys in it.
FROM mcr.microsoft.com/playwright:v1.64.0-noble@sha256:06a9939e57531807f8d5fd76ce44b53165ffb7d7501d87ab10e285c20b1e971f
