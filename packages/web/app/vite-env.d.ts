/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_MARKETING_ORIGIN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
