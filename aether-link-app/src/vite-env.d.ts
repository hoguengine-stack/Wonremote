/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_WONREMOTE_APP_VERSION: string;
  readonly VITE_WONREMOTE_API_URL?: string;
  readonly VITE_WONREMOTE_FIREBASE_API_KEY?: string;
  readonly VITE_WONREMOTE_FIREBASE_AUTH_DOMAIN?: string;
  readonly VITE_WONREMOTE_FIREBASE_PROJECT_ID?: string;
  readonly VITE_WONREMOTE_FIREBASE_APP_ID?: string;
  readonly VITE_WONREMOTE_FIREBASE_STORAGE_BUCKET?: string;
  readonly VITE_WONREMOTE_FIREBASE_MESSAGING_SENDER_ID?: string;
}
