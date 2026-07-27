/**
 * src/storage/d1.ts
 * -----------------------------------------------------------------------------
 * D1 helpers: prepared-statement wrappers + sortable ID generation.
 *
 * All D1 access in V2 goes through `exec` / `execAll` so that:
 *   - every query is a prepared statement with `bind(...)` (NEVER string
 *     interpolation of user data — V1 had SQL injection vectors);
 *   - we get a single place to add tracing / error logging if needed.
 *
 * `genId` produces a sortable, URL-safe, low-collision identifier suitable for
 * use as the `jobs.id` primary key. Lexicographic ordering matches creation
 * order, which makes "ORDER BY id" a useful proxy for "ORDER BY created_at".
 * -----------------------------------------------------------------------------
 */

/** Current epoch milliseconds. */
export function nowMs(): number {
  return Date.now();
}

/**
 * Generate a sortable unique ID.
 *
 * Format: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2,10)}`.
 * The timestamp prefix makes IDs sortable by creation time; the random suffix
 * disambiguates within the same millisecond.
 */
export function genId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Execute a prepared statement (write or read) and return the raw D1Result.
 * Use this for INSERT / UPDATE / DELETE where you don't need typed rows.
 */
export async function exec(
  db: D1Database,
  sql: string,
  ...params: unknown[]
): Promise<D1Result> {
  return db.prepare(sql).bind(...params).run();
}

/**
 * Execute a query and return the results array, typed as T.
 * Use this for SELECTs.
 */
export async function execAll<T>(
  db: D1Database,
  sql: string,
  ...params: unknown[]
): Promise<T[]> {
  const result = await db.prepare(sql).bind(...params).all<T>();
  return result.results ?? [];
}
