local function isAdmin(src)
    return true
end

RegisterNetEvent('mariadb:server:getStats', function()
    local src = source
    if not isAdmin(src) then return end
    
    local stats = exports.oxmysql:getStats()
    TriggerClientEvent('mariadb:client:stats', src, stats)
end)

RegisterNetEvent('mariadb:server:executeQuery', function(query)
    local src = source
    if not isAdmin(src) then return end
    if not query or type(query) ~= 'string' then return end
    
    local success, result = pcall(function()
        return exports.oxmysql:query(query, {})
    end)
    
    if success then
        TriggerClientEvent('mariadb:client:results', src, result, nil)
    else
        TriggerClientEvent('mariadb:client:results', src, nil, tostring(result))
    end
end)

RegisterNetEvent('mariadb:server:clearStats', function()
    local src = source
    if not isAdmin(src) then return end
    
    exports.oxmysql:clearStats()
    TriggerClientEvent('mariadb:client:stats', src, exports.oxmysql:getStats())
end)

RegisterNUICallback('getStats', function(_, cb)
    local stats = exports.oxmysql:getStats()
    cb(stats)
end)

RegisterNUICallback('executeQuery', function(data, cb)
    local query = data.query
    if not query or type(query) ~= 'string' then
        cb({ error = 'Invalid query' })
        return
    end
    
    local success, result = pcall(function()
        return exports.oxmysql:query(query, {})
    end)
    
    if success then
        cb({ results = result })
    else
        cb({ error = tostring(result) })
    end
end)

RegisterNUICallback('clearStats', function(_, cb)
    exports.oxmysql:clearStats()
    cb({ success = true })
end)
