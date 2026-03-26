/**
 * Library entry for @mdguggenbichler/slugbase-core/frontend (Vite lib build).
 * Self-hosted main.tsx loads instrument + theme; embed consumers import CSS via embed.js.
 */
import './index.css';
import './i18n';
export { default as App } from './App';
export { createApiClient } from './api/client';
