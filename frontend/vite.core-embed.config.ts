import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

/** ESM + CSS bundle for npm consumers (hosted SlugBase Cloud embed). Peers: react, react-dom, react-router-dom. */
export default defineConfig({
  plugins: [react()],
  root: __dirname,
  resolve: {
    alias: {
      '@': resolve(__dirname, './src'),
    },
  },
  define: {
    // No Sentry init in embed unless consumer sets env at their build time
    'import.meta.env.VITE_SENTRY_DSN': JSON.stringify(undefined),
    /** Hosted product embed; PlanContext gates require this. Override when packing for rare self-hosted embed tests. */
    'import.meta.env.VITE_SLUGBASE_MODE': JSON.stringify(process.env.VITE_SLUGBASE_MODE || 'cloud'),
  },
  build: {
    lib: {
      entry: resolve(__dirname, 'src/embed-entry.tsx'),
      name: 'SlugbaseCoreFrontend',
      formats: ['es'],
      fileName: 'slugbase-core-frontend',
    },
    outDir: resolve(__dirname, '../packages/core/frontend/publish'),
    emptyOutDir: true,
    cssCodeSplit: false,
    sourcemap: true,
    rollupOptions: {
      external: (id) => {
        if (id === 'react' || id === 'react-dom' || id === 'react/jsx-runtime' || id === 'react/jsx-dev-runtime') {
          return true;
        }
        if (id.startsWith('react-dom/')) return true;
        if (id === 'react-router' || id === 'react-router-dom') return true;
        if (id.startsWith('react-router/')) return true;
        return false;
      },
      output: {
        assetFileNames: 'slugbase-core-frontend[extname]',
        exports: 'named',
      },
    },
  },
});
