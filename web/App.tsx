import { useState, useCallback, useEffect } from 'react';
import { isDebug, useNuiEvent, fetchNui } from './hooks/useNui';

interface Stats {
  totalQueries: number;
  failedQueries: number;
  slowQueries: number;
  avgExecutionTime: number;
  queries: QueryEntry[];
  connections: { active: number; idle: number; total: number };
  isReady: boolean;
  config: { host: string; database: string; poolSize: number };
}

interface QueryEntry {
  query: string;
  parameters: string | null;
  executionTime: number;
  resource: string;
  timestamp: number;
  error: string | null;
  isSlow: boolean;
}

type TabType = 'query' | 'stats' | 'history';

export default function App() {
  const [visible, setVisible] = useState(isDebug);
  const [activeTab, setActiveTab] = useState<TabType>('query');
  const [stats, setStats] = useState<Stats | null>(null);
  const [query, setQuery] = useState('SELECT 1');
  const [results, setResults] = useState<unknown>(null);
  const [error, setError] = useState<string | null>(null);
  const [executing, setExecuting] = useState(false);

  useNuiEvent('open', () => setVisible(true));
  useNuiEvent('close', () => setVisible(false));
  useNuiEvent('stats', (data: Stats) => setStats(data));

  const handleClose = useCallback(() => {
    setVisible(false);
    fetchNui('close', {}, { success: true });
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') handleClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [handleClose]);

  useEffect(() => {
    if (visible) {
      fetchNui<Stats>('getStats', {}, {
        totalQueries: 1247,
        failedQueries: 3,
        slowQueries: 12,
        avgExecutionTime: 23,
        queries: [
          { query: 'SELECT * FROM users', parameters: null, executionTime: 45, resource: 'esx_society', timestamp: Date.now(), error: null, isSlow: false },
          { query: 'UPDATE accounts SET money = ?', parameters: '[5000]', executionTime: 156, resource: 'esx_billing', timestamp: Date.now() - 5000, error: null, isSlow: true },
        ],
        connections: { active: 3, idle: 5, total: 8 },
        isReady: true,
        config: { host: '127.0.0.1', database: 'esx', poolSize: 10 }
      }).then(setStats);
    }
  }, [visible]);

  const executeQuery = useCallback(async () => {
    if (!query.trim() || executing) return;
    setExecuting(true);
    setError(null);
    setResults(null);

    try {
      const result = await fetchNui<unknown>('executeQuery', { query }, [
        { id: 1, name: 'Test User', money: 50000 },
        { id: 2, name: 'Another User', money: 25000 },
      ]);
      setResults(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Query failed');
    } finally {
      setExecuting(false);
    }
  }, [query, executing]);

  const clearStats = useCallback(async () => {
    await fetchNui('clearStats', {}, { success: true });
    if (stats) {
      setStats({ ...stats, totalQueries: 0, failedQueries: 0, slowQueries: 0, avgExecutionTime: 0, queries: [] });
    }
  }, [stats]);

  if (!visible) return null;

  return (
    <div className="w-screen h-screen flex items-center justify-center bg-black/40">
      <main className="w-[900px] h-[700px] max-w-[95vw] max-h-[90vh] bg-[#0d1117] border border-[#30363d] rounded-xl shadow-2xl flex overflow-hidden">
        <Sidebar activeTab={activeTab} setActiveTab={setActiveTab} stats={stats} onClose={handleClose} />
        
        <div className="flex-1 flex flex-col">
          {activeTab === 'query' && (
            <QueryPanel
              query={query}
              setQuery={setQuery}
              results={results}
              error={error}
              executing={executing}
              onExecute={executeQuery}
            />
          )}
          {activeTab === 'stats' && <StatsPanel stats={stats} onClearStats={clearStats} />}
          {activeTab === 'history' && <HistoryPanel queries={stats?.queries ?? []} />}
        </div>
      </main>
    </div>
  );
}

function Sidebar({ activeTab, setActiveTab, stats, onClose }: {
  activeTab: TabType;
  setActiveTab: (t: TabType) => void;
  stats: Stats | null;
  onClose: () => void;
}) {
  return (
    <div className="w-56 bg-[#161b22] border-r border-[#30363d] flex flex-col">
      <div className="p-4 border-b border-[#30363d]">
        <h1 className="text-white font-bold text-lg tracking-tight">MariaDB</h1>
        <p className="text-[#8b949e] text-xs mt-1">Database Manager</p>
      </div>
      
      <div className="flex-1 p-3 space-y-1">
        {(['query', 'stats', 'history'] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`w-full text-left px-3 py-2 rounded-lg text-sm transition-colors ${
              activeTab === tab
                ? 'bg-[#238636] text-white'
                : 'text-[#8b949e] hover:bg-[#21262d] hover:text-white'
            }`}
          >
            {tab.charAt(0).toUpperCase() + tab.slice(1)}
          </button>
        ))}
      </div>

      <div className="p-3 border-t border-[#30363d]">
        <div className="flex items-center gap-2 mb-2">
          <div className={`w-2 h-2 rounded-full ${stats?.isReady ? 'bg-[#238636]' : 'bg-[#f85149]'}`} />
          <span className="text-xs text-[#8b949e]">
            {stats?.isReady ? 'Connected' : 'Disconnected'}
          </span>
        </div>
        {stats?.config && (
          <div className="text-xs text-[#6e7681] space-y-0.5">
            <div>{stats.config.host}</div>
            <div>{stats.config.database}</div>
          </div>
        )}
      </div>

      <div className="p-3 border-t border-[#30363d]">
        <button
          onClick={onClose}
          className="w-full px-3 py-2 text-[#8b949e] hover:text-white hover:bg-[#21262d] rounded-lg text-sm transition-colors"
        >
          Close
        </button>
      </div>
    </div>
  );
}

function QueryPanel({ query, setQuery, results, error, executing, onExecute }: {
  query: string;
  setQuery: (q: string) => void;
  results: unknown;
  error: string | null;
  executing: boolean;
  onExecute: () => void;
}) {
  return (
    <div className="flex-1 flex flex-col">
      <div className="p-4 border-b border-[#30363d]">
        <div className="flex items-center gap-3">
          <textarea
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="flex-1 bg-[#0d1117] border border-[#30363d] rounded-lg px-3 py-2 text-white text-sm font-mono resize-none focus:outline-none focus:border-[#238636] transition-colors"
            rows={3}
            placeholder="Enter SQL query..."
            spellCheck={false}
          />
          <button
            onClick={onExecute}
            disabled={executing}
            className="px-4 py-2 bg-[#238636] hover:bg-[#2ea043] disabled:bg-[#21262d] text-white rounded-lg text-sm font-medium transition-colors h-fit"
          >
            {executing ? 'Running...' : 'Execute'}
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-auto p-4">
        {error && (
          <div className="bg-[#f85149]/10 border border-[#f85149]/30 rounded-lg p-3 text-[#f85149] text-sm mb-4">
            {error}
          </div>
        )}
        
        {results && (
          <div className="bg-[#161b22] border border-[#30363d] rounded-lg overflow-hidden">
            <div className="px-3 py-2 bg-[#21262d] border-b border-[#30363d] text-xs text-[#8b949e] uppercase tracking-wider">
              Results
            </div>
            <div className="p-3 overflow-auto max-h-80">
              <ResultViewer data={results} />
            </div>
          </div>
        )}

        {!results && !error && (
          <div className="h-full flex items-center justify-center text-[#6e7681] text-sm">
            Execute a query to see results
          </div>
        )}
      </div>
    </div>
  );
}

function ResultViewer({ data }: { data: unknown }) {
  if (Array.isArray(data)) {
    if (data.length === 0) {
      return <span className="text-[#8b949e]">Empty result set</span>;
    }

    const columns = Object.keys(data[0] as Record<string, unknown>);

    return (
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-[#8b949e]">
            {columns.map((col) => (
              <th key={col} className="pr-4 pb-2 font-medium">{col}</th>
            ))}
          </tr>
        </thead>
        <tbody className="text-white">
          {data.slice(0, 50).map((row, i) => (
            <tr key={i} className="border-t border-[#21262d]">
              {columns.map((col) => (
                <td key={col} className="pr-4 py-1 font-mono text-xs">
                  {String((row as Record<string, unknown>)[col])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    );
  }

  if (typeof data === 'object' && data !== null) {
    return (
      <div className="font-mono text-xs text-[#8b949e]">
        <div>Affected rows: {(data as Record<string, unknown>).affectedRows ?? 'N/A'}</div>
        <div>Insert ID: {(data as Record<string, unknown>).insertId ?? 'N/A'}</div>
      </div>
    );
  }

  return <span className="text-white font-mono text-sm">{String(data)}</span>;
}

function StatsPanel({ stats, onClearStats }: { stats: Stats | null; onClearStats: () => void }) {
  if (!stats) {
    return <div className="flex-1 flex items-center justify-center text-[#6e7681]">Loading stats...</div>;
  }

  return (
    <div className="flex-1 overflow-auto p-6">
      <div className="grid grid-cols-2 gap-4 mb-6">
        <StatCard label="Total Queries" value={stats.totalQueries} />
        <StatCard label="Failed Queries" value={stats.failedQueries} highlight={stats.failedQueries > 0} />
        <StatCard label="Slow Queries" value={stats.slowQueries} highlight={stats.slowQueries > 0} />
        <StatCard label="Avg. Execution" value={`${stats.avgExecutionTime}ms`} />
      </div>

      <div className="bg-[#161b22] border border-[#30363d] rounded-lg p-4 mb-6">
        <h3 className="text-white font-medium mb-3">Connection Pool</h3>
        <div className="grid grid-cols-3 gap-4 text-center">
          <div>
            <div className="text-2xl font-bold text-[#58a6ff]">{stats.connections.active}</div>
            <div className="text-xs text-[#8b949e]">Active</div>
          </div>
          <div>
            <div className="text-2xl font-bold text-[#238636]">{stats.connections.idle}</div>
            <div className="text-xs text-[#8b949e]">Idle</div>
          </div>
          <div>
            <div className="text-2xl font-bold text-white">{stats.connections.total}</div>
            <div className="text-xs text-[#8b949e]">Total</div>
          </div>
        </div>
      </div>

      <button
        onClick={onClearStats}
        className="px-4 py-2 bg-[#21262d] hover:bg-[#30363d] text-[#8b949e] hover:text-white rounded-lg text-sm transition-colors"
      >
        Clear Stats
      </button>
    </div>
  );
}

function StatCard({ label, value, highlight }: { label: string; value: string | number; highlight?: boolean }) {
  return (
    <div className="bg-[#161b22] border border-[#30363d] rounded-lg p-4">
      <div className={`text-2xl font-bold ${highlight ? 'text-[#f85149]' : 'text-white'}`}>{value}</div>
      <div className="text-xs text-[#8b949e] mt-1">{label}</div>
    </div>
  );
}

function HistoryPanel({ queries }: { queries: QueryEntry[] }) {
  if (queries.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-[#6e7681]">No query history</div>
    );
  }

  return (
    <div className="flex-1 overflow-auto">
      <div className="divide-y divide-[#21262d]">
        {queries.map((q, i) => (
          <div key={i} className="p-4 hover:bg-[#161b22] transition-colors">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs text-[#8b949e]">{q.resource}</span>
              <span className={`text-xs px-2 py-0.5 rounded ${
                q.error ? 'bg-[#f85149]/20 text-[#f85149]' :
                q.isSlow ? 'bg-[#d29922]/20 text-[#d29922]' :
                'bg-[#238636]/20 text-[#238636]'
              }`}>
                {q.executionTime}ms
              </span>
            </div>
            <pre className="text-sm text-white font-mono whitespace-pre-wrap break-all">{q.query}</pre>
            {q.error && <div className="text-xs text-[#f85149] mt-2">{q.error}</div>}
          </div>
        ))}
      </div>
    </div>
  );
}
