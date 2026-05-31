/// <reference types="astro/client" />

interface ImportMetaEnv {
  readonly PUBLIC_TOLGEE_API_URL?: string;
  readonly PUBLIC_FRONTEND_ORIGIN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
