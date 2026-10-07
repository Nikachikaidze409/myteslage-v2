/// <reference types="vite/client" />
/// <reference types="@types/google.maps" />

interface ImportMetaEnv {
  readonly VITE_GOOGLE_MAPS_BROWSER_API_KEY: string;
  readonly VITE_GOOGLE_MAPS_MAP_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
