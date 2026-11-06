// A STRICT description of import.meta.env.
//
// Vite's own types (`/// <reference types="vite/client" />`) add an "anything goes" rule to ImportMetaEnv:
//     [key: string]: any
// With that rule, import.meta.env.VITE_API_BASE_URI (a typo) is allowed and quietly becomes `undefined`.
// So this file does NOT load vite/client. It lists every variable the app may read, and nothing else.
// Every variable here must start with VITE_ to reach the browser. Add new ones here first.
interface ImportMetaEnv {
  readonly VITE_API_BASE_URL: string;
  readonly MODE: string; // "development", "cors", "production", "test"
  readonly DEV: boolean;
  readonly PROD: boolean;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

// Because vite/client is not loaded, CSS imports need a line here (they only run for their side effect).
declare module "*.css";
