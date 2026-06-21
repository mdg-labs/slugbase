import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  root: import.meta.dirname,
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: "../dist/client",
    emptyOutDir: true,
  },
});
