export interface TidbExecutor {
  execute(sql: string, params?: unknown[]): Promise<[unknown, unknown]>;
}

export interface TidbTransaction extends TidbExecutor {
  beginTransaction(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  release(): void;
}

export interface TidbClient extends TidbExecutor {
  getConnection(): Promise<TidbTransaction>;
  end(): Promise<void>;
}
