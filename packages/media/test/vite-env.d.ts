/** `import.meta.glob` as used by test/composite-example.test.ts: the committed example files, read when the tests are built (text, or the picture as a data URL). */
interface ImportMeta {
  glob(pattern: string, options: { query: "?raw" | "?inline"; import: "default"; eager: true }): Record<string, unknown>;
}
