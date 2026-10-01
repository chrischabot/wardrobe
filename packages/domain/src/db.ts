/** Thin helpers over the D1 binding. Every query in the domain is owner-qualified by the caller. */

export type Db = D1Database;

export interface Stmt {
  sql: string;
  params: unknown[];
}

export function stmt(sql: string, ...params: unknown[]): Stmt {
  return { sql, params };
}

function normalize(value: unknown): unknown {
  if (value === undefined) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  return value;
}

export function prepare(db: Db, s: Stmt): D1PreparedStatement {
  const p = db.prepare(s.sql);
  return s.params.length > 0 ? p.bind(...s.params.map(normalize)) : p;
}

export async function all<T = Record<string, unknown>>(db: Db, sql: string, ...params: unknown[]): Promise<T[]> {
  const res = await prepare(db, { sql, params }).all<T>();
  return res.results ?? [];
}

export async function first<T = Record<string, unknown>>(db: Db, sql: string, ...params: unknown[]): Promise<T | null> {
  return (await prepare(db, { sql, params }).first<T>()) ?? null;
}

/** Run an IN (...) query in chunks that respect D1's bound-parameter limit. */
export async function allIn<T = Record<string, unknown>>(db: Db, sqlWithPlaceholder: string, leading: unknown[], ids: string[], chunk = 80): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += chunk) {
    const part = ids.slice(i, i + chunk);
    const sql = sqlWithPlaceholder.replace("(:ids)", `(${part.map(() => "?").join(",")})`);
    out.push(...(await all<T>(db, sql, ...leading, ...part)));
  }
  return out;
}

export function json<T>(text: string | null | undefined, fallback: T): T {
  if (text === null || text === undefined || text === "") return fallback;
  return JSON.parse(text) as T;
}
