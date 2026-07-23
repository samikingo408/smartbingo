require('dotenv').config();

const useSqlite = process.env.USE_SQLITE === 'true' || !process.env.DATABASE_URL;

let query;
let dbReady;

if (useSqlite) {
    const sqlite3 = require('sqlite3').verbose();
    const dbPath = process.env.SQLITE_PATH || './dev.sqlite';
    const sqliteClient = new sqlite3.Database(dbPath);
    console.log(`[Database] SQLite initialized at ${dbPath}`);

    // Query translation function for SQLite
    const translateQuery = (sql) => {
        if (!sql) return sql;
        let newSql = sql;
        
        // Replace $1, $2, etc. with ?1, ?2, etc.
        newSql = newSql.replace(/\$(\d+)/g, '?$1');
        
        // Replace permissions::jsonb ->> 'x' with json_extract(permissions, '$.x')
        newSql = newSql.replace(/(\w+)(?:::jsonb)?\s*->>\s*'(\w+)'/g, "json_extract($1, '$.$2')");
        
        // Replace w->>'id' with json_extract(w.value, '$.id') or similar
        newSql = newSql.replace(/(\w+)\s*->>\s*'(\w+)'/g, (match, table, key) => {
            if (table === 'w') {
                return `json_extract(w.value, '$.${key}')`;
            }
            return `json_extract(${table}, '$.${key}')`;
        });
        
        // Replace jsonb_array_elements(winners) AS w with json_each(winners) AS w
        newSql = newSql.replace(/jsonb_array_elements\(([^)]+)\)\s+AS\s+(\w+)/gi, "json_each($1) AS $2");
        
        // Replace ::decimal, ::text, etc.
        newSql = newSql.replace(/::decimal/gi, "");
        newSql = newSql.replace(/::text/gi, "");
        newSql = newSql.replace(/::int(eger)?/gi, "");
        
        // Replace SERIAL PRIMARY KEY with INTEGER PRIMARY KEY AUTOINCREMENT
        newSql = newSql.replace(/\bSERIAL\s+PRIMARY\s+KEY\b/gi, "INTEGER PRIMARY KEY AUTOINCREMENT");
        
        // Replace ILIKE with LIKE (which is case-insensitive by default in SQLite for ASCII)
        newSql = newSql.replace(/\bILIKE\b/gi, "LIKE");
        
        // Timezone/Date replacements from Postgres to SQLite
        newSql = newSql.replace(/\(NOW\(\)\s+AT\s+TIME\s+ZONE\s+'Africa\/Addis_Ababa'\)::date\s*-\s*INTERVAL\s*'1 day'/gi, "date('now', '+3 hours', '-1 day')");
        newSql = newSql.replace(/\(NOW\(\)\s+AT\s+TIME\s+ZONE\s+'Africa\/Addis_Ababa'\)::date\s*-\s*INTERVAL\s*'6 days'/gi, "date('now', '+3 hours', '-6 days')");
        newSql = newSql.replace(/\(NOW\(\)\s+AT\s+TIME\s+ZONE\s+'Africa\/Addis_Ababa'\)::date/gi, "date('now', '+3 hours')");
        
        newSql = newSql.replace(/DATE_TRUNC\('month',\s*NOW\(\)\s+AT\s+TIME\s+ZONE\s+'Africa\/Addis_Ababa'\)/gi, "date('now', '+3 hours', 'start of month')");
        newSql = newSql.replace(/DATE_TRUNC\('year',\s*NOW\(\)\s+AT\s+TIME\s+ZONE\s+'Africa\/Addis_Ababa'\)/gi, "date('now', '+3 hours', 'start of year')");
        
        newSql = newSql.replace(/NOW\(\)\s+AT\s+TIME\s+ZONE\s+'Africa\/Addis_Ababa'\s*-\s*INTERVAL\s*'3 months'/gi, "datetime('now', '+3 hours', '-3 months')");
        newSql = newSql.replace(/NOW\(\)\s+AT\s+TIME\s+ZONE\s+'Africa\/Addis_Ababa'\s*-\s*INTERVAL\s*'6 months'/gi, "datetime('now', '+3 hours', '-6 months')");
        newSql = newSql.replace(/created_at\s+AT\s+TIME\s+ZONE\s+'Africa\/Addis_Ababa'/gi, "datetime(created_at, '+3 hours')");
        newSql = newSql.replace(/\bNOW\(\)/gi, "CURRENT_TIMESTAMP");
        
        return newSql;
    };

    query = (text, params = []) => {
        return new Promise((resolve, reject) => {
            const translatedSql = translateQuery(text);
            const isSelect = /^\s*SELECT\b/i.test(translatedSql);
            
            if (isSelect) {
                sqliteClient.all(translatedSql, params, (err, rows) => {
                    if (err) {
                        console.error('[SQLite SELECT Error]', err.message, '\nSQL:', translatedSql, '\nParams:', params);
                        return reject(err);
                    }
                    const mappedRows = (rows || []).map(row => {
                        const mapped = { ...row };
                        for (const key in mapped) {
                            if (
                                key.startsWith('is_') ||
                                key.startsWith('received_') ||
                                key.startsWith('inviter_') ||
                                ['maintenance_mode', 'kill_deposits', 'kill_withdrawals', 'kill_games', 'notif_wd', 'notif_ag'].includes(key)
                            ) {
                                if (mapped[key] === 1 || mapped[key] === 'true') mapped[key] = true;
                                if (mapped[key] === 0 || mapped[key] === 'false') mapped[key] = false;
                            }
                        }
                        return mapped;
                    });
                    resolve({
                        rows: mappedRows,
                        rowCount: mappedRows.length
                    });
                });
            } else {
                sqliteClient.run(translatedSql, params, function(err) {
                    if (err) {
                        if (
                            err.message.includes('already exists') ||
                            err.message.includes('duplicate column')
                        ) {
                            return resolve({ rows: [], rowCount: 0 });
                        }
                        console.error('[SQLite RUN Error]', err.message, '\nSQL:', translatedSql, '\nParams:', params);
                        return reject(err);
                    }
                    resolve({
                        rows: [],
                        rowCount: this.changes,
                        insertId: this.lastID
                    });
                });
            }
        });
    };

    async function initDB() {
        try {
            // Users
            await query(`
                CREATE TABLE IF NOT EXISTS users (
                    chat_id BIGINT PRIMARY KEY,
                    phone_number VARCHAR(20),
                    first_name VARCHAR(100),
                    last_name VARCHAR(100),
                    username VARCHAR(100),
                    balance DECIMAL(10, 2) DEFAULT 0.00,
                    is_blocked BOOLEAN DEFAULT FALSE,
                    games_played INTEGER DEFAULT 0,
                    games_won INTEGER DEFAULT 0,
                    referred_by BIGINT,
                    locked_balance DECIMAL(10, 2) DEFAULT 0.00,
                    bonus_balance DECIMAL(10, 2) DEFAULT 0.00,
                    received_welcome_bonus BOOLEAN DEFAULT FALSE,
                    inviter_bonus_paid BOOLEAN DEFAULT FALSE,
                    is_frozen BOOLEAN DEFAULT FALSE,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                );
            `);
            try { await query(`ALTER TABLE users ADD COLUMN is_blocked BOOLEAN DEFAULT FALSE;`); } catch(e){}
            try { await query(`ALTER TABLE users ADD COLUMN games_played INTEGER DEFAULT 0;`); } catch(e){}
            try { await query(`ALTER TABLE users ADD COLUMN games_won INTEGER DEFAULT 0;`); } catch(e){}
            try { await query(`ALTER TABLE users ADD COLUMN referred_by BIGINT;`); } catch(e){}
            try { await query(`ALTER TABLE users ADD COLUMN locked_balance DECIMAL(10, 2) DEFAULT 0.00;`); } catch(e){}
            try { await query(`ALTER TABLE users ADD COLUMN bonus_balance DECIMAL(10, 2) DEFAULT 0.00;`); } catch(e){}
            try { await query(`ALTER TABLE users ADD COLUMN received_welcome_bonus BOOLEAN DEFAULT FALSE;`); } catch(e){}
            try { await query(`ALTER TABLE users ADD COLUMN inviter_bonus_paid BOOLEAN DEFAULT FALSE;`); } catch(e){}
            try { await query(`ALTER TABLE users ADD COLUMN is_frozen BOOLEAN DEFAULT FALSE;`); } catch(e){}
            try { await query(`ALTER TABLE users ADD COLUMN created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;`); } catch(e){}

            // Deposits
            await query(`
                CREATE TABLE IF NOT EXISTS deposits (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    chat_id BIGINT REFERENCES users(chat_id),
                    tx_id VARCHAR(100) UNIQUE,
                    amount DECIMAL(10,2),
                    method VARCHAR(50),
                    admin_id BIGINT,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                );
            `);
            try { await query(`ALTER TABLE deposits ADD COLUMN admin_id BIGINT;`); } catch(e){}

            // Withdrawals
            await query(`
                CREATE TABLE IF NOT EXISTS withdrawals (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    chat_id BIGINT REFERENCES users(chat_id),
                    amount DECIMAL(10,2),
                    method VARCHAR(50),
                    account_name VARCHAR(255),
                    account_details VARCHAR(255),
                    status VARCHAR(20) DEFAULT 'pending',
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                );
            `);
            try { await query(`ALTER TABLE withdrawals ADD COLUMN account_name VARCHAR(255);`); } catch(e){}

            // Agents
            await query(`
                CREATE TABLE IF NOT EXISTS agents (
                    chat_id BIGINT PRIMARY KEY,
                    first_name VARCHAR(100),
                    username VARCHAR(100),
                    balance DECIMAL(10,2) DEFAULT 0.00,
                    is_approved BOOLEAN DEFAULT FALSE,
                    referral_code VARCHAR(50) UNIQUE,
                    is_blocked BOOLEAN DEFAULT FALSE,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                );
            `);
            try { await query(`ALTER TABLE agents ADD COLUMN referral_code VARCHAR(50);`); } catch(e){}
            try { await query(`ALTER TABLE agents ADD COLUMN is_blocked BOOLEAN DEFAULT FALSE;`); } catch(e){}

            // Pending agents
            await query(`
                CREATE TABLE IF NOT EXISTS pending_agents (
                    chat_id BIGINT PRIMARY KEY,
                    first_name VARCHAR(100),
                    last_name  VARCHAR(100),
                    username   VARCHAR(100),
                    phone      VARCHAR(20),
                    requested_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                );
            `);

            // Agent earnings
            await query(`
                CREATE TABLE IF NOT EXISTS agent_earnings (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    agent_id BIGINT REFERENCES agents(chat_id),
                    user_id BIGINT REFERENCES users(chat_id),
                    amount DECIMAL(10,2),
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                );
            `);

            // Agent withdrawals
            await query(`
                CREATE TABLE IF NOT EXISTS agent_withdrawals (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    agent_id BIGINT REFERENCES agents(chat_id),
                    amount DECIMAL(10,2),
                    method VARCHAR(50),
                    account_name VARCHAR(255),
                    account_details VARCHAR(255),
                    status VARCHAR(20) DEFAULT 'pending',
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                );
            `);
            try { await query(`ALTER TABLE agent_withdrawals ADD COLUMN account_name VARCHAR(255);`); } catch(e){}

            // Admins
            await query(`
                CREATE TABLE IF NOT EXISTS admins (
                    chat_id BIGINT PRIMARY KEY,
                    username VARCHAR(100),
                    added_by BIGINT,
                    role VARCHAR(20) DEFAULT 'ADMIN',
                    permissions TEXT DEFAULT '{}',
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                );
            `);
            try { await query(`ALTER TABLE admins ADD COLUMN permissions TEXT DEFAULT '{}';`); } catch(e){}
            try { await query(`ALTER TABLE admins ADD COLUMN role VARCHAR(20) DEFAULT 'ADMIN';`); } catch(e){}

            // Seed root admin
            if (process.env.SEED_ADMIN_ID) {
                await query(`
                    INSERT INTO admins (chat_id, username, added_by, role, permissions)
                    VALUES (?1, 'root_admin', ?2, 'SUPER_ADMIN', '{}')
                    ON CONFLICT (chat_id) DO UPDATE SET role = 'SUPER_ADMIN';
                `, [process.env.SEED_ADMIN_ID, process.env.SEED_ADMIN_ID]);
                console.log('[Database] Root admin seeded in SQLite:', process.env.SEED_ADMIN_ID);
            }

            // System settings
            await query(`
                CREATE TABLE IF NOT EXISTS system_settings (
                    key VARCHAR(50) PRIMARY KEY,
                    value VARCHAR(100) NOT NULL,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                );
            `);
            await query(`
                INSERT INTO system_settings (key, value) VALUES
                    ('stake', '10'),
                    ('system_fee', '2'),
                    ('agent_commission', '0.5'),
                    ('min_deposit', '50'),
                    ('max_deposit', '10000'),
                    ('min_withdrawal', '100'),
                    ('max_withdrawal', '5000'),
                    ('maintenance_mode', 'false'),
                    ('kill_deposits', 'false'),
                    ('kill_withdrawals', 'false'),
                    ('kill_games', 'false')
                ON CONFLICT (key) DO NOTHING;
            `);

            // Migrate old 20 ETB defaults to 10 ETB defaults
            await query(`UPDATE system_settings SET value = '10' WHERE key = 'stake' AND value = '20'`);
            await query(`UPDATE system_settings SET value = '2' WHERE key = 'system_fee' AND value = '4'`);
            await query(`UPDATE system_settings SET value = '0.5' WHERE key = 'agent_commission' AND value = '1'`);

            // Message templates
            await query(`
                CREATE TABLE IF NOT EXISTS message_templates (
                    key VARCHAR(50) PRIMARY KEY,
                    template TEXT NOT NULL,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                );
            `);
            await query(`
                INSERT INTO message_templates (key, template) VALUES
                    ('deposit_success', '✅ *Deposit Successful!*\n\n💰 Amount: *{amount} ETB*\n🆔 TX ID: \`{txId}\`\nNew Balance: *{balance} ETB*'),
                    ('withdraw_success', '💸 *Withdrawal Approved!*\n\n💰 Amount: *{amount} ETB*\nNew Balance: *{balance} ETB*'),
                    ('game_win', '🎉 *Congratulations! You Won!*\n\n💰 Prize: *{amount} ETB*\nNew Balance: *{balance} ETB*'),
                    ('welcome_bonus', '🎁 *Welcome Bonus!*\n\nYou received *{amount} ETB* as a welcome gift! 🦁')
                ON CONFLICT (key) DO NOTHING;
            `);

            // Admin log
            await query(`
                CREATE TABLE IF NOT EXISTS admin_log (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    admin_id BIGINT,
                    action VARCHAR(100),
                    target VARCHAR(100),
                    detail TEXT,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                );
            `);

            // Game history
            await query(`
                CREATE TABLE IF NOT EXISTS game_history (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    winners TEXT,
                    total_pot DECIMAL(10,2),
                    stake DECIMAL(10,2),
                    player_count INTEGER,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                );
            `);

            // Security / suspicious logs
            await query(`
                CREATE TABLE IF NOT EXISTS suspicious_logs (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    chat_id BIGINT,
                    type VARCHAR(50),
                    details TEXT,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                );
            `);

            // Used transactions
            await query(`
                CREATE TABLE IF NOT EXISTS used_transactions (
                    tx_id VARCHAR(100) PRIMARY KEY,
                    bank VARCHAR(50),
                    amount DECIMAL(10,2),
                    receiver_name VARCHAR(200),
                    receiver_account VARCHAR(100),
                    sender_name VARCHAR(200),
                    sender_account VARCHAR(100),
                    tx_date VARCHAR(100),
                    marked_by BIGINT,
                    marked_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                );
            `);

            console.log('[Database] ✅ All tables initialized (SQLite)');
        } catch (err) {
            console.error('[Database] ❌ Error initializing SQLite database:', err.message);
        }
    }

    dbReady = initDB();
} else {
    // ─── PostgreSQL Pool ───────────────────────────────────────────────────────────
    const dbUrl = (process.env.DATABASE_URL || '').replace(/[?&]sslmode=[^&]*/g, '');
    const { Pool } = require('pg');

    const pgClient = new Pool({
        connectionString: dbUrl,
        ssl: { rejectUnauthorized: false },
        idleTimeoutMillis: 240000,
        connectionTimeoutMillis: 10000,
        max: 5,
        keepAlive: true,
        keepAliveInitialDelayMillis: 10000,
    });

    pgClient.on('error', (err) => {
        console.error('[Database] Pool error on idle client:', err.message);
    });

    setInterval(() => {
        pgClient.query('SELECT 1').catch(e => console.warn('[Database] Heartbeat failed:', e.message));
    }, 4 * 60 * 1000);

    console.log('[Database] PostgreSQL pool initialized with keepalive heartbeat');

    query = (text, params = []) => {
        return new Promise((resolve, reject) => {
            const attempt = async (retries) => {
                try {
                    const res = await pgClient.query(text, params);
                    resolve({
                        rows: res.rows || [],
                        rowCount: res.rowCount,
                        insertId: res.rows[0]?.id
                    });
                } catch (err) {
                    if (
                        err.message.includes('already exists') ||
                        err.message.includes('duplicate column')
                    ) {
                        return resolve({ rows: [], rowCount: 0 });
                    }

                    const isTransient =
                        err.message.includes('Connection terminated') ||
                        err.message.includes('network socket disconnected') ||
                        err.message.includes('ECONNRESET') ||
                        err.message.includes('ETIMEDOUT') ||
                        err.message.includes('Connection timeout') ||
                        err.message.includes('secure TLS');

                    if (isTransient && retries > 0) {
                        console.warn(`[DB] Transient connection error — retrying in 800ms (${err.message})`);
                        await new Promise(r => setTimeout(r, 800));
                        return attempt(retries - 1);
                    }

                    console.error('[DB Error]', err.message, '\nSQL:', text, '\nParams:', params);
                    reject(err);
                }
            };
            attempt(2);
        });
    };

    async function initDB() {
        try {
            // Users
            await query(`
                CREATE TABLE IF NOT EXISTS users (
                    chat_id BIGINT PRIMARY KEY,
                    phone_number VARCHAR(20),
                    first_name VARCHAR(100),
                    last_name VARCHAR(100),
                    username VARCHAR(100),
                    balance DECIMAL(10, 2) DEFAULT 0.00,
                    is_blocked BOOLEAN DEFAULT FALSE
                );
            `);
            try { await query(`ALTER TABLE users ADD COLUMN is_blocked BOOLEAN DEFAULT FALSE;`); } catch(e){}
            try { await query(`ALTER TABLE users ADD COLUMN games_played INTEGER DEFAULT 0;`); } catch(e){}
            try { await query(`ALTER TABLE users ADD COLUMN games_won INTEGER DEFAULT 0;`); } catch(e){}
            try { await query(`ALTER TABLE users ADD COLUMN referred_by BIGINT;`); } catch(e){}
            try { await query(`ALTER TABLE users ADD COLUMN locked_balance DECIMAL(10, 2) DEFAULT 0.00;`); } catch(e){}
            try { await query(`ALTER TABLE users ADD COLUMN bonus_balance DECIMAL(10, 2) DEFAULT 0.00;`); } catch(e){}
            try { await query(`ALTER TABLE users ADD COLUMN received_welcome_bonus BOOLEAN DEFAULT FALSE;`); } catch(e){}
            try { await query(`ALTER TABLE users ADD COLUMN inviter_bonus_paid BOOLEAN DEFAULT FALSE;`); } catch(e){}
            try { await query(`ALTER TABLE users ADD COLUMN is_frozen BOOLEAN DEFAULT FALSE;`); } catch(e){}
            try { await query(`ALTER TABLE users ADD COLUMN created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;`); } catch(e){}
            console.log('[Database] users table ready');

            // Deposits
            await query(`
                CREATE TABLE IF NOT EXISTS deposits (
                    id SERIAL PRIMARY KEY,
                    chat_id BIGINT REFERENCES users(chat_id),
                    tx_id VARCHAR(100) UNIQUE,
                    amount DECIMAL(10,2),
                    method VARCHAR(50),
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                );
            `);
            try { await query(`ALTER TABLE deposits ADD COLUMN admin_id BIGINT;`); } catch(e){}
            console.log('[Database] deposits table ready');

            // Withdrawals
            await query(`
                CREATE TABLE IF NOT EXISTS withdrawals (
                    id SERIAL PRIMARY KEY,
                    chat_id BIGINT REFERENCES users(chat_id),
                    amount DECIMAL(10,2),
                    method VARCHAR(50),
                    account_name VARCHAR(255),
                    account_details VARCHAR(255),
                    status VARCHAR(20) DEFAULT 'pending',
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                );
            `);
            try { await query(`ALTER TABLE withdrawals ADD COLUMN account_name VARCHAR(255);`); } catch(e){}
            console.log('[Database] withdrawals table ready');

            // Agents
            await query(`
                CREATE TABLE IF NOT EXISTS agents (
                    chat_id BIGINT PRIMARY KEY,
                    first_name VARCHAR(100),
                    username VARCHAR(100),
                    balance DECIMAL(10,2) DEFAULT 0.00,
                    is_approved BOOLEAN DEFAULT FALSE,
                    referral_code VARCHAR(50) UNIQUE,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                );
            `);
            try { await query(`ALTER TABLE agents ADD COLUMN referral_code VARCHAR(50);`); } catch(e){}
            try { await query(`ALTER TABLE agents ADD COLUMN is_blocked BOOLEAN DEFAULT FALSE;`); } catch(e){}
            console.log('[Database] agents table ready');

            // Pending agents
            await query(`
                CREATE TABLE IF NOT EXISTS pending_agents (
                    chat_id BIGINT PRIMARY KEY,
                    first_name VARCHAR(100),
                    last_name  VARCHAR(100),
                    username   VARCHAR(100),
                    phone      VARCHAR(20),
                    requested_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                );
            `);

            // Agent earnings
            await query(`
                CREATE TABLE IF NOT EXISTS agent_earnings (
                    id SERIAL PRIMARY KEY,
                    agent_id BIGINT REFERENCES agents(chat_id),
                    user_id BIGINT REFERENCES users(chat_id),
                    amount DECIMAL(10,2),
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                );
            `);

            // Agent withdrawals
            await query(`
                CREATE TABLE IF NOT EXISTS agent_withdrawals (
                    id SERIAL PRIMARY KEY,
                    agent_id BIGINT REFERENCES agents(chat_id),
                    amount DECIMAL(10,2),
                    method VARCHAR(50),
                    account_name VARCHAR(255),
                    account_details VARCHAR(255),
                    status VARCHAR(20) DEFAULT 'pending',
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                );
            `);
            try { await query(`ALTER TABLE agent_withdrawals ADD COLUMN account_name VARCHAR(255);`); } catch(e){}
            console.log('[Database] agent tables ready');

            // Admins
            await query(`
                CREATE TABLE IF NOT EXISTS admins (
                    chat_id BIGINT PRIMARY KEY,
                    username VARCHAR(100),
                    added_by BIGINT,
                    role VARCHAR(20) DEFAULT 'ADMIN',
                    permissions TEXT DEFAULT '{}',
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                );
            `);
            try { await query(`ALTER TABLE admins ADD COLUMN permissions TEXT DEFAULT '{}';`); } catch(e){}
            try { await query(`ALTER TABLE admins ADD COLUMN role VARCHAR(20) DEFAULT 'ADMIN';`); } catch(e){}

            // Seed root admin
            if (process.env.SEED_ADMIN_ID) {
                await query(`
                    INSERT INTO admins (chat_id, username, added_by, role, permissions)
                    VALUES ($1, 'root_admin', $2, 'SUPER_ADMIN', '{}')
                    ON CONFLICT (chat_id) DO UPDATE SET role = 'SUPER_ADMIN';
                `, [process.env.SEED_ADMIN_ID, process.env.SEED_ADMIN_ID]);
                console.log('[Database] Root admin seeded:', process.env.SEED_ADMIN_ID);
            }
            console.log('[Database] admins table ready');

            // System settings
            await query(`
                CREATE TABLE IF NOT EXISTS system_settings (
                    key VARCHAR(50) PRIMARY KEY,
                    value VARCHAR(100) NOT NULL,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                );
            `);
            await query(`
                INSERT INTO system_settings (key, value) VALUES
                    ('stake', '10'),
                    ('system_fee', '2'),
                    ('agent_commission', '0.5'),
                    ('min_deposit', '50'),
                    ('max_deposit', '10000'),
                    ('min_withdrawal', '100'),
                    ('max_withdrawal', '5000'),
                    ('maintenance_mode', 'false'),
                    ('kill_deposits', 'false'),
                    ('kill_withdrawals', 'false'),
                    ('kill_games', 'false')
                ON CONFLICT (key) DO NOTHING;
            `);

            // Migrate old 20 ETB defaults to 10 ETB defaults
            await query(`UPDATE system_settings SET value = '10' WHERE key = 'stake' AND value = '20'`);
            await query(`UPDATE system_settings SET value = '2' WHERE key = 'system_fee' AND value = '4'`);
            await query(`UPDATE system_settings SET value = '0.5' WHERE key = 'agent_commission' AND value = '1'`);

            // Message templates
            await query(`
                CREATE TABLE IF NOT EXISTS message_templates (
                    key VARCHAR(50) PRIMARY KEY,
                    template TEXT NOT NULL,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                );
            `);
            await query(`
                INSERT INTO message_templates (key, template) VALUES
                    ('deposit_success', '✅ *Deposit Successful!*\n\n💰 Amount: *{amount} ETB*\n🆔 TX ID: \`{txId}\`\nNew Balance: *{balance} ETB*'),
                    ('withdraw_success', '💸 *Withdrawal Approved!*\n\n💰 Amount: *{amount} ETB*\nNew Balance: *{balance} ETB*'),
                    ('game_win', '🎉 *Congratulations! You Won!*\n\n💰 Prize: *{amount} ETB*\nNew Balance: *{balance} ETB*'),
                    ('welcome_bonus', '🎁 *Welcome Bonus!*\n\nYou received *{amount} ETB* as a welcome gift! 🦁')
                ON CONFLICT (key) DO NOTHING;
            `);

            // Admin log
            await query(`
                CREATE TABLE IF NOT EXISTS admin_log (
                    id SERIAL PRIMARY KEY,
                    admin_id BIGINT,
                    action VARCHAR(100),
                    target VARCHAR(100),
                    detail TEXT,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                );
            `);

            // Game history
            await query(`
                CREATE TABLE IF NOT EXISTS game_history (
                    id SERIAL PRIMARY KEY,
                    winners TEXT,
                    total_pot DECIMAL(10,2),
                    stake DECIMAL(10,2),
                    player_count INTEGER,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                );
            `);

            // Security / suspicious logs
            await query(`
                CREATE TABLE IF NOT EXISTS suspicious_logs (
                    id SERIAL PRIMARY KEY,
                    chat_id BIGINT,
                    type VARCHAR(50),
                    details TEXT,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                );
            `);

            // Used transactions (deposit de-dup)
            await query(`
                CREATE TABLE IF NOT EXISTS used_transactions (
                    tx_id VARCHAR(100) PRIMARY KEY,
                    bank VARCHAR(50),
                    amount DECIMAL(10,2),
                    receiver_name VARCHAR(200),
                    receiver_account VARCHAR(100),
                    sender_name VARCHAR(200),
                    sender_account VARCHAR(100),
                    tx_date VARCHAR(100),
                    marked_by BIGINT,
                    marked_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                );
            `);

            console.log('[Database] ✅ All tables initialized (PostgreSQL)');
        } catch (err) {
            console.error('[Database] ❌ Error initializing database:', err.message);
        }
    }

    dbReady = initDB();
}

module.exports = { query, dbReady };
