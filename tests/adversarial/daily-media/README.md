# Daily service and media adversarial tests

Owned by the daily-service and visual-wardrobe adversarial threads. Add `*.test.ts` files here (or a
subdirectory with its own `vitest.config.ts` when the cases need their own outbound doubles); see
`../README.md` for the harness and the rules. Keep `COVERAGE.md` and `DEFECTS.md` in this directory.

| Path | Contents |
| --- | --- |
| `media/` | Media abuse cases against the real Worker (cross-owner access, signed URLs, hostile images, queue jobs, deleted images and backups). A nested run with its own `vitest.config.ts`; its `README.md` lists the cases and stand-ins and its `DEFECTS.md` the open defects. |
