/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_ADMIN_DEMO_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
