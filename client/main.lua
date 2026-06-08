local isOpen = false

RegisterCommand('dbmanager', function()
    if isOpen then
        closeUI()
    else
        openUI()
    end
end, false)

RegisterCommand('mysql', function()
    if isOpen then
        closeUI()
    else
        openUI()
    end
end, false)

function openUI()
    isOpen = true
    SetNuiFocus(true, true)
    SendNUIMessage(json.encode({ action = 'open' }))
end

function closeUI()
    isOpen = false
    SetNuiFocus(false, false)
    SendNUIMessage(json.encode({ action = 'close' }))
end

RegisterNUICallback('close', function(_, cb)
    closeUI()
    cb({ success = true })
end)

RegisterNUICallback('getStats', function(_, cb)
    TriggerServerEvent('mariadb:server:getStats')
    cb({ success = true })
end)

RegisterNUICallback('executeQuery', function(data, cb)
    TriggerServerEvent('mariadb:server:executeQuery', data.query)
    cb({ success = true })
end)

RegisterNUICallback('clearStats', function(_, cb)
    TriggerServerEvent('mariadb:server:clearStats')
    cb({ success = true })
end)

RegisterNetEvent('mariadb:client:stats', function(stats)
    SendNUIMessage(json.encode({ action = 'stats', data = stats }))
end)

RegisterNetEvent('mariadb:client:results', function(results, error)
    if error then
        SendNUIMessage(json.encode({ action = 'error', data = error }))
    else
        SendNUIMessage(json.encode({ action = 'results', data = results }))
    end
end)
