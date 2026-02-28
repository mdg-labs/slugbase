#!/usr/bin/env node
/**
 * Start backend + frontend with e2e DB, then run Playwright e2e tests.
 * Usage: npm run e2e:run (or node scripts/run-e2e.js)
 * Requires: E2E_DB_PATH and DB_PATH set to same path, or script sets them to .e2e-db.sqlite.
 */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const root = path.resolve(__dirname, '..');
// Unique DB path per run so e2e does not conflict with existing dev or locked files
const defaultDbPath =
  process.env.E2E_DB_PATH ||
  process.env.DB_PATH ||
  path.join(root, `.e2e-db-${Date.now()}.sqlite`);
const dbPath = path.isAbsolute(defaultDbPath) ? defaultDbPath : path.join(root, defaultDbPath);

// Dedicated ports for e2e so it does not conflict with a running dev server (3000/5000)
const E2E_FRONTEND_PORT = process.env.E2E_FRONTEND_PORT || '3002';
const E2E_BACKEND_PORT = process.env.E2E_BACKEND_PORT || '5002';
const baseURL = `http://localhost:${E2E_FRONTEND_PORT}`;

// 32+ char secrets for backend validation (e2e only)
const JWT_SECRET = process.env.JWT_SECRET || 'e2e-jwt-secret-at-least-32-characters-long';
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'e2e-encryption-key-at-least-32-chars';
const SESSION_SECRET = process.env.SESSION_SECRET || 'e2e-session-secret-at-least-32-characters';

const env = {
  ...process.env,
  DB_PATH: dbPath,
  E2E_DB_PATH: dbPath,
  JWT_SECRET,
  ENCRYPTION_KEY,
  SESSION_SECRET,
  PLAYWRIGHT_BASE_URL: process.env.PLAYWRIGHT_BASE_URL || baseURL,
};

let backendProc;
let frontendProc;

function killAll() {
  if (backendProc) {
    backendProc.kill('SIGTERM');
    backendProc = null;
  }
  if (frontendProc) {
    frontendProc.kill('SIGTERM');
    frontendProc = null;
  }
}

process.on('SIGINT', () => {
  killAll();
  process.exit(130);
});
process.on('SIGTERM', () => {
  killAll();
  process.exit(143);
});

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function waitForHealth(url, maxAttempts = 60) {
  return new Promise((resolve, reject) => {
    let attempts = 0;
    const check = async () => {
      try {
        const res = await fetch(url);
        if (res.ok) {
          resolve();
          return;
        }
      } catch (_) {}
      attempts++;
      if (attempts >= maxAttempts) {
        reject(new Error(`Health check failed at ${url} after ${maxAttempts} attempts`));
        return;
      }
      await wait(1000);
      check();
    };
    check();
  });
}

async function main() {
  console.log('Starting backend and frontend for e2e (ports %s / %s)...', E2E_BACKEND_PORT, E2E_FRONTEND_PORT);
  const backendEnv = { ...env, PORT: E2E_BACKEND_PORT, FRONTEND_URL: baseURL };
  backendProc = spawn('npm', ['run', 'dev', '--workspace=backend'], {
    cwd: root,
    env: backendEnv,
    stdio: 'inherit',
    shell: true,
  });
  const frontendEnv = {
    ...process.env,
    PORT: E2E_FRONTEND_PORT,
    E2E_BACKEND_URL: `http://localhost:${E2E_BACKEND_PORT}`,
    PLAYWRIGHT_BASE_URL: env.PLAYWRIGHT_BASE_URL,
  };
  frontendProc = spawn('npm', ['run', 'dev', '--workspace=frontend'], {
    cwd: root,
    env: frontendEnv,
    stdio: 'inherit',
    shell: true,
  });

  const healthURL = `${baseURL.replace(/\/$/, '')}/api/health`;
  console.log('Waiting for app at', healthURL, '...');
  await waitForHealth(healthURL);

  console.log('Running Playwright e2e tests...');
  const pw = spawn('npx', ['playwright', 'test', '--config=e2e/playwright.config.ts'], {
    cwd: root,
    env,
    stdio: 'inherit',
    shell: true,
  });

  const code = await new Promise((resolve) => {
    pw.on('close', resolve);
  });

  killAll();
  if (dbPath && fs.existsSync(dbPath)) {
    try {
      fs.unlinkSync(dbPath);
    } catch (_) {}
  }
  process.exit(code);
}

main().catch((err) => {
  console.error(err);
  killAll();
  process.exit(1);
});
