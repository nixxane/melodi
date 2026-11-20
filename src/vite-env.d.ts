/// <reference types="vite/client" />

/** package.json version, baked in at build time. */
declare const __APP_VERSION__: string;

interface ImportMetaEnv {
  /** melodi-server's address for the web build, e.g. https://api.getmelodi.xyz */
  readonly VITE_MELODI_API?: string;
}
