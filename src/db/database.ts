export type SqlValue = string | number | bigint | Buffer | null;
export type SqlParameters =
  | readonly SqlValue[]
  | Readonly<Record<string, SqlValue>>;

export interface RunResult {
  readonly changes: number;
  readonly lastInsertRowid: number | bigint;
}

/**
 * Small provider-independent persistence contract. SQL supplied to `exec` must
 * be application-owned schema or migration SQL; application values use bindings.
 */
export interface Database {
  exec(sql: string): void;
  run(sql: string, parameters?: SqlParameters): RunResult;
  get<T>(sql: string, parameters?: SqlParameters): T | undefined;
  all<T>(sql: string, parameters?: SqlParameters): T[];
  transaction<T>(operation: () => T): T;
  close(): void;
}
