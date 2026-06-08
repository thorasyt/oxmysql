declare function GetConvar(name: string, defaultValue: string): string;
declare function GetConvarInt(name: string, defaultValue: number): number;
declare function GetInvokingResource(): string;
declare function GetCurrentResourceName(): string;
declare function GetResourcePath(resourceName: string): string;

declare const global: {
  exports(name: string, fn: Function): void;
};

declare function on(event: string, handler: Function): void;
declare function TriggerClientEvent(event: string, source: number, ...args: any[]): void;
declare function RegisterNUICallback(name: string, handler: Function): void;

type CFXCallback = (result: any, error: string | null) => void;
type CFXParameters = Record<string, unknown> | unknown[];
type TransactionQuery = string | { query: string; parameters?: CFXParameters }[];

interface QueryResult {
  affectedRows?: number;
  insertId?: number;
  warningStatus?: number;
  changedRows?: number;
}

interface PoolStats {
  active: number;
  idle: number;
  total: number;
}

interface DatabaseStats {
  totalQueries: number;
  failedQueries: number;
  slowQueries: number;
  avgExecutionTime: number;
  queries: QueryLogEntry[];
  connections: PoolStats;
  isReady: boolean;
  config: {
    host: string;
    database: string;
    poolSize: number;
  };
}

interface QueryLogEntry {
  query: string;
  parameters: string | null;
  executionTime: number;
  resource: string;
  timestamp: number;
  error: string | null;
  isSlow: boolean;
}
