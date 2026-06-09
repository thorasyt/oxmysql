const mariadb = require('mariadb');
let pool = null;
let stats = {
  totalQueries: 0,
  failedQueries: 0,
  slowQueries: 0,
  avgExecutionTime: 0,
  queries: [],
  connections: { active: 0, idle: 0, total: 0 }
};

const mysql_connection_string = GetConvar('mysql_connection_string', '') || 'mysql://root@localhost';
const mysql_transaction_isolation_level = getIsolationLevelStatement(GetConvarInt('mysql_transaction_isolation_level', 2));

function getIsolationLevelStatement(level) {
  const query = 'SET TRANSACTION ISOLATION LEVEL';
  switch (level) {
    case 1: return `${query} REPEATABLE READ`;
    case 2: return `${query} READ COMMITTED`;
    case 3: return `${query} READ UNCOMMITTED`;
    case 4: return `${query} SERIALIZABLE`;
    default: return `${query} READ COMMITTED`;
  }
}

function parseUri(connectionString) {
  try {
    const url = new URL(connectionString);
    const options = {
      user: url.username || undefined,
      password: url.password || undefined,
      host: url.hostname || 'localhost',
      port: url.port ? parseInt(url.port) : 3306,
      database: url.pathname ? url.pathname.slice(1) : undefined,
    };
    url.searchParams.forEach((value, key) => {
      options[key] = value;
    });
    return options;
  } catch (e) {
    const match = connectionString.match(
      /^mysql:\/\/(?:([^:@/?#]+)(?::([^:@/?#]*))?@)?([^:@/?#]+)(?::(\d+))?\/([^?]*)(?:\?(.*))?$/
    );
    if (!match) {
      throw new Error(`mysql_connection_string structure was invalid (${connectionString})`);
    }
    const options = {
      user: match[1] || undefined,
      password: match[2] || undefined,
      host: match[3] || 'localhost',
      port: match[4] ? parseInt(match[4]) : 3306,
      database: match[5] || undefined,
    };
    if (match[6]) {
      match[6].split('&').forEach(param => {
        const [key, value] = param.split('=');
        if (key && value !== undefined) {
          options[key] = value;
        }
      });
    }
    return options;
  }
}

function getConnectionOptions(connectionString = mysql_connection_string) {
  let options = {};
  if (connectionString.includes('mysql://')) {
    options = parseUri(connectionString);
  } else {
    options = connectionString
      .replace(/(?:host(?:name)|ip|server|data\s?source|addr(?:ess)?)=/gi, 'host=')
      .replace(/(?:user\s?(?:id|name)?|uid)=/gi, 'user=')
      .replace(/(?:pwd|pass)=/gi, 'password=')
      .replace(/(?:db)=/gi, 'database=')
      .split(';')
      .reduce((acc, param) => {
        const [key, value] = param.split('=');
        if (key) acc[key] = value;
        return acc;
      }, {});
  }
  return {
    host: options.host || '127.0.0.1',
    port: options.port ? parseInt(options.port) : 3306,
    user: options.user || 'root',
    password: options.password !== undefined ? options.password : '',
    database: options.database || '',
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
}

const config = getConnectionOptions();
const slowQueryThreshold = parseInt(GetConvar('mysql_slow_query_threshold', '0'));

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
    } else if (typeof val === 'string') {
      if (/^-?\d+$/.test(val) && val.length <= 15) {
        parsed[key] = parseInt(val, 10);
      } else if (/^-?\d+\.\d+$/.test(val) && val.length <= 20) {
        parsed[key] = parseFloat(val);
      } else {
        parsed[key] = val;
      }
    } else if (typeof val === 'bigint') {
      parsed[key] = Number(val);
    } else {
      parsed[key] = val;
    }
  }
  return parsed;
}

function parseResult(result, mode) {
  if (!result) return result;
  if (!Array.isArray(result) && typeof result === 'object' && result.affectedRows !== undefined) {
    const affectedRows = Number(result.affectedRows || 0);
    const insertId = Number(result.insertId || 0);
    if (mode === 'insert') return insertId;
    if (mode === 'update') return affectedRows;
    return {
      affectedRows,
      insertId,
      warningStatus: Number(result.warningStatus || 0),
      changedRows: Number(result.changedRows || 0)
    };
  }
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
  if (mode === 'prepare') {
    if (Array.isArray(result)) {
      const values = result.map(row => {
        if (row && typeof row === 'object') {
          const parsed = parseRow(row);
          const keys = Object.keys(parsed);
          return keys.length === 1 ? parsed[keys[0]] : parsed;
        }
        return row;
      });
      return values.length === 1 ? values[0] : values;
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

async function createConnectionPool() {
  try {
    pool = mariadb.createPool(config);

    pool.on('connection', (connection) => {
      connection.query(mysql_transaction_isolation_level).catch(() => { });
    });

    const conn = await pool.getConnection();
    const [versionResult] = await conn.query('SELECT VERSION() as version');
    await conn.release();

    const dbVersion = versionResult?.version || 'unknown';

    console.log(`^5[${dbVersion}] ^2Database server connection established!^0`);
    console.log(`^2[mariaDB] Pool initialized with max ${config.connectionLimit} connections^0`);

    if (config.multipleStatements) {
      console.warn(`multipleStatements is enabled. Used incorrectly, this option may cause SQL injection.`);
    }

    setInterval(updatePoolStats, 5000);
  } catch (err) {
    const message = err.message.includes('auth_gssapi_client')
      ? `Requested authentication using unknown plugin auth_gssapi_client.`
      : err.message;
    console.log(
      `^3Unable to establish a connection to the database (${err.code || 'unknown'})!\n^1Error${err.errno ? ` ${err.errno}` : ''}: ${message}^0`
    );
    console.log(`See https://github.com/overextended/oxmysql/issues/154 for more information.`);
    if (config.password) config.password = '******';
    console.log(config);
    pool = null;
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
  while (!pool) {
    await new Promise(resolve => setTimeout(resolve, 50));
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

function parseTransactionQuery(queryObj, parameters, index) {
  if (Array.isArray(queryObj)) {
    return parseArguments(queryObj[0], queryObj[1]);
  }
  if (queryObj && typeof queryObj === 'object') {
    return parseArguments(queryObj.query, queryObj.parameters || queryObj.values);
  }
  const queryParameters = Array.isArray(parameters) && Array.isArray(parameters[0])
    ? parameters[index]
    : parameters;
  return parseArguments(queryObj, queryParameters);
}

async function executeTransaction(queries, parameters, resource) {
  while (!pool) {
    await new Promise(resolve => setTimeout(resolve, 50));
  }

  const startTime = Date.now();
  let conn = null;

  try {
    conn = await pool.getConnection();
    await conn.beginTransaction();

    const parsedQueries = queries.map((query, index) => parseTransactionQuery(query, parameters, index));

    for (let i = 0; i < parsedQueries.length; i++) {
      const [query, params] = parsedQueries[i];

      const batchParams = [];
      while (
        i < parsedQueries.length &&
        parsedQueries[i][0] === query &&
        Array.isArray(parsedQueries[i][1]) &&
        parsedQueries[i][1].length > 0
      ) {
        batchParams.push(parsedQueries[i][1]);
        i++;
      }

      if (batchParams.length > 1) {
        await conn.batch(query, batchParams);
        i--;
      } else {
        const queryParams = batchParams[0] || params || [];
        await conn.query(query, queryParams);
      }
    }

    await conn.commit();

    const executionTime = Date.now() - startTime;
    logQuery(`TRANSACTION (${queries.length} queries)`, null, executionTime, resource, null);
    updateStats(executionTime);

    return true;
  } catch (err) {
    if (conn) await conn.rollback().catch(() => { });
    const executionTime = Date.now() - startTime;
    logQuery(`TRANSACTION FAILED`, null, executionTime, resource, err);
    updateStats(executionTime, true);
    console.log(`^1[mariaDB] Error in ${resource}: ${err.message}^0`);
    return false;
  } finally {
    if (conn) conn.release();
  }
}

async function executeRaw(query, parameters, resource, prepare = false) {
  while (!pool) {
    await new Promise(resolve => setTimeout(resolve, 50));
  }

  const startTime = Date.now();
  let conn = null;

  try {
    conn = await pool.getConnection();
    let result;

    if (prepare) {
      if (Array.isArray(parameters) && Array.isArray(parameters[0])) {
        if (/^\s*(?:select|show|describe|desc|explain)\b/i.test(query)) {
          result = [];
          const stmt = await conn.prepare(query);

          try {
            for (const values of parameters) {
              const response = await stmt.execute(values);

              if (Array.isArray(response)) {
                result.push(...response);
              } else {
                result.push(response);
              }
            }
          } finally {
            await stmt.close();
          }
        } else {
          try {
            result = await conn.batch(query, parameters);
          } catch (err) {
            if (err.errno !== 1295) throw err;
            result = [];
            const stmt = await conn.prepare(query);

            try {
              for (const values of parameters) {
                const response = await stmt.execute(values);

                if (Array.isArray(response)) {
                  result.push(...response);
                } else {
                  result.push(response);
                }
              }
            } finally {
              await stmt.close();
            }
          }
        }
      } else {
        const stmt = await conn.prepare(query);

        try {
          result = await stmt.execute(parameters);
        } finally {
          await stmt.close();
        }
      }
    } else {
      result = await conn.query(query, parameters);
    }

    const executionTime = Date.now() - startTime;
    logQuery(query, parameters, executionTime, resource, null);
    updateStats(executionTime);

    return parseResult(result, prepare ? 'prepare' : null);
  } catch (err) {
    const executionTime = Date.now() - startTime;
    logQuery(query, parameters, executionTime, resource, err);
    updateStats(executionTime, true);
    throw err;
  } finally {
    if (conn) conn.release();
  }
}

function setCallback(parameters, cb) {
  if (cb && typeof cb === 'function') return cb;
  if (parameters && typeof parameters === 'function') return parameters;
  return null;
}

function getResourceName(invokingResource) {
  return typeof invokingResource === 'string' && invokingResource.length > 0
    ? invokingResource
    : GetInvokingResource() || 'unknown';
}

function parseArguments(query, parameters) {
  if (typeof query !== 'string') {
    throw new Error(`Expected query to be a string but received ${typeof query} instead.`);
  }

  if (!parameters || typeof parameters === 'function') parameters = [];

  const namedParamRegex = /@([a-zA-Z_][a-zA-Z0-9_]*)|:([a-zA-Z_][a-zA-Z0-9_]*)/g;
  const namedParams = [];
  let match;
  let processedQuery = query;
  const paramPositions = [];

  while ((match = namedParamRegex.exec(query)) !== null) {
    const paramName = match[1] || match[2];
    const fullMatch = match[0];
    const startIndex = match.index;

    let alreadyAdded = false;
    for (const pos of paramPositions) {
      if (pos.start === startIndex) {
        alreadyAdded = true;
        break;
      }
    }

    if (!alreadyAdded) {
      namedParams.push(paramName);
      paramPositions.push({ start: startIndex, end: startIndex + fullMatch.length, name: paramName });
    }
  }

  if (namedParams.length > 0 && !Array.isArray(parameters)) {
    const arr = [];
    for (const paramName of namedParams) {
      arr.push(parameters[paramName] ?? null);
    }
    parameters = arr;

    paramPositions.sort((a, b) => b.start - a.start);
    for (const pos of paramPositions) {
      processedQuery = processedQuery.substring(0, pos.start) + '?' + processedQuery.substring(pos.end);
    }
  } else if (Array.isArray(parameters)) {
    const escapedPlaceholders = query.match(/\?\?/g)?.length ?? 0;
    const regularPlaceholders = query.replace(/\?\?/g, '').match(/\?/g)?.length ?? 0;
    const totalNeeded = regularPlaceholders;

    if (parameters.length === 0 && totalNeeded > 0) {
      for (let i = 0; i < totalNeeded; i++) parameters[i] = null;
    }
  } else if (!Array.isArray(parameters)) {
    const escapedPlaceholders = query.match(/\?\?/g)?.length ?? 0;
    const regularPlaceholders = query.replace(/\?\?/g, '').match(/\?/g)?.length ?? 0;
    const arr = [];

    for (let i = 0; i < regularPlaceholders; i++) {
      arr[i] = parameters[i + 1] ?? null;
    }

    parameters = arr;
  }

  return [processedQuery, parameters];
}

function createExportFunction(mode) {
  return function (query, parameters, cb, invokingResource = GetInvokingResource()) {
    const resource = getResourceName(invokingResource);
    const callback = setCallback(parameters, cb);

    try {
      const [parsedQuery, parsedParams] = parseArguments(query, parameters);

      return new Promise((resolve, reject) => {
        executeQuery(parsedQuery, parsedParams, resource, mode)
          .then(result => {
            if (callback) callback(result, null);
            resolve(result);
          })
          .catch(err => {
            console.log(`^1[mariaDB] Error in ${resource}: ${err.message}^0`);
            if (callback) callback(null, err.message);
            resolve(null);
          });
      });
    } catch (err) {
      console.log(`^1[mariaDB] Error in ${resource}: ${err.message}^0`);
      if (callback) callback(null, err.message);
      return Promise.resolve(null);
    }
  };
}

const MySQL = {
  isReady: () => pool ? true : false,
  awaitConnection: async function () {
    while (!pool) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }

    return true;
  },
  query: function (query, parameters, cb, invokingResource = GetInvokingResource()) {
    const resource = getResourceName(invokingResource);
    const callback = setCallback(parameters, cb);

    try {
      const [parsedQuery, parsedParams] = parseArguments(query, parameters);

      return new Promise((resolve, reject) => {
        executeQuery(parsedQuery, parsedParams, resource, null)
          .then(result => {
            if (callback) callback(result, null);
            resolve(result);
          })
          .catch(err => {
            console.log(`^1[mariaDB] Error in ${resource}: ${err.message}^0`);
            if (callback) callback(null, err.message);
            resolve(null);
          });
      });
    } catch (err) {
      console.log(`^1[mariaDB] Error in ${resource}: ${err.message}^0`);
      if (callback) callback(null, err.message);
      return Promise.resolve(null);
    }
  },
  single: createExportFunction('single'),
  scalar: createExportFunction('scalar'),
  update: createExportFunction('update'),
  insert: createExportFunction('insert'),
  transaction: function (queries, parameters, cb, invokingResource = GetInvokingResource()) {
    const resource = getResourceName(invokingResource);
    const callback = setCallback(parameters, cb);

    if (!Array.isArray(queries)) {
      const error = new Error('Transaction queries must be an array');
      console.log(`^1[mariaDB] Error in ${resource}: ${error.message}^0`);
      if (callback) callback(null, error.message);
      return Promise.resolve(null);
    }

    return new Promise((resolve, reject) => {
      executeTransaction(queries, parameters, resource)
        .then(result => {
          if (callback) callback(result, null);
          resolve(result);
        })
        .catch(err => {
          console.log(`^1[mariaDB] Error in ${resource}: ${err.message}^0`);
          if (callback) callback(null, err.message);
          resolve(null);
        });
    });
  },
  startTransaction: async function (cb, invokingResource = GetInvokingResource()) {
    const resource = getResourceName(invokingResource);

    while (!pool) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }

    if (typeof cb !== 'function') {
      throw new Error('startTransaction expected a callback function');
    }

    let conn = null;
    let closed = false;

    try {
      conn = await pool.getConnection();
      await conn.beginTransaction();

      const query = async function (sql, parameters) {
        if (closed) throw new Error('Transaction already closed');

        const [parsedQuery, parsedParams] = parseArguments(sql, parameters);
        const startTime = Date.now();
        const result = await conn.query(parsedQuery, parsedParams);

        logQuery(parsedQuery, parsedParams, Date.now() - startTime, resource, null);

        return parseResult(result, null);
      };

      const commit = await cb(query);

      if (commit === false) {
        await conn.rollback();
        closed = true;
        return false;
      }

      await conn.commit();
      closed = true;
      return true;
    } catch (err) {
      if (conn && !closed) {
        await conn.rollback().catch(() => { });
      }

      console.log(`^1[mariaDB] Error in ${resource}: ${err.message}^0`);
      return false;
    } finally {
      if (conn) conn.release();
    }
  },
  prepare: function (query, parameters, cb, invokingResource = GetInvokingResource()) {
    const resource = getResourceName(invokingResource);
    const callback = setCallback(parameters, cb);

    try {
      const [parsedQuery, parsedParams] = parseArguments(query, parameters);

      return new Promise((resolve, reject) => {
        executeRaw(parsedQuery, parsedParams, resource, true)
          .then(result => {
            if (callback) callback(result, null);
            resolve(result);
          })
          .catch(err => {
            console.log(`^1[mariaDB] Error in ${resource}: ${err.message}^0`);
            if (callback) callback(null, err.message);
            resolve(null);
          });
      });
    } catch (err) {
      console.log(`^1[mariaDB] Error in ${resource}: ${err.message}^0`);
      if (callback) callback(null, err.message);
      return Promise.resolve(null);
    }
  },
  rawExecute: function (query, parameters, cb, invokingResource = GetInvokingResource()) {
    const resource = getResourceName(invokingResource);
    const callback = setCallback(parameters, cb);

    try {
      const [parsedQuery, parsedParams] = parseArguments(query, parameters);

      return new Promise((resolve, reject) => {
        executeRaw(parsedQuery, parsedParams, resource, false)
          .then(result => {
            if (callback) callback(result, null);
            resolve(result);
          })
          .catch(err => {
            console.log(`^1[mariaDB] Error in ${resource}: ${err.message}^0`);
            if (callback) callback(null, err.message);
            resolve(null);
          });
      });
    } catch (err) {
      console.log(`^1[mariaDB] Error in ${resource}: ${err.message}^0`);
      if (callback) callback(null, err.message);
      return Promise.resolve(null);
    }
  },
  store: function (query, cb) {
    if (typeof query !== 'string') throw new Error('Query must be a string');

    const storeN = stats.queries.length + 1;

    if (cb) cb(storeN);
    return storeN;
  },
  execute: function (query, parameters, cb, invokingResource = GetInvokingResource()) {
    const resource = getResourceName(invokingResource);
    const callback = setCallback(parameters, cb);

    try {
      const [parsedQuery, parsedParams] = parseArguments(query, parameters);

      return new Promise((resolve, reject) => {
        executeQuery(parsedQuery, parsedParams, resource, null)
          .then(result => {
            if (callback) callback(result, null);
            resolve(result);
          })
          .catch(err => {
            console.log(`^1[mariaDB] Error in ${resource}: ${err.message}^0`);
            if (callback) callback(null, err.message);
            resolve(null);
          });
      });
    } catch (err) {
      console.log(`^1[mariaDB] Error in ${resource}: ${err.message}^0`);
      if (callback) callback(null, err.message);
      return Promise.resolve(null);
    }
  },
  fetch: function (query, parameters, cb, invokingResource = GetInvokingResource()) {
    const resource = getResourceName(invokingResource);
    const callback = setCallback(parameters, cb);

    try {
      const [parsedQuery, parsedParams] = parseArguments(query, parameters);

      return new Promise((resolve, reject) => {
        executeQuery(parsedQuery, parsedParams, resource, null)
          .then(result => {
            if (callback) callback(result, null);
            resolve(result);
          })
          .catch(err => {
            console.log(`^1[mariaDB] Error in ${resource}: ${err.message}^0`);
            if (callback) callback(null, err.message);
            resolve(null);
          });
      });
    } catch (err) {
      console.log(`^1[mariaDB] Error in ${resource}: ${err.message}^0`);
      if (callback) callback(null, err.message);
      return Promise.resolve(null);
    }
  },
  getStats: () => stats,
  clearStats: function () {
    stats = {
      totalQueries: 0,
      failedQueries: 0,
      slowQueries: 0,
      avgExecutionTime: 0,
      queries: [],
      connections: {
        active: 0,
        idle: 0,
        total: 0
      }
    };

    return true;
  },
  escape: function (value) {
    if (!pool) return null;
    return pool.escape(value);
  },
  formatDate: formatDate,
};

const exports = global.exports;
for (const key in MySQL) {
  const exp = MySQL[key];
  const async_exp = function (query, parameters, invokingResource = GetInvokingResource()) {
    return exp(query, parameters, null, invokingResource);
  };
  try {
    exports(key, exp);
    exports(`${key}_async`, async_exp);
    exports(`${key}Sync`, async_exp);
  } catch (e) {
    console.log(`^1[mariaDB] Failed to export ${key}: ${e.message}^0`);
  }
}

on('onResourceStop', function (resName) {
  if (resName === GetCurrentResourceName() && pool) {
    pool.end();
    pool = null;
    console.log('^2[mariaDB] Pool closed^0');
  }
});

setTimeout(async function () {
  while (!pool) {
    await createConnectionPool();
    if (!pool) {
      await new Promise(resolve => setTimeout(resolve, 30000));
    }
  }
});