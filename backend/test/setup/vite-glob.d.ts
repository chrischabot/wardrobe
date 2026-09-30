// Vite's import.meta.glob, used by the source-scan test (tests are bundled by Vite in the workers pool).
interface ImportMeta {
  glob(pattern: string, options?: { query?: string; import?: string; eager?: boolean }): Record<string, unknown>;
}
