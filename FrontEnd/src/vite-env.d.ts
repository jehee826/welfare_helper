/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_ADMIN_DEMO_KEY?: string;
  readonly VITE_USE_MOCK?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
