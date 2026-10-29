/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL?: string
  readonly VITE_GOOGLE_CLIENT_ID?: string
  readonly VITE_DEV_USER?: string
}
interface ImportMeta { readonly env: ImportMetaEnv }

// Google Identity Services (loaded at runtime from accounts.google.com/gsi/client).
interface GoogleIdApi {
  initialize(opts: { client_id: string; callback: (r: { credential: string }) => void; auto_select?: boolean }): void
  renderButton(el: HTMLElement, opts: Record<string, string>): void
  disableAutoSelect(): void
}
interface Window { google?: { accounts: { id: GoogleIdApi } } }
