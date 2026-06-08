/// <reference path="./types.d.ts" />

const mariadb = require('mariadb');

let pool = null;
let isReady = false;
let stats = {
    totalQueries: 0,
    failedQueries: 0,
    slowQueries: 0,
    avgExecutionTime: 0,
    queries: [],
    connections: { active: 0, idle: 0, total: 0 }
};

let connectionString = GetConvar('mysql_connection_string', '');
let parsedConfig = {};
if (connectionString) {
    connectionString = connectionString.trim().replace(/^['"]|['"]$/g, '');
    const match = connectionString.match(/^mysql:\/\/(?:([^:]+)(?::([^@]+))?@)?([^:\/]+)(?::(\d+))?\/([^?]+)/);
    if (match) {
        parsedConfig = {
            user: match[1] || 'root',
            password: match[2] || '',
            host: match[3] === 'localhost' ? '127.0.0.1' : match[3],
            port: match[4] ? parseInt(match[4]) : 3306,
            database: match[5]
        };
    }
}

const config = {
    host: parsedConfig.host || GetConvar('mysql_connection_host', '127.0.0.1'),
    port: parsedConfig.port || parseInt(GetConvar('mysql_connection_port', '3306')),
    user: parsedConfig.user || GetConvar('mysql_connection_user', 'root'),
    password: parsedConfig.password !== undefined ? parsedConfig.password : GetConvar('mysql_connection_password', ''),
    database: parsedConfig.database || GetConvar('mysql_connection_database', 'esx'),
    connectionLimit: parseInt(GetConvar('mysql_pool_max', '10')),
    acquireTimeout: parseInt(GetConvar('mysql_acquire_timeout', '30000')),
    idleTimeout: parseInt(GetConvar('mysql_idle_timeout', '60000')),
    timezone: GetConvar('mysql_timezone', 'local'),
    trace: GetConvarInt('mysql_debug', 0) === 1,
    multipleStatements: true,
    dateStrings: true,
    bigNumberStrings: true,
    supportBigNumbers: true,
};

const slowQueryThreshold = parseInt(GetConvar('mysql_slow_query_threshold', '100'));
const returnCallbackErrors = GetConvarInt('mysql_return_callback_errors', 0) === 1;

function formatDate(date) {
    if (!date) return null;
    if (typeof date === 'string') return date;
    const d = new Date(date);
    return d.toISOString().slice(0, 19).replace('T', ' ');
}

function parseRow(row) {
    if (!row) return row;
    const parsed = {};
    for (const key of Object.keys(row)) {
        const val = row[key];
        if (val instanceof Date) {
            parsed[key] = formatDate(val);
        } else if (Buffer.isBuffer(val)) {
            parsed[key] = val.toString('base64');
        } else {
            parsed[key] = val;
        }
    }
    return parsed;
}

function parseResult(result, mode) {
    if (!result) return result;
    
    if (mode === 'scalar') {
        if (Array.isArray(result) && result.length > 0) {
            const row = result[0];
            if (row && typeof row === 'object') {
                const keys = Object.keys(row);
                return keys.length > 0 ? parseRow(row)[keys[0]] : null;
            }
            return row;
        }
        return null;
    }
    
    if (mode === 'single') {
        if (Array.isArray(result) && result.length > 0) {
            return parseRow(result[0]);
        }
        return null;
    }
    
    if (mode === 'update' || mode === 'insert') {
        if (result && typeof result === 'object') {
            return {
                affectedRows: result.affectedRows || 0,
                insertId: result.insertId || 0,
                warningStatus: result.warningStatus || 0,
                changedRows: result.changedRows || 0
            };
        }
        return result;
    }
    
    if (Array.isArray(result)) {
        return result.map(row => parseRow(row));
    }
    
    return result;
}

function logQuery(query, parameters, executionTime, resource, error) {
    const isSlow = executionTime > slowQueryThreshold;
    const entry = {
        query: query.substring(0, 200),
        parameters: parameters ? JSON.stringify(parameters).substring(0, 100) : null,
        executionTime,
        resource,
        timestamp: Date.now(),
        error: error ? error.message : null,
        isSlow
    };
    
    stats.queries.unshift(entry);
    if (stats.queries.length > 50) stats.queries.pop();
    
    if (isSlow && slowQueryThreshold > 0) {
        stats.slowQueries++;
        console.log(`^3[mariaDB] Slow query (${executionTime}ms) from ${resource}: ${query.substring(0, 100)}^0`);
    }
    
    if (error) {
        console.log(`^1[mariaDB] Query error from ${resource}: ${error.message}^0`);
    }
}

function updateStats(executionTime, failed = false) {
    stats.totalQueries++;
    if (failed) stats.failedQueries++;
    stats.avgExecutionTime = Math.round((stats.avgExecutionTime * (stats.totalQueries - 1) + executionTime) / stats.totalQueries);
}

async function initPool() {
    try {
        pool = mariadb.createPool(config);
        
        const conn = await pool.getConnection();
        await conn.ping();
        conn.release();
        
        isReady = true;
        console.log(`^2[mariaDB] Connected to database: ${config.database}@${config.host}:${config.port}^0`);
        console.log(`^2[mariaDB] Pool initialized with max ${config.connectionLimit} connections^0`);
        
        setInterval(updatePoolStats, 5000);
    } catch (err) {
        console.log(`^1[mariaDB] Failed to connect: ${err.message}^0`);
        setTimeout(initPool, 5000);
    }
}

function updatePoolStats() {
    if (pool) {
        stats.connections = {
            active: pool.activeConnections() || 0,
            idle: pool.idleConnections() || 0,
            total: pool.totalConnections() || 0
        };
    }
}

async function executeQuery(query, parameters, resource, mode = null) {
    if (!isReady || !pool) {
        throw new Error('Database not connected');
    }
    
    const startTime = Date.now();
    let conn = null;
    
    try {
        conn = await pool.getConnection();
        const result = await conn.query(query, parameters);
        const executionTime = Date.now() - startTime;
        
        logQuery(query, parameters, executionTime, resource, null);
        updateStats(executionTime);
        
        return parseResult(result, mode);
    } catch (err) {
        const executionTime = Date.now() - startTime;
        logQuery(query, parameters, executionTime, resource, err);
        updateStats(executionTime, true);
        throw err;
    } finally {
        if (conn) conn.release();
    }
}

async function executeTransaction(queries, parameters, resource) {
    if (!isReady || !pool) {
        throw new Error('Database not connected');
    }
    
    const startTime = Date.now();
    let conn = null;
    
    try {
        conn = await pool.getConnection();
        await conn.beginTransaction();
        
        const results = [];
        
        for (let i = 0; i < queries.length; i++) {
            const queryObj = queries[i];
            const query = typeof queryObj === 'string' ? queryObj : queryObj.query;
            const params = parameters ? (Array.isArray(parameters[0]) ? parameters[i] : parameters) : queryObj.parameters;
            
            const result = await conn.query(query, params || []);
            results.push(parseResult(result, null));
        }
        
        await conn.commit();
        
        const executionTime = Date.now() - startTime;
        logQuery(`TRANSACTION (${queries.length} queries)`, null, executionTime, resource, null);
        updateStats(executionTime);
        
        return results;
    } catch (err) {
        if (conn) await conn.rollback();
        const executionTime = Date.now() - startTime;
        logQuery(`TRANSACTION FAILED`, null, executionTime, resource, err);
        updateStats(executionTime, true);
        throw err;
    } finally {
        if (conn) conn.release();
    }
}

async function executeRaw(query, parameters, resource, prepare = false) {
    if (!isReady || !pool) {
        throw new Error('Database not connected');
    }
    
    const startTime = Date.now();
    let conn = null;
    
    try {
        conn = await pool.getConnection();
        
        let result;
        if (prepare) {
            const stmt = await conn.prepare(query);
            try {
                result = await stmt.execute(parameters);
            } finally {
                await stmt.close();
            }
        } else {
            result = await conn.query(query, parameters);
        }
        
        const executionTime = Date.now() - startTime;
        logQuery(query, parameters, executionTime, resource, null);
        updateStats(executionTime);
        
        return parseResult(result, null);
    } catch (err) {
        const executionTime = Date.now() - startTime;
        logQuery(query, parameters, executionTime, resource, err);
        updateStats(executionTime, true);
        throw err;
    } finally {
        if (conn) conn.release();
    }
}

function handleCallback(cb, result, error, resource) {
    if (cb) {
        try {
            if (error) {
                if (returnCallbackErrors) {
                    cb(null, error.message);
                } else {
                    console.log(`^1[mariaDB] Error in ${resource}: ${error.message}^0`);
                    cb(null, null);
                }
            } else {
                cb(result, null);
            }
        } catch (e) {
            console.log(`^1[mariaDB] Callback error in ${resource}: ${e.message}^0`);
        }
    }
}

function createExportFunction(mode) {
    return function(query, parameters, cb, resource, isPromise) {
        const invokingResource = resource || GetInvokingResource() || 'unknown';
        
        if (isPromise) {
            return new Promise((resolve, reject) => {
                executeQuery(query, parameters, invokingResource, mode)
                    .then(result => resolve(result))
                    .catch(err => reject(new Error(err.message)));
            });
        }
        
        executeQuery(query, parameters, invokingResource, mode)
            .then(result => handleCallback(cb, result, null, invokingResource))
            .catch(err => handleCallback(cb, null, err, invokingResource));
    };
}

global.exports('isReady', () => isReady);

global.exports('awaitConnection', async function() {
    while (!isReady) {
        await new Promise(resolve => setTimeout(resolve, 50));
    }
    return true;
});

global.exports('query', createExportFunction(null));
global.exports('single', createExportFunction('single'));
global.exports('scalar', createExportFunction('scalar'));
global.exports('update', createExportFunction('update'));
global.exports('insert', createExportFunction('insert'));

global.exports('prepare', function(query, parameters, cb, resource, isPromise) {
    const invokingResource = resource || GetInvokingResource() || 'unknown';
    
    if (isPromise) {
        return new Promise((resolve, reject) => {
            executeRaw(query, parameters, invokingResource, true)
                .then(result => resolve(result))
                .catch(err => reject(new Error(err.message)));
        });
    }
    
    executeRaw(query, parameters, invokingResource, true)
        .then(result => handleCallback(cb, result, null, invokingResource))
        .catch(err => handleCallback(cb, null, err, invokingResource));
});

global.exports('rawExecute', function(query, parameters, cb, resource, isPromise) {
    const invokingResource = resource || GetInvokingResource() || 'unknown';
    
    if (isPromise) {
        return new Promise((resolve, reject) => {
            executeRaw(query, parameters, invokingResource, false)
                .then(result => resolve(result))
                .catch(err => reject(new Error(err.message)));
        });
    }
    
    executeRaw(query, parameters, invokingResource, false)
        .then(result => handleCallback(cb, result, null, invokingResource))
        .catch(err => handleCallback(cb, null, err, invokingResource));
});

global.exports('transaction', function(queries, parameters, cb, resource, isPromise) {
    const invokingResource = resource || GetInvokingResource() || 'unknown';
    
    if (!Array.isArray(queries)) {
        const error = new Error('Transaction queries must be an array');
        if (isPromise) return Promise.reject(error);
        return handleCallback(cb, null, error, invokingResource);
    }
    
    if (isPromise) {
        return new Promise((resolve, reject) => {
            executeTransaction(queries, parameters, invokingResource)
                .then(result => resolve(result))
                .catch(err => reject(new Error(err.message)));
        });
    }
    
    executeTransaction(queries, parameters, invokingResource)
        .then(result => handleCallback(cb, result, null, invokingResource))
        .catch(err => handleCallback(cb, null, err, invokingResource));
});

global.exports('startTransaction', async function(cb, resource) {
    const invokingResource = resource || GetInvokingResource() || 'unknown';
    console.log('^3[mariaDB] startTransaction is experimental^0');
    
    if (!isReady || !pool) {
        throw new Error('Database not connected');
    }
    
    let conn = null;
    let committed = false;
    
    try {
        conn = await pool.getConnection();
        await conn.beginTransaction();
        
        const api = {
            query: async (query, params) => {
                if (committed) throw new Error('Transaction already committed');
                return conn.query(query, params);
            },
            commit: async () => {
                if (committed) return;
                await conn.commit();
                committed = true;
            },
            rollback: async () => {
                if (committed) return;
                await conn.rollback();
                committed = true;
            }
        };
        
        if (cb) {
            await cb(api);
            if (!committed) await api.commit();
        }
        
        return api;
    } catch (err) {
        if (conn && !committed) await conn.rollback();
        throw err;
    } finally {
        if (conn) conn.release();
    }
});

global.exports('getStats', () => ({
    ...stats,
    isReady,
    config: {
        host: config.host,
        database: config.database,
        poolSize: config.connectionLimit
    }
}));

global.exports('clearStats', () => {
    stats.totalQueries = 0;
    stats.failedQueries = 0;
    stats.slowQueries = 0;
    stats.avgExecutionTime = 0;
    stats.queries = [];
    return true;
});

global.exports('escape', (value) => {
    if (value === null || value === undefined) return 'NULL';
    if (typeof value === 'number') return value;
    if (typeof value === 'boolean') return value ? 1 : 0;
    return `'${String(value).replace(/'/g, "''")}'`;
});

global.exports('formatDate', formatDate);

global.exports('tableExists', async function(tableName, resource) {
    const invokingResource = resource || GetInvokingResource() || 'unknown';
    const result = await executeQuery(
        `SELECT COUNT(*) as count FROM information_schema.tables WHERE table_schema = ? AND table_name = ?`,
        [config.database, tableName],
        invokingResource,
        'scalar'
    );
    return result > 0;
});

global.exports('columnExists', async function(tableName, columnName, resource) {
    const invokingResource = resource || GetInvokingResource() || 'unknown';
    const result = await executeQuery(
        `SELECT COUNT(*) as count FROM information_schema.columns WHERE table_schema = ? AND table_name = ? AND column_name = ?`,
        [config.database, tableName, columnName],
        invokingResource,
        'scalar'
    );
    return result > 0;
});

global.exports('executeFile', async function(filePath, resource) {
    const invokingResource = resource || GetInvokingResource() || 'unknown';
    const fs = require('fs');
    const path = require('path');
    
    const fullPath = path.join(GetResourcePath(invokingResource), filePath);
    const content = fs.readFileSync(fullPath, 'utf8');
    
    const queries = content.split(';').filter(q => q.trim());
    const results = [];
    
    for (const query of queries) {
        results.push(await executeQuery(query.trim(), [], invokingResource, null));
    }
    
    return results;
});

for (const method of ['query', 'single', 'scalar', 'update', 'insert', 'prepare', 'rawExecute', 'transaction']) {
    global.exports(`${method}_async`, async function(query, parameters, resource) {
        const invokingResource = resource || GetInvokingResource() || 'unknown';
        
        if (method === 'transaction') {
            return executeTransaction(query, parameters, invokingResource);
        }
        
        if (method === 'prepare') {
            return executeRaw(query, parameters, invokingResource, true);
        }
        
        if (method === 'rawExecute') {
            return executeRaw(query, parameters, invokingResource, false);
        }
        
        return executeQuery(query, parameters, invokingResource, method);
    });
    
    global.exports(`${method}Sync`, async function(query, parameters, resource) {
        const invokingResource = resource || GetInvokingResource() || 'unknown';
        
        if (method === 'transaction') {
            return executeTransaction(query, parameters, invokingResource);
        }
        
        if (method === 'prepare') {
            return executeRaw(query, parameters, invokingResource, true);
        }
        
        if (method === 'rawExecute') {
            return executeRaw(query, parameters, invokingResource, false);
        }
        
        return executeQuery(query, parameters, invokingResource, method);
    });
}

global.exports('store', (query, cb) => {
    if (cb) cb(query);
    return query;
});

global.exports('execute', createExportFunction(null));
global.exports('fetch', createExportFunction(null));

on('onServerResourceStart', (resName) => {
    if (resName === GetCurrentResourceName()) {
        initPool();
    }
});

on('onResourceStop', (resName) => {
    if (resName === GetCurrentResourceName() && pool) {
        pool.end();
        console.log('^2[mariaDB] Pool closed^0');
    }
});
