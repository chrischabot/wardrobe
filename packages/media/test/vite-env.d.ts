/** `import.meta.glob` as used by test/composite-example.test.ts: the committed example files, read as text when the tests are built. */
interface ImportMeta {
  glob(pattern: string, options: { query: "?raw"; import: "default"; eager: true }): Record<string, unknown>;
}
