/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SLUGBASE_MODE?: string;
  readonly VITE_API_URL?: string;
  readonly VITE_FEATUREBASE_APP_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
