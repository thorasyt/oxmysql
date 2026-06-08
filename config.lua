Config = {}

local host = GetConvar('mysql_connection_host', '127.0.0.1')
local port = tonumber(GetConvar('mysql_connection_port', '3306'))
local user = GetConvar('mysql_connection_user', 'root')
local password = GetConvar('mysql_connection_password', '')
local database = GetConvar('mysql_connection_database', 'esx')

local connectionString = GetConvar('mysql_connection_string', '')
if connectionString ~= '' then
    -- Trim whitespace
    connectionString = connectionString:gsub("^%s*(.-)%s*$", "%1")
    -- Trim quotes
    connectionString = connectionString:gsub("^['\"]", ""):gsub("['\"]$", "")
    
    local cleaned = connectionString:gsub("^mysql://", "")
    local parts = {}
    for s in string.gmatch(cleaned, "[^/]+") do
        table.insert(parts, s)
    end
    if parts[1] and parts[2] then
        local creds_host = parts[1]
        local db_options = parts[2]
        
        local db = db_options:match("^([^?]+)")
        if db then database = db end
        
        local creds, host_port
        if creds_host:find("@") then
            creds, host_port = creds_host:match("^([^@]+)@(.+)$")
        else
            host_port = creds_host
        end
        
        if creds then
            if creds:find(":") then
                local u, p = creds:match("^([^:]+):(.*)$")
                if u then user = u end
                if p then password = p end
            else
                user = creds
                password = ''
            end
        end
        
        if host_port then
            if host_port:find(":") then
                local h, pt = host_port:match("^([^:]+):(%d+)$")
                if h then host = h end
                if pt then port = tonumber(pt) or 3306 end
            else
                host = host_port
            end
        end
        
        if host == 'localhost' then
            host = '127.0.0.1'
        end
    end
end


Config.Database = {
    host = host,
    port = port,
    user = user,
    password = password,
    database = database,
}

Config.Pool = {
    min = tonumber(GetConvar('mysql_pool_min', '2')),
    max = tonumber(GetConvar('mysql_pool_max', '10')),
    acquireTimeout = tonumber(GetConvar('mysql_acquire_timeout', '30000')),
    idleTimeout = tonumber(GetConvar('mysql_idle_timeout', '60000')),
}

Config.Performance = {
    queryCache = true,
    queryCacheSize = 100,
    logSlowQueries = true,
    slowQueryThreshold = 100,
    debug = GetConvarInt('mysql_debug', 0) == 1,
}

Config.Options = {
    returnCallbackErrors = false,
    dateFormat = '%Y-%m-%d %H:%M:%S',
    timezone = 'local',
}
