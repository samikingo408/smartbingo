const { Client } = require('pg');

const connectionString = 'postgres://avnadmin:AVNS_leS90-vmy_c0FraRkrP@pg-3ed4e00e-ademali4239-036a.j.aivencloud.com:16479/defaultdb';

const client = new Client({
    connectionString,
    ssl: { rejectUnauthorized: false }
});

async function createSchema() {
    try {
        await client.connect();
        console.log('Connected to PostgreSQL database');

        const queries = [
            `CREATE TABLE IF NOT EXISTS users (
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
                is_frozen BOOLEAN DEFAULT FALSE
            );`,
            
            `CREATE TABLE IF NOT EXISTS deposits (
                id SERIAL PRIMARY KEY,
                chat_id BIGINT REFERENCES users(chat_id),
                tx_id VARCHAR(100) UNIQUE,
                amount DECIMAL(10,2),
                method VARCHAR(50),
                admin_id BIGINT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );`,
            
            `CREATE TABLE IF NOT EXISTS withdrawals (
                id SERIAL PRIMARY KEY,
                chat_id BIGINT REFERENCES users(chat_id),
                amount DECIMAL(10,2),
                method VARCHAR(50),
                account_name VARCHAR(255),
                account_details VARCHAR(255),
                status VARCHAR(20) DEFAULT 'pending',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );`,
            
            `CREATE TABLE IF NOT EXISTS agents (
                chat_id BIGINT PRIMARY KEY,
                first_name VARCHAR(100),
                username VARCHAR(100),
                balance DECIMAL(10,2) DEFAULT 0.00,
                is_approved BOOLEAN DEFAULT FALSE,
                is_blocked BOOLEAN DEFAULT FALSE,
                referral_code VARCHAR(50) UNIQUE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );`,
            
            `CREATE TABLE IF NOT EXISTS pending_agents (
                chat_id BIGINT PRIMARY KEY,
                first_name VARCHAR(100),
                last_name VARCHAR(100),
                username VARCHAR(100),
                phone VARCHAR(20),
                requested_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );`,
            
            `CREATE TABLE IF NOT EXISTS agent_earnings (
                id SERIAL PRIMARY KEY,
                agent_id BIGINT REFERENCES agents(chat_id),
                user_id BIGINT REFERENCES users(chat_id),
                amount DECIMAL(10,2),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );`,
            
            `CREATE TABLE IF NOT EXISTS agent_withdrawals (
                id SERIAL PRIMARY KEY,
                agent_id BIGINT REFERENCES agents(chat_id),
                amount DECIMAL(10,2),
                method VARCHAR(50),
                account_name VARCHAR(255),
                account_details VARCHAR(255),
                status VARCHAR(20) DEFAULT 'pending',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );`,
            
            `CREATE TABLE IF NOT EXISTS admins (
                chat_id BIGINT PRIMARY KEY,
                username VARCHAR(100),
                added_by BIGINT,
                role VARCHAR(20) DEFAULT 'ADMIN',
                permissions JSONB DEFAULT '{}',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );`,
            
            `CREATE TABLE IF NOT EXISTS system_settings (
                key VARCHAR(50) PRIMARY KEY,
                value VARCHAR(100) NOT NULL,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );`,
            
            `INSERT INTO system_settings (key, value) VALUES
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
            ON CONFLICT (key) DO NOTHING;`,

            `UPDATE system_settings SET value = '10' WHERE key = 'stake' AND value = '20';`,
            `UPDATE system_settings SET value = '2' WHERE key = 'system_fee' AND value = '4';`,
            `UPDATE system_settings SET value = '0.5' WHERE key = 'agent_commission' AND value = '1';`,
            
            `CREATE TABLE IF NOT EXISTS message_templates (
                key VARCHAR(50) PRIMARY KEY,
                template TEXT NOT NULL,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );`,
            
            `INSERT INTO message_templates (key, template) VALUES
                ('deposit_success', '✅ *Deposit Successful!*\n\n💰 Amount: *{amount} ETB*\n🆔 TX ID: \`{txId}\`\nNew Balance: *{balance} ETB*'),
                ('withdraw_success', '💸 *Withdrawal Approved!*\n\n💰 Amount: *{amount} ETB*\nNew Balance: *{balance} ETB*'),
                ('game_win', '🎉 *Congratulations! You Won!*\n\n💰 Prize: *{amount} ETB*\nNew Balance: *{balance} ETB*'),
                ('welcome_bonus', '🎁 *Welcome Bonus!*\n\nYou received *{amount} ETB* as a welcome gift! 🦁')
            ON CONFLICT (key) DO NOTHING;`,
            
            `CREATE TABLE IF NOT EXISTS admin_log (
                id SERIAL PRIMARY KEY,
                admin_id BIGINT,
                action VARCHAR(100),
                target VARCHAR(100),
                detail TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );`,
            
            `CREATE TABLE IF NOT EXISTS game_history (
                id SERIAL PRIMARY KEY,
                winners TEXT,
                total_pot DECIMAL(10,2),
                stake DECIMAL(10,2),
                player_count INTEGER,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );`,
            
            `CREATE TABLE IF NOT EXISTS suspicious_logs (
                id SERIAL PRIMARY KEY,
                chat_id BIGINT,
                type VARCHAR(50),
                details TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );`,
            
            `CREATE TABLE IF NOT EXISTS used_transactions (
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
            );`
        ];

        for (const query of queries) {
            await client.query(query);
            console.log('Executed:', query.split('\\n')[0].trim(), '...');
        }
        
        console.log('✅ PostgreSQL Schema initialized successfully.');
    } catch (err) {
        console.error('❌ Error initializing database:', err);
    } finally {
        await client.end();
    }
}

createSchema();
