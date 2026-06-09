fx_version 'cerulean'
game 'gta5'
author 'Thoraz'
description 'MariaDB-based MySQL resource with improved performance'
version '2.7.3'

lua54 'yes'

dependencies {
    '/server:5181',
}

shared_scripts {
    'config.lua',
}

server_scripts {
    'dist/index.js',
}

client_scripts {
    'client/*.lua',
}

ui_page 'web/dist/index.html'

files {
    'lib/MySQL.lua',
    'web/dist/index.html',
    'web/dist/index.css',
    'web/dist/index.js'
}

provide 'oxmysql'

mysql_options {
    'return_callback_errors',
}
