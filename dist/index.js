// src/index.js
var { Worker } = require("worker_threads");
var path = require("path");
var resourceName = GetCurrentResourceName();
var resourcePath = GetResourcePath(resourceName);
var workerPath = path.join(resourcePath, "dist/worker.js");
var isReady = false;
var nextRequestId = 1;
var pendingRequests = /* @__PURE__ */ new Map();
var pendingIpcMessages = [];
var worker = null;
var stats = {
  totalQueries: 0,
  failedQueries: 0,
  slowQueries: 0,
  avgExecutionTime: 0,
  queries: [],
  connections: { active: 0, idle: 0, total: 0 }
};
var mysql_slow_query_warning = 200;
var mysql_debug = false;
var mysql_ui = false;
var mysql_log_size = 100;
var mysql_connection_string = GetConvar("mysql_connection_string", "") || "mysql://root@localhost";
var mysql_transaction_isolation_level = getIsolationLevelStatement(GetConvarInt("mysql_transaction_isolation_level", 2));
function getIsolationLevelStatement(level) {
  const query = "SET TRANSACTION ISOLATION LEVEL";
  switch (level) {
    case 1:
      return `${query} REPEATABLE READ`;
    case 2:
      return `${query} READ COMMITTED`;
    case 3:
      return `${query} READ UNCOMMITTED`;
    case 4:
      return `${query} SERIALIZABLE`;
    default:
      return `${query} READ COMMITTED`;
  }
}
function parseUri(connectionString) {
  try {
    const url = new URL(connectionString);
    const options = {
      user: url.username || void 0,
      password: url.password || void 0,
      host: url.hostname || "localhost",
      port: url.port ? parseInt(url.port) : 3306,
      database: url.pathname ? url.pathname.slice(1) : void 0
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
      user: match[1] || void 0,
      password: match[2] || void 0,
      host: match[3] || "localhost",
      port: match[4] ? parseInt(match[4]) : 3306,
      database: match[5] || void 0
    };
    if (match[6]) {
      match[6].split("&").forEach((param) => {
        const [key, value] = param.split("=");
        if (key && value !== void 0) {
          options[key] = value;
        }
      });
    }
    return options;
  }
}
function getConnectionOptions(connectionString = mysql_connection_string) {
  let options = {};
  if (connectionString.includes("mysql://")) {
    options = parseUri(connectionString);
  } else {
    options = connectionString.replace(/(?:host(?:name)|ip|server|data\s?source|addr(?:ess)?)=/gi, "host=").replace(/(?:user\s?(?:id|name)?|uid)=/gi, "user=").replace(/(?:pwd|pass)=/gi, "password=").replace(/(?:db)=/gi, "database=").split(";").reduce((acc, param) => {
      const [key, value] = param.split("=");
      if (key) acc[key] = value;
      return acc;
    }, {});
  }
  let host = options.host || "127.0.0.1";
  if (host === "localhost") {
    host = "127.0.0.1";
  }
  for (const key of ["ssl"]) {
    if (typeof options[key] === "string") {
      try {
        options[key] = JSON.parse(options[key]);
      } catch {
      }
    }
  }
  const poolMax = parseInt(GetConvar("mysql_pool_max", "10"));
  const poolMin = parseInt(GetConvar("mysql_pool_min", "2"));
  return {
    host,
    port: options.port ? parseInt(options.port) : 3306,
    user: options.user || "root",
    password: options.password !== void 0 ? options.password : "",
    database: options.database || "",
    connectionLimit: poolMax,
    minimumIdle: Math.min(poolMax, poolMin),
    keepAliveDelay: 3e4,
    connectTimeout: 6e4,
    // 60 seconds timeout to prevent startup timeouts
    acquireTimeout: parseInt(GetConvar("mysql_acquire_timeout", "60000")),
    idleTimeout: parseInt(GetConvar("mysql_idle_timeout", "60000")),
    timezone: GetConvar("mysql_timezone", "local"),
    trace: GetConvarInt("mysql_debug", 0) === 1,
    multipleStatements: false,
    dateStrings: true,
    bigIntAsNumber: false,
    decimalAsNumber: true,
    insertIdAsNumber: true,
    autocommit: true,
    autoJsonMap: false,
    // Return JSON columns as raw strings for performance & compatibility
    jsonStrings: true,
    // Return JSON columns as raw strings natively
    ssl: options.ssl
  };
}
var connectionOptions = getConnectionOptions();
function formatDate(date) {
  if (!date) return null;
  if (typeof date === "string") return date;
  const d = new Date(date);
  return d.toISOString().slice(0, 19).replace("T", " ");
}
function safeStringifyParams(params) {
  if (!params) return null;
  if (typeof params === "string") return params.substring(0, 100);
  try {
    if (Array.isArray(params)) {
      if (params.length === 0) return "[]";
      const parts2 = [];
      let currentLen2 = 2;
      for (const item of params) {
        const itemStr = typeof item === "object" && item !== null ? "{...}" : String(item);
        if (currentLen2 + itemStr.length + 2 > 100) {
          parts2.push("...");
          break;
        }
        parts2.push(itemStr);
        currentLen2 += itemStr.length + 2;
      }
      return "[" + parts2.join(", ") + "]";
    }
    const keys = Object.keys(params);
    if (keys.length === 0) return "{}";
    const parts = [];
    let currentLen = 2;
    for (const key of keys) {
      const val = params[key];
      const valStr = typeof val === "object" && val !== null ? "{...}" : String(val);
      const entryStr = `${key}:${valStr}`;
      if (currentLen + entryStr.length + 2 > 100) {
        parts.push("...");
        break;
      }
      parts.push(entryStr);
      currentLen += entryStr.length + 2;
    }
    return "{" + parts.join(", ") + "}";
  } catch {
    return "[Error]";
  }
}
function logToConsole(message, type = "info") {
  let color = "^5";
  if (type === "error") color = "^1";
  else if (type === "warn") color = "^3";
  else if (type === "success") color = "^2";
  console.log(`${color}[mariaDB] ${message}^0`);
}
function sendToWorker(action, payload = {}, callback = null) {
  return new Promise((resolve, reject) => {
    const id = nextRequestId++;
    let requestQuery = payload.query;
    let requestParams = payload.parameters;
    if (action === "transaction") {
      requestQuery = `TRANSACTION (${payload.queries ? payload.queries.length : 0} queries)`;
      requestParams = null;
    } else if (action === "beginTransaction") {
      requestQuery = "BEGIN TRANSACTION";
      requestParams = null;
    } else if (action === "transactionQuery") {
      requestQuery = payload.sql || "";
      requestParams = payload.values || null;
    } else if (!requestQuery) {
      requestQuery = "";
      requestParams = null;
    }
    const requestObj = { resolve, reject, callback, action };
    if (mysql_ui || mysql_debug || mysql_slow_query_warning > 0) {
      requestObj.startTime = Date.now();
      requestObj.query = requestQuery;
      requestObj.parameters = requestParams;
      requestObj.invokingResource = payload.invokingResource;
    }
    pendingRequests.set(id, requestObj);
    const msg = { action, id, ...payload };
    if (worker) {
      worker.postMessage(msg);
    } else {
      pendingIpcMessages.push(msg);
    }
  });
}
function emitToWorker(action, data = {}) {
  const msg = { action, ...data };
  if (worker) {
    worker.postMessage(msg);
  } else {
    pendingIpcMessages.push(msg);
  }
}
function handleWorkerMessage(msg) {
  const { action, id, success, result, error, data } = msg;
  if (action === "response" && id !== void 0) {
    const request = pendingRequests.get(id);
    if (request) {
      pendingRequests.delete(id);
      const hasStartTime = request.startTime !== void 0;
      const executionTime = hasStartTime ? Date.now() - request.startTime : 0;
      const isSlow = hasStartTime && mysql_slow_query_warning > 0 && executionTime > mysql_slow_query_warning;
      stats.totalQueries++;
      if (!success) stats.failedQueries++;
      if (isSlow) stats.slowQueries++;
      if (hasStartTime) {
        stats.avgExecutionTime = stats.avgExecutionTime + Math.round((executionTime - stats.avgExecutionTime) / stats.totalQueries);
      }
      if (mysql_ui && hasStartTime) {
        const entry = {
          query: request.query.length > 200 ? request.query.substring(0, 200) : request.query,
          parameters: safeStringifyParams(request.parameters),
          executionTime,
          resource: request.invokingResource || "unknown",
          timestamp: Date.now(),
          error: !success ? "Query execution failed" : null,
          isSlow
        };
        stats.queries.unshift(entry);
        if (stats.queries.length > mysql_log_size) {
          stats.queries.pop();
        }
      }
      if (isSlow) {
        logToConsole(`Slow query (${executionTime}ms) from ${request.invokingResource}: ${request.query.substring(0, 100)}`, "warn");
      }
      if (!success) {
        let errorMsg = `Query error from ${request.invokingResource || "unknown"}: ${error}`;
        if (mysql_debug && request.query) {
          errorMsg += `
Query details: ${request.query} params: ${safeStringifyParams(request.parameters)}`;
        }
        if (mysql_debug || !request.callback) {
          logToConsole(errorMsg, "error");
        }
      } else if (mysql_debug && hasStartTime) {
        logToConsole(`[${request.invokingResource}] (${executionTime}ms): ${request.query}`, "info");
      }
      if (request.callback) {
        if (success) {
          request.callback(result, null);
        } else {
          if (request.action === "transaction") {
            request.callback(false, null);
          } else {
            request.callback(null, error);
          }
        }
      }
      if (success) {
        request.resolve(result);
      } else {
        if (request.action === "transaction") {
          request.resolve(false);
        } else {
          request.reject(new Error(error));
        }
      }
    }
    return;
  }
  switch (action) {
    case "isReady":
      isReady = data;
      break;
    case "connections":
      stats.connections = msg.connections;
      break;
    case "log":
      console.log(msg.message);
      break;
  }
}
function launchWorker() {
  worker = new Worker(workerPath);
  worker.on("message", (msg) => {
    handleWorkerMessage(msg);
  });
  worker.on("error", (err) => {
    console.error(`oxmysql worker thread error: ${err.message}`);
  });
  worker.on("exit", (code) => {
    if (code !== 0) {
      console.error(`oxmysql worker thread exited with code ${code}`);
    }
  });
  worker.postMessage({
    action: "initialize",
    connectionOptions,
    mysql_transaction_isolation_level
  });
  syncConfig();
  while (pendingIpcMessages.length > 0) {
    const msg = pendingIpcMessages.shift();
    worker.postMessage(msg);
  }
}
function syncConfig() {
  mysql_ui = GetConvar("mysql_ui", "false") === "true";
  mysql_slow_query_warning = GetConvarInt("mysql_slow_query_warning", 200);
  try {
    const debug = GetConvar("mysql_debug", "false");
    mysql_debug = debug === "false" ? false : JSON.parse(debug);
  } catch {
    mysql_debug = true;
  }
  mysql_log_size = mysql_debug ? 1e4 : GetConvarInt("mysql_log_size", 100);
  emitToWorker("updateConfig", {
    mysql_debug,
    mysql_slow_query_warning,
    mysql_ui,
    mysql_log_size
  });
}
launchWorker();
setInterval(syncConfig, 5e3);
function getParamsAndCallback(parameters, cb) {
  if (cb && typeof cb === "function") return [parameters, cb];
  if (parameters && typeof parameters === "function") return [null, parameters];
  return [parameters, null];
}
function getResourceName(invokingResource) {
  return typeof invokingResource === "string" && invokingResource.length > 0 ? invokingResource : GetInvokingResource() || "unknown";
}
function createExportFunction(mode) {
  return function(query, parameters, cb, invokingResource) {
    const resource = getResourceName(invokingResource);
    const [params, callback] = getParamsAndCallback(parameters, cb);
    const p = sendToWorker("query", { type: mode, invokingResource: resource, query, parameters: params }, callback);
    return p;
  };
}
var MySQL = {
  isReady: () => isReady,
  awaitConnection: async function() {
    while (!isReady) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return true;
  },
  query: function(query, parameters, cb, invokingResource) {
    const resource = getResourceName(invokingResource);
    const [params, callback] = getParamsAndCallback(parameters, cb);
    const p = sendToWorker("query", { type: null, invokingResource: resource, query, parameters: params }, callback);
    return p;
  },
  single: createExportFunction("single"),
  scalar: createExportFunction("scalar"),
  update: createExportFunction("update"),
  insert: createExportFunction("insert"),
  transaction: function(queries, parameters, cb, invokingResource) {
    const resource = getResourceName(invokingResource);
    const [params, callback] = getParamsAndCallback(parameters, cb);
    if (!Array.isArray(queries)) {
      const error = new Error("Transaction queries must be an array");
      console.log(`^1[mariaDB] Error in ${resource}: ${error.message}^0`);
      if (callback) callback(null, error.message);
      return Promise.resolve(null);
    }
    const p = sendToWorker("transaction", { invokingResource: resource, queries, parameters: params }, callback);
    return p.catch(() => false);
  },
  startTransaction: async function(cb, invokingResource) {
    const resource = getResourceName(invokingResource);
    while (!isReady) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (typeof cb !== "function") {
      throw new Error("startTransaction expected a callback function");
    }
    let connectionId;
    try {
      const beginResult = await sendToWorker("beginTransaction", { invokingResource: resource });
      connectionId = beginResult.connectionId;
      let closed = false;
      const query = async function(sql, parameters) {
        if (closed) throw new Error("Transaction already closed");
        const result = await sendToWorker("transactionQuery", {
          invokingResource: resource,
          connectionId,
          sql,
          values: parameters
        });
        return result;
      };
      const commit = await cb(query);
      closed = true;
      emitToWorker("endTransaction", { connectionId, commit: commit !== false });
      return commit !== false;
    } catch (err) {
      console.log(`^1[mariaDB] Error in ${resource}: ${err.message}^0`);
      if (connectionId !== void 0) {
        emitToWorker("endTransaction", { connectionId, commit: false });
      }
      return false;
    }
  },
  prepare: function(query, parameters, cb, invokingResource) {
    const resource = getResourceName(invokingResource);
    const [params, callback] = getParamsAndCallback(parameters, cb);
    const p = sendToWorker("execute", { invokingResource: resource, query, parameters: params, prepare: true, unpack: true }, callback);
    return p;
  },
  rawExecute: function(query, parameters, cb, invokingResource) {
    const resource = getResourceName(invokingResource);
    const [params, callback] = getParamsAndCallback(parameters, cb);
    const p = sendToWorker("execute", { invokingResource: resource, query, parameters: params, prepare: false }, callback);
    return p;
  },
  store: function(query, cb) {
    if (typeof query !== "string") throw new Error("Query must be a string");
    const storeN = stats.queries.length + 1;
    if (cb) cb(storeN);
    return storeN;
  },
  execute: function(query, parameters, cb, invokingResource) {
    return this.query(query, parameters, cb, invokingResource);
  },
  fetch: function(query, parameters, cb, invokingResource) {
    return this.query(query, parameters, cb, invokingResource);
  },
  getStats: () => {
    return {
      ...stats,
      config: {
        host: connectionOptions.host,
        database: connectionOptions.database,
        poolSize: connectionOptions.connectionLimit
      },
      isReady
    };
  },
  clearStats: function() {
    emitToWorker("clearStats");
    return true;
  },
  escape: function(value) {
    if (value === void 0 || value === null) return "NULL";
    switch (typeof value) {
      case "boolean":
        return value ? "true" : "false";
      case "number":
        return value.toString();
      case "string":
        return "'" + value.replace(/(['\\])/g, "\\$1") + "'";
      default:
        return "'" + JSON.stringify(value).replace(/(['\\])/g, "\\$1") + "'";
    }
  },
  formatDate
};
var exportsObj = global.exports;
for (const key in MySQL) {
  const exp = MySQL[key];
  const async_exp = function(query, parameters, invokingResource = GetInvokingResource()) {
    return new Promise((resolve, reject) => {
      exp(
        query,
        parameters,
        (result, err) => {
          if (err) return reject(new Error(err));
          resolve(result);
        },
        invokingResource
      );
    });
  };
  try {
    exportsObj(key, exp);
    exportsObj(`${key}_async`, async_exp);
    exportsObj(`${key}Sync`, async_exp);
  } catch (e) {
    console.log(`^1[mariaDB] Failed to export ${key}: ${e.message}^0`);
  }
}
on("onResourceStop", function(resName) {
  if (resName === GetCurrentResourceName()) {
    emitToWorker("close");
    if (typeof ipcServer !== "undefined") ipcServer.close();
    if (worker) {
      worker.terminate();
    }
    console.log("^2[mariaDB] Pool closed and worker terminated^0");
  }
});
