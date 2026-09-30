-- Migration 0003 (foundation workstream): record how a migration issue was resolved.
-- Additive only. Used when the owner answers a reconciliation question (e.g. 2026-09-29 "All of them").
ALTER TABLE migration_issues ADD COLUMN resolved_at TEXT;
ALTER TABLE migration_issues ADD COLUMN resolution TEXT;
