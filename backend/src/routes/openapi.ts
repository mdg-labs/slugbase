/**
 * Serves OpenAPI spec (self-hosted) and optional Swagger UI at /api-docs.
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { Router } from 'express';
import YAML from 'yaml';
import swaggerUi from 'swagger-ui-express';

const __dirname = dirname(fileURLToPath(import.meta.url));

const SPEC_FILENAME = 'openapi.selfhosted.yaml';

function resolveSpecPath(): string {
  const distPath = join(__dirname, '..', 'openapi', SPEC_FILENAME);
  const srcPath = join(__dirname, '..', '..', 'openapi', SPEC_FILENAME);
  if (existsSync(distPath)) return distPath;
  if (existsSync(srcPath)) return srcPath;
  throw new Error(`OpenAPI spec not found (tried ${distPath}, ${srcPath})`);
}

let cachedJson: Record<string, unknown> | null = null;

function getSpecObject(): Record<string, unknown> {
  if (!cachedJson) {
    const raw = readFileSync(resolveSpecPath(), 'utf8');
    cachedJson = YAML.parse(raw) as Record<string, unknown>;
  }
  return cachedJson;
}

function apiDocsEnabled(): boolean {
  const v = process.env.SLUGBASE_API_DOCS;
  return v !== 'false' && v !== '0';
}

const router = Router();

router.get('/openapi.json', (_req, res) => {
  try {
    res.json(getSpecObject());
  } catch (e) {
    console.error('openapi.json', e);
    res.status(500).json({ error: 'OpenAPI spec unavailable' });
  }
});

router.get('/openapi.yaml', (_req, res) => {
  try {
    const raw = readFileSync(resolveSpecPath(), 'utf8');
    res.type('text/yaml; charset=utf-8').send(raw);
  } catch (e) {
    console.error('openapi.yaml', e);
    res.status(500).json({ error: 'OpenAPI spec unavailable' });
  }
});

if (apiDocsEnabled()) {
  router.use('/api-docs', swaggerUi.serve, swaggerUi.setup(getSpecObject(), { explorer: true }));
}

export default router;
