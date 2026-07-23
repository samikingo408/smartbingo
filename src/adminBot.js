/**
 * adminBot.js
 * Smart Bingo — Admin Bot (@Tellemamadimbot)
 *
 * Sections:
 *   👥  User Management
 *   🧑‍💼  Agent Management
 *   💰  Deposit Management
 *   💸  Withdrawal Management
 *   ⚙️  System Settings
 *   📢  Broadcast
 *   👑  Admin Management
 *   📊  Stats / Reports
 */

require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const db = require('./db');
const gameState = require('./gameState');
const { lookupTransaction } = require('./utils/scraper');

const ADMIN_BOT_TOKEN = process.env.ADMIN_BOT_TOKEN;
const AGENT_BOT_TOKEN = process.env.AGENT_BOT_TOKEN;
const BINGO_BOT_TOKEN = process.env.BOT_TOKEN;
const SEED_ADMIN_ID = process.env.SEED_ADMIN_ID;
const BINGO_BOT_USERNAME = process.env.BINGO_BOT_USERNAME || 'Smart_bingo_bot';
const ADMIN_BOT_USERNAME = process.env.ADMIN_BOT_USERNAME || 'Tellemamadimbot';
const AGENT_BOT_USERNAME = 'Smart_agent_bot'; // hardcoded
const WEBAPP_URL = process.env.WEBAPP_URL || 'https://your-frontend-url.com';
const FRONTEND_URL = process.env.FRONTEND_URL || process.env.WEBAPP_URL || 'https://your-frontend-url.com';
if (!ADMIN_BOT_TOKEN) {
    console.warn('[AdminBot] ADMIN_BOT_TOKEN not set — admin bot disabled');
    module.exports = null;
} else {
    const isLocal = process.env.USE_POLLING === 'true' || !WEBAPP_URL || WEBAPP_URL.includes('localhost') || !WEBAPP_URL.includes('http');
    // webHook:false — Express in server.js handles the webhook route; we do NOT want the bot library to open its own HTTPS server on port 8443
    const botOptions = { polling: isLocal, webHook: false };
    const bot = new TelegramBot(ADMIN_BOT_TOKEN, botOptions);

    // Other bot instances for notifications (no polling)
    const extraOpts = {};
    const agentBot = AGENT_BOT_TOKEN ? new TelegramBot(AGENT_BOT_TOKEN, extraOpts) : null;
    const bingoBot = BINGO_BOT_TOKEN ? new TelegramBot(BINGO_BOT_TOKEN, extraOpts) : null;

    console.log('[AdminBot] Instances initialized:', {
        admin: !!bot,
        agent: !!agentBot,
        bingo: !!bingoBot
    });

    bot.on('message', msg =>
        console.log(`[AdminBot] From ${msg.chat.id}: "${msg.text || '[not text]'}"`)
    );

    // ─── In-memory state { [chatId]: { step, action, targetId, ... } } ────────────
    const state = {};

    // ─── Auth helpers ─────────────────────────────────────────────────────────────
    async function isAdmin(chatId) {
        if (String(chatId) === String(SEED_ADMIN_ID)) return true;
        const res = await db.query('SELECT 1 FROM admins WHERE chat_id = $1', [chatId]);
        return res.rows.length > 0;
    }

    async function isSuperAdmin(chatId) {
        if (String(chatId) === String(SEED_ADMIN_ID)) return true;
        const res = await db.query('SELECT 1 FROM admins WHERE chat_id = $1 AND role = $2', [chatId, 'SUPER_ADMIN']);
        return res.rows.length > 0;
    }

    async function getAdminPermissions(chatId) {
        if (String(chatId) === String(SEED_ADMIN_ID)) return { all: true };
        const res = await db.query('SELECT role, permissions FROM admins WHERE chat_id = $1', [chatId]);
        if (!res.rows.length) return {};
        const admin = res.rows[0];
        if (admin.role === 'SUPER_ADMIN') return { all: true };
        try {
            let p = admin.permissions || {};
            if (typeof p === 'string') {
                try { p = JSON.parse(p); } catch(e) { p = {}; }
            }
            return p;
        } catch (e) { return {}; }
    }

    function hasPerm(perms, key) {
        if (perms.all) return true;
        return !!perms[key];
    }

    const PERM_KEYS = [
        { key: 'users', label: '👥 Users' },
        { key: 'agents', label: '👨‍💼 Agents' },
        { key: 'deposits', label: '💰 Deposits' },
        { key: 'withdraws', label: '💸 Withdraws' },
        { key: 'history_users', label: '📜 User Withdrawals' },
        { key: 'history_agents', label: '📜 Agent Withdrawals' },
        { key: 'search', label: '🔍 Search' },
        { key: 'logs', label: '📜 Logs' },
        { key: 'settings', label: '⚙️ Settings' },
        { key: 'broadcast', label: '📢 Broadcast' },
        { key: 'stats', label: '📊 Stats' },
        { key: 'admins', label: '🛡 Admins' },
        { key: 'money', label: '💰 Money' },
        { key: 'game_monitor', label: '🎮 Game Monitor' },
        { key: 'security', label: '🚨 Security Logs' },
        { key: 'tx_verify', label: '🔍 Transaction Verifier' },
        { key: 'health', label: '🖥 System Health' },
        { key: 'notif_wd', label: '🔔 WD Notifs' },
        { key: 'notif_ag', label: '🔔 Agent Notifs' },
        { key: 'robots', label: '🤖 Robots' },
        { key: 'robot_win', label: '🎲 Robot Win Toggle' },
    ];

    async function requireAdmin(chatId, requiredPerm = null) {
        const ok = await isAdmin(chatId).catch(() => false);
        if (!ok) {
            bot.sendMessage(chatId, '⛔ *You are not authorized to use this bot.*', { parse_mode: 'Markdown' });
            return false;
        }
        if (requiredPerm) {
            const perms = await getAdminPermissions(chatId);
            if (!hasPerm(perms, requiredPerm)) {
                bot.sendMessage(chatId, '⛔ *Permission Denied*\nYou do not have access to this section.', { parse_mode: 'Markdown' });
                return false;
            }
        }
        return true;
    }

    // ─── Audit log ────────────────────────────────────────────────────────────────
    async function log(adminId, action, target, detail) {
        try {
            await db.query(
                'INSERT INTO admin_log (admin_id, action, target, detail) VALUES ($1, $2, $3, $4)',
                [adminId, action, target, detail]
            );
        } catch (err) {
            console.error('[AdminBot] Log error:', err);
        }
    }

    // ─── Settings cache (reloaded on /setstake and on startup) ───────────────────
    let settings = { stake: 10, system_fee: 2, agent_commission: 0.5 };

    async function loadSettings() {
        try {
            if (db.dbReady) await db.dbReady;
            const res = await db.query('SELECT key, value FROM system_settings');
            for (const row of res.rows) {
                const val = row.value;
                if (val === 'true') settings[row.key] = true;
                else if (val === 'false') settings[row.key] = false;
                else if (!isNaN(val)) settings[row.key] = parseFloat(val);
                else settings[row.key] = val;
            }
        } catch (_) { }
    }
    loadSettings();

    async function saveSetting(key, value) {
        const strVal = String(value);
        await db.query(
            `INSERT INTO system_settings (key, value, updated_at)
             VALUES ($1, $2, CURRENT_TIMESTAMP)
             ON CONFLICT (key) DO UPDATE SET value = $3, updated_at = CURRENT_TIMESTAMP`,
            [key, strVal, strVal]
        );
        // Update local cache with correct type
        if (value === 'true' || value === true) settings[key] = true;
        else if (value === 'false' || value === false) settings[key] = false;
        else if (!isNaN(value)) settings[key] = parseFloat(value);
        else settings[key] = value;

        // Sync with game state if needed
        if (gameState && gameState.reloadSettings) {
            gameState.reloadSettings();
        }
    }

    // ─── Main menu ───────────────────────────────────────────────────────────────
    function mainMenu(perms) {
        const rows = [];

        const r1 = [];
        if (hasPerm(perms, 'users')) r1.push({ text: '👥 Users', callback_data: 'adm_users' });
        if (hasPerm(perms, 'agents')) r1.push({ text: '👨‍💼 Agents', callback_data: 'adm_agents' });
        if (r1.length) rows.push(r1);

        const r2 = [];
        if (hasPerm(perms, 'deposits')) r2.push({ text: '💰 Deposits', callback_data: 'adm_deposits' });
        if (hasPerm(perms, 'withdraws')) r2.push({ text: '💸 Withdraws', callback_data: 'adm_withdraws' });
        if (r2.length) rows.push(r2);

        const r3 = [];
        if (hasPerm(perms, 'history_users')) r3.push({ text: '📜 User Withdrawals', callback_data: 'adm_global_wd_u' });
        if (hasPerm(perms, 'history_agents')) r3.push({ text: '📜 Agent Withdrawals', callback_data: 'adm_global_wd_a' });
        if (r3.length) rows.push(r3);

        const r4 = [];
        if (hasPerm(perms, 'search')) r4.push({ text: '🔍 Search', callback_data: 'adm_search' });
        if (hasPerm(perms, 'logs')) r4.push({ text: '📜 Logs', callback_data: 'adm_logs' });
        if (r4.length) rows.push(r4);

        const r5 = [];
        if (hasPerm(perms, 'settings')) {
            r5.push({ text: '⚙️ Settings', callback_data: 'adm_settings' });
            r5.push({ text: '🔄 D/W Methods', callback_data: 'adm_dw_methods' });
        }
        if (hasPerm(perms, 'broadcast')) r5.push({ text: '📢 Broadcast', callback_data: 'adm_broadcast' });
        if (r5.length) rows.push(r5);

        const r6 = [];
        if (hasPerm(perms, 'stats')) r6.push({ text: '📊 Stats', callback_data: 'adm_stats' });
        if (hasPerm(perms, 'money')) r6.push({ text: '💰 Money', callback_data: 'adm_money' });
        if (r6.length) rows.push(r6);

        const r7 = [];
        if (hasPerm(perms, 'game_monitor')) r7.push({ text: '🎮 Game Monitor', callback_data: 'adm_game_monitor' });
        if (hasPerm(perms, 'security')) r7.push({ text: '🚨 Security Logs', callback_data: 'adm_security' });
        if (r7.length) rows.push(r7);

        const r8 = [];
        if (hasPerm(perms, 'admins')) r8.push({ text: '🛡 Admins', callback_data: 'adm_admins' });
        if (hasPerm(perms, 'tx_verify')) r8.push({ text: '🔍 Transaction Verifier', callback_data: 'adm_tx_verify' });
        if (r8.length) rows.push(r8);

        const r9 = [];
        if (hasPerm(perms, 'health')) r9.push({ text: '🖥 System Health', callback_data: 'adm_health' });
        if (r9.length) rows.push(r9);

        // 🤖 Robots — shown only if admin has robots permission (Super Admin always has it)
        if (hasPerm(perms, 'robots')) {
            const isWinOn = settings.robots_always_win === true || settings.robots_always_win === 'true';
            const robotRow = [{ text: '🤖 Robots', callback_data: 'adm_robots' }];
            if (hasPerm(perms, 'robot_win')) {
                robotRow.push({ text: isWinOn ? '🎲 Always Win: ON' : '🎲 Always Win: OFF', callback_data: 'adm_toggle_robot_win' });
            }
            rows.push(robotRow);
        }

        return { inline_keyboard: rows };
    }

    function backBtn(cb = 'adm_back') {
        return { inline_keyboard: [[{ text: '🔙 Main Menu', callback_data: cb }]] };
    }

    async function sendMenu(chatId, msgId, text) {
        try {
            const perms = await getAdminPermissions(chatId);
            const opts = { parse_mode: 'Markdown', reply_markup: mainMenu(perms) };
            if (msgId) {
                return await bot.editMessageText(text, { chat_id: chatId, message_id: msgId, ...opts });
            }
            return await bot.sendMessage(chatId, text, opts);
        } catch (err) {
            console.error('[sendMenu Error]:', err.message);
            // Fallback just in case the menu layout itself is what's breaking it
            bot.sendMessage(chatId, "⚠️ Menu failed to load. Please check logs.").catch(e => console.error("Fallback failed:", e.message));
        }
    }
    // ─── /start ──────────────────────────────────────────────────────────────────
    bot.onText(/\/start/i, async msg => {
        const chatId = msg.chat.id;
        if (!await requireAdmin(chatId)) return;
        delete state[chatId];
        sendMenu(chatId, null, `🛠 *Smart Bingo Admin Panel*\n\nWelcome, Admin!\nChoose a section:`);
    });

    // ─── /stats ──────────────────────────────────────────────────────────────────
    bot.onText(/\/stats/i, async msg => {
        const chatId = msg.chat.id;
        if (!await requireAdmin(chatId, 'stats')) return;
        await handleStats(chatId, null);
    });

    // ─── /users ──────────────────────────────────────────────────────────────────
    bot.onText(/\/users/i, async msg => {
        const chatId = msg.chat.id;
        if (!await requireAdmin(chatId, 'users')) return;
        await showUserList(chatId, null, 0);
    });

    // ─── /user <phone|username> ───────────────────────────────────────────────────
    bot.onText(/\/user (.+)/i, async (msg, match) => {
        const chatId = msg.chat.id;
        if (!await requireAdmin(chatId, 'users')) return;
        await searchUser(chatId, null, match[1].trim());
    });

    // ─── /setstake <amount> ───────────────────────────────────────────────────────
    bot.onText(/\/setstake (\d+(?:\.\d+)?)/i, async (msg, match) => {
        const chatId = msg.chat.id;
        if (!await requireAdmin(chatId, 'settings')) return;

        const newStake = parseFloat(match[1]);
        if (newStake < 1) return bot.sendMessage(chatId, '❌ Stake must be at least 1 ETB.');

        const newFee = parseFloat((newStake * 0.2).toFixed(2));
        const newComm = parseFloat((newFee * 0.25).toFixed(2));

        await saveSetting('stake', newStake);
        await saveSetting('system_fee', newFee);
        await saveSetting('agent_commission', newComm);
        await loadSettings();

        // Reload settings in gameState so live games use new values
        if (gameState.reloadSettings) await gameState.reloadSettings();

        await log(chatId, 'setstake', '', `stake=${newStake}`);

        bot.sendMessage(chatId,
            `✅ *Settings Updated*\n\n🎯 Stake: *${newStake} ETB*\n🧾 System fee: *${newFee} ETB* (20%)\n🧑‍💼 Agent commission: *${newComm} ETB* (25% of fee)`,
            { parse_mode: 'Markdown' }
        );
    });

    // ─── /broadcast <message> ────────────────────────────────────────────────────
    bot.onText(/\/broadcast (.+)/i, async (msg, match) => {
        const chatId = msg.chat.id;
        if (!await requireAdmin(chatId, 'broadcast')) return;

        const text = match[1].trim();
        const users = await db.query('SELECT chat_id FROM users');
        let sent = 0, failed = 0;

        for (const { chat_id } of users.rows) {
            try {
                await bingoBot.sendMessage(chat_id, text, { parse_mode: 'Markdown' });
                sent++;
            } catch (_) {
                failed++;
            }
        }

        await log(chatId, 'broadcast', '', text.slice(0, 80));

        bot.sendMessage(chatId, `📢 *Broadcast complete*\n\n✅ Sent: ${sent}\n❌ Failed: ${failed}`, { parse_mode: 'Markdown' });
    });

    // ─── /addadmin [id] ─────────────────────────────────────────────────────────
    bot.onText(/\/addadmin(?: (\d+))?/i, async (msg, match) => {
        const chatId = msg.chat.id;
        if (!await isSuperAdmin(chatId)) return bot.sendMessage(chatId, '⛔️ Only Super Admins can add new admins.');

        const targetId = match[1];
        if (!targetId) {
            state[chatId] = { step: 'add_admin_id' };
            return bot.sendMessage(chatId, '➕ *Add Admin*\n\nPlease enter the Telegram User ID of the new admin:', { parse_mode: 'Markdown' });
        }

        await db.query(
            'INSERT INTO admins (chat_id, username, added_by) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
            [targetId, '', chatId]
        );

        await log(chatId, 'add_admin', targetId);

        bot.sendMessage(chatId, `✅ Admin \`${targetId}\` added.`, { parse_mode: 'Markdown' });

        const notifyText = `🛠 You have been added as a Smart Bingo Admin!\n\nSend /start to @${ADMIN_BOT_USERNAME} to open the panel.`;
        if (bingoBot) {
            bingoBot.sendMessage(targetId, notifyText).catch(() => { });
        } else {
            bot.sendMessage(targetId, notifyText).catch(() => { });
        }
    });

    // ─── /removeadmin [id] ──────────────────────────────────────────────────────
    bot.onText(/\/removeadmin(?: (\d+))?/i, async (msg, match) => {
        const chatId = msg.chat.id;
        if (!await isSuperAdmin(chatId)) return bot.sendMessage(chatId, '⛔️ Only Super Admins can remove admins.');

        const targetId = match[1];
        if (!targetId) {
            state[chatId] = { step: 'remove_admin_id' };
            return bot.sendMessage(chatId, '➖ *Remove Admin*\n\nPlease enter the Telegram User ID you want to remove:', { parse_mode: 'Markdown' });
        }

        if (String(targetId) === String(SEED_ADMIN_ID)) {
            return bot.sendMessage(chatId, '⛔️ Cannot remove root admin.');
        }

        await db.query('DELETE FROM admins WHERE chat_id = $1', [targetId]);
        await log(chatId, 'remove_admin', targetId);

        bot.sendMessage(chatId, `✅ Admin \`${targetId}\` removed.`, { parse_mode: 'Markdown' });
    });

    // ─── /admins ─────────────────────────────────────────────────────────────────
    bot.onText(/\/admins/i, async msg => {
        const chatId = msg.chat.id;
        if (!await requireAdmin(chatId, 'admins')) return;
        return showAdminsList(chatId, null);
    });

    // ─── /checktx <txid> ─────────────────────────────────────────────────────────
    bot.onText(/\/checktx (.+)/, async (msg, match) => {
        const chatId = msg.chat.id;
        if (!await requireAdmin(chatId, 'search')) return;
        const txId = match[1].trim();
        const res = await db.query(
            `SELECT d.*, u.phone_number, u.first_name, u.username
             FROM deposits d
             LEFT JOIN users u ON u.chat_id = d.chat_id
             WHERE d.tx_id ILIKE $1`,
            [txId]
        );
        if (!res.rows.length) return bot.sendMessage(chatId, `❌ Transaction \`${txId}\` not found.`, { parse_mode: 'Markdown' });
        const d = res.rows[0];
        bot.sendMessage(chatId,
            `🔍 *Transaction Found*\n\n` +
            `🆔 TX ID: \`${d.tx_id}\`\n` +
            `💰 Amount: *${d.amount} ETB*\n` +
            `💳 Method: ${esc(d.method)}\n` +
            `👤 User: ${esc(d.first_name || '')} ${d.username ? '@' + esc(d.username) : ''}\n` +
            `📱 Phone: ${esc(d.phone_number || 'N/A')}\n` +
            `🕐 Date: ${new Date(d.created_at).toLocaleString()}`,
            { parse_mode: 'Markdown' }
        );
    });

    // ─── Callback query handler ───────────────────────────────────────────────────
    bot.on('callback_query', async query => {
        try {
            const chatId = query.message.chat.id;
            const msgId = query.message.message_id;
            const data = query.data;
            const fromId = query.from.id;

            // Smart callback ack — Telegram requires every callback_query to be answered
            // within 60s or it shows an error. We track whether it's been answered.
            let _cbAnswered = false;
            const answerQuery = (text = '', alert = false) => {
                if (_cbAnswered) return;
                _cbAnswered = true;
                bot.answerCallbackQuery(query.id, text ? { text, show_alert: alert } : {}).catch(() => {});
            };
            // Auto-ack navigation buttons (answered by editing the message which dismisses spinner)
            // We still call answerQuery at the end as fallback for any handler that didn't

            // ── TX Verifier ──
            if (data === 'adm_tx_verify') {
                delete state[chatId];
                state[chatId] = { step: 'tx_verify_input' };
                bot.deleteMessage(chatId, msgId).catch(() => { });
                return bot.sendMessage(chatId,
                    `🔍 *Transaction Verifier*\n\n` +
                    `Send the Transaction ID to look up.\n\n` +
                    `Supported banks: Telebirr, CBEBirr, CBE, Abyssinia\n\n` +
                    `_Example: TEL2026030812345, FT26067ABCD1_`,
                    {
                        parse_mode: 'Markdown',
                        reply_markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'adm_back' }]] }
                    }
                );
            }

            if (data.startsWith('adm_tx_mark_used_')) {
                const txId = data.replace('adm_tx_mark_used_', '');
                return markTxAsUsed(chatId, msgId, fromId, txId);
            }

            if (data === 'adm_dw_methods') return showDwMethodsMenu(chatId, msgId);
            if (data === 'adm_dw_dep_menu') return showDwDepMenu(chatId, msgId);
            if (data === 'adm_dw_wd_menu') return showDwWdMenu(chatId, msgId);
            if (data === 'adm_dw_change_acc_menu') return showDwChangeAccMenu(chatId, msgId);

            if (data.startsWith('adm_dw_toggle_')) {
                // data = 'adm_dw_toggle_dep_cbebirr' → remainder = 'dep_cbebirr'
                const remainder = data.replace('adm_dw_toggle_', '');
                // type is 'dep' or 'wd', method is everything after first underscore
                const underIdx = remainder.indexOf('_');
                const type   = remainder.slice(0, underIdx);   // 'dep' or 'wd'
                const method = remainder.slice(underIdx + 1);  // 'cbebirr', 'cbe', 'telebirr', 'abyssinia'
                const key    = `${type}_${method}_active`;
                const current = settings[key] !== false && settings[key] !== 'false';
                await saveSetting(key, !current);
                await log(fromId, 'toggle_dw_method', key, String(!current));
                if (type === 'dep') return showDwDepMenu(chatId, msgId);
                if (type === 'wd')  return showDwWdMenu(chatId, msgId);
            }

            if (data.startsWith('adm_dw_edit_acc_')) {
                const method = data.replace('adm_dw_edit_acc_', '');
                state[chatId] = { step: 'edit_acc_name', method };
                return editMsg(chatId, msgId, `⚙️ *Change Account for ${method.toUpperCase()}*\n\n📝 Please enter the *Account Holder Name*:`, {
                    inline_keyboard: [[{ text: '🔙 Cancel', callback_data: 'adm_dw_change_acc_menu' }]]
                });
            }

            // ── Main menu back ──
            if (data === 'adm_back') {

                delete state[chatId];
                return sendMenu(chatId, msgId, `🛠️ *Smart Bingo Admin Panel*\n\nChoose a section:`);
            }

            // ── Dynamic RBAC Interceptor ──
            const permMap = [
                { match: /^adm_user/, perm: 'users' },
                { match: /^adm_agent/, perm: 'agents' },
                { match: /^adm_deposit/, perm: 'deposits' },
                { match: /^adm_withdraw/, perm: 'withdraws' },
                { match: /^adm_global_wd_u/, perm: 'history_users' },
                { match: /^adm_global_wd_a/, perm: 'history_agents' },
                { match: /^adm_search/, perm: 'search' },
                { match: /^adm_log/, perm: 'logs' },
                { match: /^adm_setting|^adm_mm|^adm_fin|^adm_set_stake|^adm_stake_val|^adm_template|^adm_notify|^adm_dw_/, perm: 'settings' },
                { match: /^adm_broadcast/, perm: 'broadcast' },
                { match: /^adm_stat/, perm: 'stats' },
                { match: /^adm_admin|^adm_perm/, perm: 'admins' },
                { match: /^adm_money/, perm: 'money' },
                { match: /^adm_game_monitor|^adm_game_history|^adm_game_active_users|^adm_set_forced_winners/, perm: 'game_monitor' },
                { match: /^adm_security/, perm: 'security' },
                { match: /^adm_tx_verify|^adm_tx_mark_used_/, perm: 'tx_verify' }
            ];

            let reqPerm = null;
            for (const { match, perm } of permMap) {
                if (match.test(data)) { reqPerm = perm; break; }
            }

            // Robots section — uses standard 'robots' permission
            if (data === 'adm_robots' || data === 'adm_set_robots') {
                reqPerm = 'robots';
            }

            if (reqPerm) {
                if (!await requireAdmin(fromId, reqPerm)) {
                    answerQuery('⛔ Not authorized for this section.', true);
                    return;
                }
            } else {
                if (!await requireAdmin(fromId)) {
                    answerQuery('⛔ Not authorized.', true);
                    return;
                }
            }

            // ════════════════════════════════════════════════════════════════════
            // 🛡️ ADMINS & RBAC
            // ════════════════════════════════════════════════════════════════════
            if (data === 'adm_admins') {
                return showAdminsList(chatId, msgId);
            }
            if (data.startsWith('adm_admin_view_')) {
                return showAdminDetail(chatId, msgId, data.replace('adm_admin_view_', ''));
            }
            if (data.startsWith('adm_perm_toggle_')) {
                // Format: adm_perm_toggle_USERID_permkey
                // Since user IDs are numeric, find the first underscore after the numeric portion
                const raw = data.replace('adm_perm_toggle_', '');
                const match = raw.match(/^(\d+)_(.+)$/);
                if (!match) { bot.answerCallbackQuery(query.id, { text: 'Invalid toggle format' }).catch(() => {}); return; }
                const targetUid = match[1];
                const key = match[2];
                return toggleAdminPermission(chatId, msgId, targetUid, key, query.id);
            }
            if (data === 'adm_admin_add') {
                if (!await isSuperAdmin(fromId)) return answerQuery('⛔ Only Super Admins can add admins.', true);
                state[chatId] = { step: 'add_admin_id' };
                answerQuery();
                return editMsg(chatId, msgId, '➕ *Add Admin*\n\nPlease enter the Telegram User ID of the new admin:', backBtn('adm_admins'));
            }
            if (data === 'adm_admin_rem') {
                if (!await isSuperAdmin(fromId)) return answerQuery('⛔ Only Super Admins can remove admins.', true);
                state[chatId] = { step: 'remove_admin_id' };
                answerQuery();
                return editMsg(chatId, msgId, '➖ *Remove Admin*\n\nPlease enter the Telegram User ID you want to remove:', backBtn('adm_admins'));
            }

            // ════════════════════════════════════════════════════════════════════
            // 📜 GLOBAL HISTORY
            // ════════════════════════════════════════════════════════════════════
            if (data === 'adm_global_wd_u') return showGlobalWithdrawals(chatId, msgId, false, 0);
            if (data === 'adm_global_wd_a') return showGlobalWithdrawals(chatId, msgId, true, 0);
            if (data.startsWith('adm_g_wd_u_p_')) return showGlobalWithdrawals(chatId, msgId, false, parseInt(data.replace('adm_g_wd_u_p_', '')));
            if (data.startsWith('adm_g_wd_a_p_')) return showGlobalWithdrawals(chatId, msgId, true, parseInt(data.replace('adm_g_wd_a_p_', '')));

            // ════════════════════════════════════════════════════════════════════
            // 👥 USERS
            // ════════════════════════════════════════════════════════════════════
            if (data === 'adm_users') {
                return showUserList(chatId, msgId, 0);
            }

            if (data.startsWith('adm_users_p_')) {
                const page = parseInt(data.replace('adm_users_p_', ''), 10);
                return showUserList(chatId, msgId, page);
            }

            if (data.startsWith('adm_user_view_')) {
                const uid = data.replace('adm_user_view_', '');
                return showUserDetail(chatId, msgId, uid);
            }

            if (data.startsWith('adm_user_addbal_')) {
                const uid = data.replace('adm_user_addbal_', '');
                state[chatId] = { step: 'balance_amount', action: 'add', targetType: 'user', targetId: uid };
                return editMsg(chatId, msgId,
                    `💰 *Add Balance (User)*\n\nUser ID: \`${uid}\`\n\nEnter amount to add (ETB):`,
                    backBtn(`adm_user_view_${uid}`)
                );
            }

            if (data.startsWith('adm_user_deduct_')) {
                const uid = data.replace('adm_user_deduct_', '');
                state[chatId] = { step: 'balance_amount', action: 'deduct', targetType: 'user', targetId: uid };
                return editMsg(chatId, msgId,
                    `💸 *Deduct Balance (User)*\n\nUser ID: \`${uid}\`\n\nEnter amount to deduct (ETB):`,
                    backBtn(`adm_user_view_${uid}`)
                );
            }

            if (data.startsWith('adm_user_addbonus_')) {
                const uid = data.replace('adm_user_addbonus_', '');
                state[chatId] = { step: 'bonus_balance_amount', action: 'add', targetType: 'user', targetId: uid };
                return editMsg(chatId, msgId,
                    `🎁 *Add Bonus Balance (User)*\n\nUser ID: \`${uid}\`\n\nEnter bonus amount to add (ETB):`,
                    backBtn(`adm_user_view_${uid}`)
                );
            }

            if (data.startsWith('adm_user_deductbonus_')) {
                const uid = data.replace('adm_user_deductbonus_', '');
                state[chatId] = { step: 'bonus_balance_amount', action: 'deduct', targetType: 'user', targetId: uid };
                return editMsg(chatId, msgId,
                    `💔 *Deduct Bonus Balance (User)*\n\nUser ID: \`${uid}\`\n\nEnter bonus amount to deduct (ETB):`,
                    backBtn(`adm_user_view_${uid}`)
                );
            }

            if (data.startsWith('adm_user_setbal_')) {
                const uid = data.replace('adm_user_setbal_', '');
                state[chatId] = { step: 'balance_amount', action: 'set', targetType: 'user', targetId: uid };
                return editMsg(chatId, msgId,
                    `⚙️ *Set Balance (User)*\n\nUser ID: \`${uid}\`\n\nEnter new balance (ETB):`,
                    backBtn(`adm_user_view_${uid}`)
                );
            }

            if (data.startsWith('adm_user_wd_hist_')) {
                const uid = data.replace('adm_user_wd_hist_', '');
                return showUserWithdrawalHistory(chatId, msgId, uid);
            }

            // ── NEW: Deposit History ──
            if (data.startsWith('adm_user_dep_hist_')) {
                const uid = data.replace('adm_user_dep_hist_', '');
                const res = await db.query(
                    `SELECT id, amount, method, tx_id, created_at FROM deposits 
                     WHERE chat_id = $1 ORDER BY created_at DESC LIMIT 20`,
                    [uid]
                );
                const lines = res.rows.map(d => {
                    const date = new Date(d.created_at).toLocaleString('en-GB', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit', year: 'numeric' });
                    return `• *${d.amount} ETB* (${d.method}) — \`${d.tx_id}\`\n  📅 \`${date}\``;
                }).join('\n\n');

                return editMsg(chatId, msgId, `📥 *Deposit History (User: ${uid})*\n\n${lines || 'No history found.'}`, backBtn(`adm_user_view_${uid}`));
            }

            // ── NEW: Agent Management Prompts ──
            if (data.startsWith('adm_user_add_agent_prompt_')) {
                const uid = data.replace('adm_user_add_agent_prompt_', '');
                return editMsg(chatId, msgId,
                    `❓ Are you sure you want to ADD user \`${uid}\` as an agent?`,
                    { inline_keyboard: [[{ text: '✅ Yes', callback_data: `adm_user_add_agent_confirm_${uid}` }, { text: '❌ No', callback_data: `adm_user_view_${uid}` }]] }
                );
            }

            if (data.startsWith('adm_user_add_agent_confirm_')) {
                const targetId = data.replace('adm_user_add_agent_confirm_', '');
                try {
                    const uRes = await db.query('SELECT first_name, username FROM users WHERE chat_id = $1', [targetId]);
                    const first_name = uRes.rows[0]?.first_name || '';
                    const username = uRes.rows[0]?.username || '';
                    const refCode = `ref_${targetId}`;
                    await db.query(`
                        INSERT INTO agents (chat_id, first_name, username, balance, is_approved, referral_code)
                        VALUES ($1, $2, $3, 0.00, TRUE, $4)
                        ON CONFLICT (chat_id) DO UPDATE SET is_approved = TRUE
                    `, [targetId, first_name, username, refCode]);

                    if (bingoBot) {
                        const agentBotUsername = process.env.AGENT_BOT_USERNAME || 'Smart_agent_bot';
                        bingoBot.sendMessage(targetId, `🎉 *Congratulations! You are now an Agent!*\n\nYour referral link: \`https://t.me/${process.env.BINGO_BOT_USERNAME || 'SmartBingo_Bot'}?start=${refCode}\`\n\nGo to @${agentBotUsername} to manage your agent account!`, { parse_mode: 'Markdown' }).catch((e) => { console.error('Failed to send agent promo message', e.message); });
                    }
                    bot.answerCallbackQuery(query.id, { text: '✅ Agent added successfully', show_alert: true });
                } catch (e) { console.error('Error adding agent:', e); }
                return showUserDetail(chatId, msgId, targetId);
            }

            if (data.startsWith('adm_user_rem_agent_prompt_')) {
                const uid = data.replace('adm_user_rem_agent_prompt_', '');
                return editMsg(chatId, msgId,
                    `❓ Are you sure you want to REMOVE user \`${uid}\` from agents?`,
                    { inline_keyboard: [[{ text: '✅ Yes', callback_data: `adm_user_rem_agent_confirm_${uid}` }, { text: '❌ No', callback_data: `adm_user_view_${uid}` }]] }
                );
            }

            if (data.startsWith('adm_user_rem_agent_confirm_')) {
                const targetId = data.replace('adm_user_rem_agent_confirm_', '');
                await db.query('DELETE FROM pending_agents WHERE chat_id = $1', [targetId]);
                await db.query('DELETE FROM agents WHERE chat_id = $1', [targetId]);
                bot.answerCallbackQuery(query.id, { text: '✅ Agent removed successfully', show_alert: true });
                return showUserDetail(chatId, msgId, targetId);
            }

            if (data.startsWith('adm_audit_trail_')) {
                const uid = data.replace('adm_audit_trail_', '');
                return showAuditTrail(chatId, msgId, uid);
            }

            if (data === 'adm_game_monitor') return showGameMonitor(chatId, msgId);
            if (data === 'adm_game_active_users') return showActiveGameUsers(chatId, msgId);
            if (data === 'adm_game_history') return showAdminGameHistory(chatId, msgId, 0);
            if (data.startsWith('adm_game_hist_p_')) return showAdminGameHistory(chatId, msgId, parseInt(data.replace('adm_game_hist_p_', '')));
            if (data === 'adm_security') return showSecurityLogs(chatId, msgId);

            if (data.startsWith('adm_user_block_')) {
                const uid = data.replace('adm_user_block_', '');
                await db.query('UPDATE users SET is_blocked = TRUE WHERE chat_id = $1', [uid]);
                await log(fromId, 'block_user', uid);
                if (bingoBot) {
                    bingoBot.sendMessage(uid, '⛔ *Your account has been blocked.* Contact support for more info.', { parse_mode: 'Markdown' }).catch(() => { });
                }
                return showUserDetail(chatId, msgId, uid);
            }

            if (data.startsWith('adm_user_unblock_')) {
                const uid = data.replace('adm_user_unblock_', '');
                await db.query('UPDATE users SET is_blocked = FALSE WHERE chat_id = $1', [uid]);
                await log(fromId, 'unblock_user', uid);
                if (bingoBot) {
                    bingoBot.sendMessage(uid, '✅ *Your account has been unblocked.* You can now play again!', { parse_mode: 'Markdown' }).catch(() => { });
                }
                return showUserDetail(chatId, msgId, uid);
            }

            if (data.startsWith('adm_user_freeze_')) {
                const uid = data.replace('adm_user_freeze_', '');
                await db.query('UPDATE users SET is_frozen = TRUE WHERE chat_id = $1', [uid]);
                await log(fromId, 'freeze_user', uid);
                if (bingoBot) {
                    bingoBot.sendMessage(uid, '❄️ *Your account has been frozen.* You can still login but cannot place bets. Contact support for more info.', { parse_mode: 'Markdown' }).catch(() => { });
                }
                return showUserDetail(chatId, msgId, uid);
            }

            if (data.startsWith('adm_user_unfreeze_')) {
                const uid = data.replace('adm_user_unfreeze_', '');
                await db.query('UPDATE users SET is_frozen = FALSE WHERE chat_id = $1', [uid]);
                await log(fromId, 'unfreeze_user', uid);
                if (bingoBot) {
                    bingoBot.sendMessage(uid, '☀️ *Your account has been unfrozen.* You can now place bets again!', { parse_mode: 'Markdown' }).catch(() => { });
                }
                return showUserDetail(chatId, msgId, uid);
            }

            // ════════════════════════════════════════════════════════════════════
            // 🧑‍💼 AGENTS
            // ════════════════════════════════════════════════════════════════════
            if (data === 'adm_agents') {
                return showAgentsMenu(chatId, msgId);
            }

            if (data === 'adm_agents_pending') {
                return showPendingAgents(chatId, msgId);
            }

            if (data === 'adm_agents_all') {
                return showAllAgents(chatId, msgId);
            }

            if (data.startsWith('adm_agent_view_')) {
                const uid = data.replace('adm_agent_view_', '');
                return showAgentDetail(chatId, msgId, uid);
            }

            if (data.startsWith('adm_agent_users_')) {
                const parts = data.replace('adm_agent_users_', '').split('_');
                let page = 0;
                let uid = '';
                if (parts.length === 2) {
                    page = parseInt(parts[0], 10);
                    uid = parts[1];
                } else {
                    uid = parts[0];
                }
                return showAgentInvitedUsers(chatId, msgId, uid, page);
            }

            if (data.startsWith('adm_agent_approve_')) {
                const uid = data.replace('adm_agent_approve_', '');
                return approveAgent(chatId, msgId, fromId, uid);
            }

            if (data.startsWith('adm_agent_reject_')) {
                const uid = data.replace('adm_agent_reject_', '');
                return rejectAgent(chatId, msgId, fromId, uid);
            }

            if (data.startsWith('adm_agent_block_')) {
                const uid = data.replace('adm_agent_block_', '');
                await db.query('UPDATE agents SET is_blocked = TRUE WHERE chat_id = $1', [uid]);
                await log(fromId, 'block_agent', uid);
                if (agentBot) {
                    agentBot.sendMessage(uid, '⛔ Your agent account has been suspended. Contact support.').catch(() => { });
                }
                return showAgentDetail(chatId, msgId, uid);
            }

            if (data.startsWith('adm_agent_unblock_')) {
                const uid = data.replace('adm_agent_unblock_', '');
                await db.query('UPDATE agents SET is_blocked = FALSE WHERE chat_id = $1', [uid]);
                await log(fromId, 'unblock_agent', uid);
                if (agentBot) {
                    agentBot.sendMessage(uid, '✅ *Your agent account has been unblocked.* You can now use the dashboard again!', { parse_mode: 'Markdown' }).catch(() => { });
                }
                return showAgentDetail(chatId, msgId, uid);
            }

            if (data.startsWith('adm_agent_addbal_')) {
                const uid = data.replace('adm_agent_addbal_', '');
                state[chatId] = { step: 'balance_amount', action: 'add', targetType: 'agent', targetId: uid };
                return editMsg(chatId, msgId,
                    `💰 *Add Balance (Agent)*\n\nAgent ID: \`${uid}\`\n\nEnter amount to add (ETB):`,
                    backBtn(`adm_agent_view_${uid}`)
                );
            }

            if (data.startsWith('adm_agent_deduct_')) {
                const uid = data.replace('adm_agent_deduct_', '');
                state[chatId] = { step: 'balance_amount', action: 'deduct', targetType: 'agent', targetId: uid };
                return editMsg(chatId, msgId,
                    `💸 *Deduct Balance (Agent)*\n\nAgent ID: \`${uid}\`\n\nEnter amount to deduct (ETB):`,
                    backBtn(`adm_agent_view_${uid}`)
                );
            }

            if (data.startsWith('adm_agent_setbal_')) {
                const uid = data.replace('adm_agent_setbal_', '');
                state[chatId] = { step: 'balance_amount', action: 'set', targetType: 'agent', targetId: uid };
                return editMsg(chatId, msgId,
                    `⚙️ *Set Balance (Agent)*\n\nAgent ID: \`${uid}\`\n\nEnter new balance (ETB):`,
                    backBtn(`adm_agent_view_${uid}`)
                );
            }

            if (data.startsWith('adm_agent_wd_hist_')) {
                const uid = data.replace('adm_agent_wd_hist_', '');
                return showAgentWithdrawalHistory(chatId, msgId, uid);
            }

            // --- NEW "ADD AGENT" LOGIC ---
            if (data === 'adm_agent_add') {
                return showNonAgentUsers(chatId, msgId, 0);
            }

            if (data.startsWith('adm_agadd_p_')) {
                const p = parseInt(data.replace('adm_agadd_p_', ''), 10);
                return showNonAgentUsers(chatId, msgId, p);
            }

            if (data.startsWith('adm_agadd_view_')) {
                const uid = data.replace('adm_agadd_view_', '');
                return showAddAgentProfile(chatId, msgId, uid);
            }

            if (data.startsWith('adm_agadd_cancel_')) {
                return showNonAgentUsers(chatId, msgId, 0);
            }

            if (data.startsWith('adm_agadd_confirm_')) {
                const targetId = data.replace('adm_agadd_confirm_', '');

                try {
                    const uRes = await db.query(
                        'SELECT first_name, username FROM users WHERE chat_id = $1',
                        [targetId]
                    );

                    let first_name = '', username = '';

                    if (uRes.rows.length > 0) {
                        first_name = uRes.rows[0].first_name || '';
                        username = uRes.rows[0].username || '';
                    }

                    const refCode = `ref_${targetId}`;

                    // Upsert agent
                    await db.query(`
            INSERT INTO agents (chat_id, first_name, username, balance, is_approved, referral_code)
            VALUES ($1, $2, $3, 0.00, TRUE, $4)
            ON CONFLICT (chat_id) DO UPDATE
            SET 
                is_approved = TRUE,
                first_name = EXCLUDED.first_name,
                username = EXCLUDED.username,
                referral_code = EXCLUDED.referral_code
        `, [targetId, first_name, username, refCode]);

                    const link = `https://t.me/${process.env.BINGO_BOT_USERNAME || 'SmartBingo_Bot'}?start=${refCode}`;

                    // Notify agent via AgentBot only
                    if (agentBot) {
                        agentBot.sendMessage(
                            targetId,
                            `🎉 *Congratulations! You are now a Smart Bingo Agent!* 🎉\n\n` +
                            `Here is your unique referral link:\n` +
                            `\`${link}\`\n\n` +
                            `Share this link! When your invited users play, you earn commissions!
            
            Invite ያደረጉት ሰው 1 ጨዋታ ሲጫወት 1 ብር commission ያገኛሉ

      ለማስጀመር /start ይጫኑ`,
                            { parse_mode: 'Markdown' }
                        ).catch(err => console.error('[AdminBot] AgentBot notify error:', err));
                    } else {
                        console.warn('[AdminBot] AgentBot instance missing - notification not sent');
                    }
                    return bot.editMessageText(
                        `✅ *User ${targetId} has been successfully added as an Agent!*\n\nA congratulatory message was sent to them.`,
                        {
                            chat_id: chatId,
                            message_id: msgId,
                            parse_mode: 'Markdown',
                            reply_markup: {
                                inline_keyboard: [[
                                    { text: '🔙 Back to List', callback_data: 'adm_agent_add' }
                                ]]
                            }
                        }
                    );

                } catch (err) {
                    console.error('[AdminBot] Add agent confirm err:', err);
                }
            }

            // ─── Agent Removal Confirmation ───
            if (data.startsWith('adm_agent_remove_')) {
                const uid = data.replace('adm_agent_remove_', '');
                return editMsg(
                    chatId,
                    msgId,
                    `⚠️ *Remove Agent Confirmation*\n\nAre you sure you want to remove agent \`${uid}\`?\nThis will delete the agent account but preserve transaction history.`,
                    {
                        inline_keyboard: [
                            [
                                { text: '✅ Yes, Remove', callback_data: `adm_agent_confirm_remove_${uid}` },
                                { text: '❌ No, Cancel', callback_data: `adm_agent_view_${uid}` }
                            ]
                        ]
                    }
                );
            }

            if (data.startsWith('adm_agent_confirm_remove_')) {
                const uid = data.replace('adm_agent_confirm_remove_', '');
                try {
                    // Update related records to preserve agent history (set IDs to NULL)
                    await db.query('UPDATE agent_earnings SET agent_id = NULL WHERE agent_id = $1', [uid]);
                    await db.query('UPDATE agent_withdrawals SET agent_id = NULL WHERE agent_id = $1', [uid]);
                    await db.query('UPDATE users SET referred_by = NULL WHERE referred_by = $1', [uid]);

                    // Finally delete the agent
                    await db.query('DELETE FROM agents WHERE chat_id = $1', [uid]);

                    await log(fromId, 'remove_agent', uid);

                    bot.answerCallbackQuery(query.id, { text: 'Agent removed successfully.' });

                    return showAllAgents(chatId, msgId);
                } catch (err) {
                    console.error('[AdminBot] Error removing agent:', err);
                    return bot.sendMessage(chatId, '❌ Error removing agent.');
                }
            }

            // ════════════════════════════════════════════════════════════════════
            // 💰 DEPOSITS
            // ════════════════════════════════════════════════════════════════════
            if (data === 'adm_deposits') {
                return showDeposits(chatId, msgId, 0);
            }

            if (data.startsWith('adm_deps_p_')) {
                const page = parseInt(data.replace('adm_deps_p_', ''), 10);
                return showDeposits(chatId, msgId, page);
            }

            if (data === 'adm_dep_fix') {
                state[chatId] = { step: 'fix_dep_uid' };
                return editMsg(chatId, msgId,
                    `🔧 *Fix Deposit / Add Balance*\n\nEnter the user's phone number or Telegram ID:`,
                    backBtn('adm_deposits')
                );
            }

            if (data === 'adm_manual_deposits') {
                return showManualDeposits(chatId, msgId, 0);
            }

            if (data.startsWith('adm_manual_deps_p_')) {
                const page = parseInt(data.replace('adm_manual_deps_p_', ''), 10);
                return showManualDeposits(chatId, msgId, page);
            }

            // ════════════════════════════════════════════════════════════════════
            // 💸 WITHDRAWALS
            // ════════════════════════════════════════════════════════════════════
            if (data === 'adm_withdraws') { // Changed from adm_withdrawals
                return showWithdrawals(chatId, msgId);
            }

            // User withdrawal completed
            if (data.startsWith('adm_wd_done_')) {
                const wdId = data.replace('adm_wd_done_', '');
                return completeUserWithdrawal(chatId, msgId, fromId, wdId);
            }

            // User withdrawal rejected
            if (data.startsWith('adm_wd_rej_')) {
                const wdId = data.replace('adm_wd_rej_', '');
                return rejectUserWithdrawal(chatId, msgId, fromId, wdId);
            }

            // Agent withdrawal completed
            if (data.startsWith('agwd_done_')) {
                const wdId = data.replace('agwd_done_', '');
                return completeAgentWithdrawal(chatId, msgId, fromId, wdId);
            }

            // Agent withdrawal rejected
            if (data.startsWith('agwd_rej_')) {
                const wdId = data.replace('agwd_rej_', '');
                return rejectAgentWithdrawal(chatId, msgId, fromId, wdId);
            }

            // ⚙️ SETTINGS
            if (data === 'adm_settings') {
                return showSettingsMenu(chatId, msgId);
            }

            if (data === 'adm_sys_settings') {
                return showSettings(chatId, msgId);
            }

            if (data === 'adm_bonus_settings') {
                return showBonusSettings(chatId, msgId);
            }

            if (data === 'adm_mm_toggle') {
                const current = (settings.maintenance_mode === true || settings.maintenance_mode === 'true');
                const newVal = current ? 'false' : 'true';
                await saveSetting('maintenance_mode', newVal);
                await log(chatId, 'toggle_maintenance', newVal);
                bot.answerCallbackQuery(query.id, { text: `Maintenance Mode ${newVal === 'true' ? 'Enabled' : 'Disabled'}` });
                return showSettings(chatId, msgId);
            }

            if (data === 'adm_notify_agent_toggle') {
                const current = (settings.notify_agent_requests !== false);
                const newVal = !current;

                await saveSetting('notify_agent_requests', newVal);
                await log(chatId, 'toggle_notify_agent', newVal);

                bot.answerCallbackQuery(query.id, {
                    text: `Agent Notifications ${newVal ? 'Enabled' : 'Disabled'}`
                });

                return showSettings(chatId, msgId);
            }

            if (data === 'adm_notify_wd_toggle') {
                const current = (settings.notify_withdrawals !== false);
                const newVal = !current;

                await saveSetting('notify_withdrawals', newVal);
                await log(chatId, 'toggle_notify_wd', newVal);

                bot.answerCallbackQuery(query.id, {
                    text: `Withdrawal Notifications ${newVal ? 'Enabled' : 'Disabled'}`
                });

                return showSettings(chatId, msgId);
            }

            if (data === 'adm_set_stake') {
                state[chatId] = { step: 'set_stake' };
                return bot.editMessageText('🎯 *Update System Stake*\n\nChoose a preset or enter amount in chat:', {
                    chat_id: chatId, message_id: msgId, parse_mode: 'Markdown',
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '10 ETB', callback_data: 'adm_stake_val_10' }],
                            [{ text: '❌ Cancel', callback_data: 'adm_settings' }]
                        ]
                    }
                });
            }

            if (data.startsWith('adm_stake_val_')) {
                const val = data.split('_')[3];
                return updateStake(chatId, msgId, val, query.id);
            }

            if (data === 'adm_fin_limits') {
                return editMsg(chatId, msgId,
                    `💰 *Financial Limits*\n\n` +
                    `Min Deposit: *${settings.min_deposit} ETB*\n` +
                    `Max Deposit: *${settings.max_deposit} ETB*\n` +
                    `Min Withdrawal: *${settings.min_withdrawal} ETB*\n` +
                    `Max Withdrawal: *${settings.max_withdrawal} ETB*`,
                    {
                        inline_keyboard: [
                            [{ text: '📥 Min Deposit', callback_data: 'adm_lim_min_dep' }, { text: '📥 Max Deposit', callback_data: 'adm_lim_max_dep' }],
                            [{ text: '📤 Min Withdraw', callback_data: 'adm_lim_min_wd' }, { text: '📤 Max Withdraw', callback_data: 'adm_lim_max_wd' }],
                            [{ text: '🔙 Back', callback_data: 'adm_settings' }]
                        ]
                    }
                );
            }

            if (data === 'adm_lim_min_dep') {
                state[chatId] = { step: 'limit_min_deposit' };
                return bot.sendMessage(chatId, '📥 Enter *Minimum Deposit* amount (ETB):', { parse_mode: 'Markdown' });
            }
            if (data === 'adm_lim_min_wd') {
                state[chatId] = { step: 'limit_min_withdrawal' };
                return bot.sendMessage(chatId, '📤 Enter *Minimum Withdrawal* amount (ETB):', { parse_mode: 'Markdown' });
            }
            if (data === 'adm_lim_max_wd') {
                state[chatId] = { step: 'limit_max_withdrawal' };
                return bot.sendMessage(chatId, '📤 Enter *Maximum Withdrawal* amount (ETB):', { parse_mode: 'Markdown' });
            }

            if (data.startsWith('adm_lim_')) {
                const action = data.replace('adm_lim_', '');
                return askLimit(chatId, msgId, action);
            }

            if (data.startsWith('adm_bonus_')) {
                const action = data.replace('adm_bonus_', '');
                // 'settings' is the bonus settings page itself, not an action
                if (action === 'settings') return showBonusSettings(chatId, msgId);
                return askBonusLimit(chatId, msgId, action);
            }

            // ════════════════════════════════════════════════════════════════════
            // 📢 BROADCAST
            // ════════════════════════════════════════════════════════════════════
            if (data === 'adm_broadcast') {
                return editMsg(chatId, msgId,
                    `📢 *Broadcast Enhancement*\n\nChoose the type of broadcast you want to send:`,
                    {
                        inline_keyboard: [
                            [{ text: '📝 Text Only', callback_data: 'adm_bc_type_text' }],
                            [{ text: '🖼️ Image Only', callback_data: 'adm_bc_type_image' }],
                            [{ text: '🖼️ + 📝 Image & Text', callback_data: 'adm_bc_type_both' }],
                            [{ text: '🔙 Back', callback_data: 'adm_back' }]
                        ]
                    }
                );
            }

            if (data === 'adm_bc_type_text') {
                state[chatId] = { step: 'bc_text_input', type: 'text' };
                return editMsg(chatId, msgId, '📝 *Broadcast: Text Only*\n\nPlease enter the message to send:', backBtn('adm_broadcast'));
            }

            if (data === 'adm_bc_type_image') {
                state[chatId] = { step: 'bc_image_input', type: 'image' };
                return editMsg(chatId, msgId, '🖼️ *Broadcast: Image Only*\n\nPlease upload or send the image:', backBtn('adm_broadcast'));
            }

            if (data === 'adm_bc_type_both') {
                state[chatId] = { step: 'bc_image_input', type: 'both' };
                return editMsg(chatId, msgId, '🖼️ *Broadcast: Image & Text*\n\nFirst, please upload or send the image:', backBtn('adm_broadcast'));
            }

            if (data === 'adm_bc_toggle_play') {
                if (state[chatId] && state[chatId].step === 'broadcast_preview') {
                    state[chatId].attachPlay = !state[chatId].attachPlay;
                    return renderBroadcastPreview(chatId, msgId, state[chatId]);
                }
            }

            if (data === 'adm_bc_toggle_invite') {
                if (state[chatId] && state[chatId].step === 'broadcast_preview') {
                    state[chatId].attachInvite = !state[chatId].attachInvite;
                    return renderBroadcastPreview(chatId, msgId, state[chatId]);
                }
            }

            if (data === 'adm_bc_send') {
                if (state[chatId] && state[chatId].step === 'broadcast_preview') {
                    const st = state[chatId];
                    delete state[chatId];
                    return executeBroadcast(chatId, msgId, st);
                }
            }

            // ════════════════════════════════════════════════════════════════════
            // 👑 ADMIN MANAGEMENT
            // ════════════════════════════════════════════════════════════════════
            if (data === 'adm_admins') {
                const res = await db.query('SELECT chat_id, username FROM admins ORDER BY created_at');
                const lines = res.rows.map((a, i) =>
                    `${i + 1}. \`${esc(a.chat_id)}\` ${a.username ? '@' + esc(a.username) : ''}`
                ).join('\n');
                return editMsg(chatId, msgId,
                    `👑 *Admin List* (${res.rows.length})\n\n${lines || 'None'}\n\n` +
                    `Click buttons below or use commands:\n/addadmin <id>\n/removeadmin <id>`,
                    {
                        inline_keyboard: [
                            [{ text: '➕ Add Admin', callback_data: 'adm_admin_add' },
                            { text: '➖ Remove Admin', callback_data: 'adm_admin_remove' }],
                            [{ text: '🔙 Main Menu', callback_data: 'adm_back' }]
                        ]
                    }
                );
            }

            if (data === 'adm_admin_add') {
                state[chatId] = { step: 'add_admin_id' };
                return editMsg(chatId, msgId, '➕ *Add Admin*\n\nPlease enter the Telegram User ID of the new admin:', backBtn('adm_admins'));
            }

            if (data === 'adm_admin_remove') {
                state[chatId] = { step: 'remove_admin_id' };
                return editMsg(chatId, msgId, '➖ *Remove Admin*\n\nPlease enter the Telegram User ID you want to remove:', backBtn('adm_admins'));
            }

            // ════════════════════════════════════════════════════════════════════
            // 📊 STATS
            // ════════════════════════════════════════════════════════════════════
            if (data === 'adm_stats') {
                return handleStats(chatId, msgId);
            }

            if (data === 'adm_money') {
                return showMoneyStats(chatId, msgId, 0);
            }

            if (data.startsWith('adm_money_p_')) {
                const page = parseInt(data.replace('adm_money_p_', ''), 10);
                return showMoneyStats(chatId, msgId, page);
            }

            if (data === 'adm_logs') {
                return showLogs(chatId, msgId, 0);
            }

            if (data.startsWith('adm_logs_p_')) {
                const page = parseInt(data.replace('adm_logs_p_', ''), 10);
                return showLogs(chatId, msgId, page);
            }

            if (data === 'adm_search') {
                return bot.editMessageText('🔍 *Search & Investigation*\n\nChoose search criteria:', {
                    chat_id: chatId, message_id: msgId, parse_mode: 'Markdown',
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '📱 By Phone', callback_data: 'adm_search_phone' }, { text: '👤 By Username', callback_data: 'adm_search_user' }],
                            [{ text: '🔖 By TXID', callback_data: 'adm_search_txid' }, { text: '🪪 By Chat ID', callback_data: 'adm_search_chatid' }],
                            [{ text: '📛 By Name', callback_data: 'adm_search_name' }],
                            [{ text: '🔙 Back', callback_data: 'adm_back' }]
                        ]
                    }
                });
            }

            if (data === 'adm_search_phone') {
                state[chatId] = { step: 'search_phone' };
                return bot.editMessageText('📱 Enter the *phone number* to search (last 9 digits are enough):', {
                    chat_id: chatId, message_id: msgId, parse_mode: 'Markdown',
                    reply_markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'adm_search' }]] }
                });
            }

            if (data === 'adm_search_user') {
                state[chatId] = { step: 'search_username' };
                return bot.editMessageText('👤 Enter the *username* to search:', {
                    chat_id: chatId, message_id: msgId, parse_mode: 'Markdown',
                    reply_markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'adm_search' }]] }
                });
            }

            if (data === 'adm_search_txid') {
                state[chatId] = { step: 'search_txid' };
                return bot.editMessageText('🔖 Enter the *Transaction ID* to search:', {
                    chat_id: chatId, message_id: msgId, parse_mode: 'Markdown',
                    reply_markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'adm_search' }]] }
                });
            }

            if (data === 'adm_search_chatid') {
                state[chatId] = { step: 'search_chatid' };
                return bot.editMessageText('🪪 Enter the *Telegram Chat ID* to search:', {
                    chat_id: chatId, message_id: msgId, parse_mode: 'Markdown',
                    reply_markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'adm_search' }]] }
                });
            }

            if (data === 'adm_search_name') {
                state[chatId] = { step: 'search_name' };
                return bot.editMessageText('📛 Enter the *Telegram name* to search (first or last name):', {
                    chat_id: chatId, message_id: msgId, parse_mode: 'Markdown',
                    reply_markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'adm_search' }]] }
                });
            }

            // ─── Freezing Users ───
            if (data.startsWith('adm_freeze_') || data.startsWith('adm_unfreeze_')) {
                const userId = data.split('_')[2];
                const doFreeze = data.startsWith('adm_freeze_');
                await db.query('UPDATE users SET is_frozen = $1 WHERE chat_id = $2', [doFreeze, userId]);
                await log(chatId, doFreeze ? 'FREEZE_USER' : 'UNFREEZE_USER', userId, `Admin ${chatId} ${doFreeze ? 'froze' : 'unfroze'} user`);
                bot.answerCallbackQuery(query.id, { text: `User ${doFreeze ? 'Frozen' : 'Unfrozen'}` });
                return showUserDetail(chatId, msgId, userId);
            }

            if (data === 'adm_verify') {
                return verifyIntegrity(chatId, msgId);
            }

            // ─── Templates Handlers ───
            if (data === 'adm_templates') {
                const res = await db.query('SELECT key FROM message_templates ORDER BY key');
                const kb = res.rows.map(r => [{ text: `Edit ${r.key}`, callback_data: `adm_tpl_edit_${r.key}` }]);
                return editMsg(chatId, msgId, '✍️ *Message Templates*\n\nSelect a template to modify:', {
                    inline_keyboard: [...kb, [{ text: '🔙 Back', callback_data: 'adm_settings' }]]
                });
            }

            if (data === 'adm_wd_list') {
                state[chatId] = { step: 'view_withdrawals' };
                return showPendingWithdrawals(chatId, msgId);
            }

            if (data.startsWith('adm_tpl_edit_')) {
                const key = data.replace('adm_tpl_edit_', '');
                const res = await db.query('SELECT template FROM message_templates WHERE key = $1', [key]);
                const tpl = res.rows[0]?.template || '(No custom template set)';
                state[chatId] = { step: 'tpl_update', targetId: key };
                return editMsg(chatId, msgId, `✍️ *Editing Template: ${key}*\n\n*Current:* \n\`${tpl}\`\n\nType the new message below:`, {
                    reply_markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'adm_templates' }]] }
                });
            }

            // ─── Emergency Handlers ───
            if (data === 'adm_emergency') {
                if (!await isSuperAdmin(chatId)) return bot.answerCallbackQuery(query.id, { text: '⛔ Super Admin only!' });
                const kd = (settings.kill_deposits === true || settings.kill_deposits === 'true');
                const kw = (settings.kill_withdrawals === true || settings.kill_withdrawals === 'true');
                const kg = (settings.kill_games === true || settings.kill_games === 'true');

                return editMsg(chatId, msgId,
                    `🚨 *Emergency Controls (Kill-switches)*\n\n` +
                    `Use these to instantly stop specific system features. Red means STOPPED.`,
                    {
                        inline_keyboard: [
                            [{ text: (kd ? '🟢 Enable Deposits' : '🔴 KILL DEPOSITS'), callback_data: 'adm_kill_dep_toggle' }],
                            [{ text: (kw ? '🟢 Enable Withdrawals' : '🔴 KILL WITHDRAWALS'), callback_data: 'adm_kill_wd_toggle' }],
                            [{ text: (kg ? '🟢 Enable Games' : '🔴 KILL GAMES'), callback_data: 'adm_kill_game_toggle' }],
                            [{ text: '🔙 Back', callback_data: 'adm_settings' }]
                        ]
                    }
                );
            }

            if (data.startsWith('adm_kill_')) {
                const key = data === 'adm_kill_dep_toggle' ? 'kill_deposits' :
                    data === 'adm_kill_wd_toggle' ? 'kill_withdrawals' : 'kill_games';
                const current = (settings[key] === true || settings[key] === 'true');
                const newVal = current ? 'false' : 'true';
                await saveSetting(key, newVal);
                await log(chatId, 'emergency_kill_toggle', key, newVal);
                bot.answerCallbackQuery(query.id, { text: `Emergency ${key} is now ${newVal === 'true' ? 'ON' : 'OFF'}` });
                return editMsg(chatId, msgId, 'Action completed.', { inline_keyboard: [[{ text: '🔙 Back', callback_data: 'adm_emergency' }]] });
            }

            if (data === 'adm_health') {
                return showSystemHealth(chatId, msgId);
            }

            // ════════════════════════════════════════════════════════════════════
            // 🤖 ROBOTS
            // ════════════════════════════════════════════════════════════════════

            if (data === 'adm_toggle_robot_win') {
                try {
                    const current = settings.robots_always_win === true || settings.robots_always_win === 'true';
                    const newVal = current ? 'false' : 'true';
                    await saveSetting('robots_always_win', newVal);
                    bot.answerCallbackQuery(query.id, {
                        text: `🎲 Always Win ${newVal === 'true' ? 'ENABLED — robots will win every round' : 'DISABLED'}`,
                        show_alert: true
                    });
                    delete state[chatId];
                    const permsMenu = await getAdminPermissions(chatId);
                    return bot.editMessageReplyMarkup(mainMenu(permsMenu), { chat_id: chatId, message_id: msgId });
                } catch (err) {
                    console.error('[Robot Win Toggle]', err);
                    return bot.answerCallbackQuery(query.id, { text: '❌ Failed to toggle.', show_alert: true });
                }
            }

            if (data === 'adm_robots') {
                const currentCount = gameState.getRobotCount ? gameState.getRobotCount() : 0;
                const statusIcon = currentCount > 0 ? '🟢' : '🔴';
                const statusText = currentCount > 0 ? `Active — ${currentCount} robots per game` : 'Disabled (count is 0)';
                const winRes = await db.query("SELECT value FROM system_settings WHERE key = 'robots_always_win'");
                const isWinOn = winRes.rows.length > 0 && winRes.rows[0].value === 'true';
                const winLabel = isWinOn ? '🎲 Always Win: ✅ ON' : '🎲 Always Win: ❌ OFF';
                return editMsg(chatId, msgId,
                    `🤖 *Robot Players*\n\n` +
                    `Status: ${statusIcon} *${statusText}*\n` +
                    `Always Win: ${isWinOn ? '✅ *ON* — robots will win every round' : '❌ *OFF* — fair play'}\n\n` +
                    `Robots join slowly during lobby (random delays up to 38s).\n` +
                    `They auto-claim bingo and persist every game.\n` +
                    `Names cycle through *80* preset Ethiopian names.\n` +
                    `Each robot has a *constant* phone number (never changes).\n` +
                    `If count > 80, names/phones repeat from the top.\n\n` +
                    `Set count to *0* to disable robots.`,
                    {
                        inline_keyboard: [
                            [{ text: '🔢 Set Robot Count', callback_data: 'adm_set_robots' }],
                            [{ text: winLabel, callback_data: 'adm_toggle_robot_win' }],
                            [{ text: '🔙 Main Menu', callback_data: 'adm_back' }]
                        ]
                    }
                );
            }

            if (data === 'adm_set_robots') {
                state[chatId] = { step: 'set_robot_count' };
                const currentCount = gameState.getRobotCount ? gameState.getRobotCount() : 0;
                return editMsg(chatId, msgId,
                    `🤖 *Set Robot Count*\n\nCurrent: *${currentCount}* robots\n\nEnter the number of robots to add per game.\nEnter *0* to disable robots.\n\n_Names cycle through 80 preset Ethiopian names.\nEach robot keeps the same phone number every round._`,
                    { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'adm_robots' }]] }
                );
            }

            // ─── D/W Management ───
            if (data === 'adm_dw_methods') return showDwMethodsMenu(chatId, msgId);
            if (data === 'adm_dw_dep_menu') return showDwDepMenu(chatId, msgId);
            if (data === 'adm_dw_wd_menu') return showDwWdMenu(chatId, msgId);
            if (data === 'adm_dw_change_acc_menu') return showDwChangeAccMenu(chatId, msgId);

            if (data.startsWith('adm_dw_toggle_')) {
                const remainder = data.replace('adm_dw_toggle_', '');
                const underIdx = remainder.indexOf('_');
                const type   = remainder.slice(0, underIdx);   // 'dep' or 'wd'
                const method = remainder.slice(underIdx + 1);  // 'cbebirr', 'telebirr', etc.
                const key    = `${type}_${method}_active`;
                const current = settings[key] !== false && settings[key] !== 'false';
                await saveSetting(key, !current);
                await log(fromId, 'toggle_dw_method', key, String(!current));
                return type === 'dep' ? showDwDepMenu(chatId, msgId) : showDwWdMenu(chatId, msgId);
            }

            if (data.startsWith('adm_dw_edit_acc_')) {
                const method = data.replace('adm_dw_edit_acc_', '');
                state[chatId] = { step: 'edit_acc_name', method };
                return editMsg(chatId, msgId, `📝 *Editing ${method.toUpperCase()} Details*\n\nPlease enter the *Account Name* for this method:`, { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'adm_dw_change_acc_menu' }]] });
            }

            // ─── User Removal Confirmation ───
            if (data.startsWith('adm_user_remove_')) {
                const uid = data.replace('adm_user_remove_', '');
                return editMsg(chatId, msgId,
                    `⚠️ *Remove User Confirmation*\n\nAre you sure you want to remove user \`${uid}\`?\nThis will delete the user account but preserve transaction history.`,
                    {
                        inline_keyboard: [
                            [{ text: '✅ Yes, Remove', callback_data: `adm_user_confirm_remove_${uid}` },
                            { text: '❌ No, Cancel', callback_data: `adm_user_view_${uid}` }]
                        ]
                    }
                );
            }

            if (data.startsWith('adm_user_confirm_remove_')) {
                const uid = data.replace('adm_user_confirm_remove_', '');
                try {
                    // Start updates to preserve records: set chat_id to NULL
                    await db.query('UPDATE deposits SET chat_id = NULL WHERE chat_id = $1', [uid]);
                    await db.query('UPDATE withdrawals SET chat_id = NULL WHERE chat_id = $1', [uid]);
                    await db.query('UPDATE agent_earnings SET user_id = NULL WHERE user_id = $1', [uid]);
                    // Finally delete user
                    await db.query('DELETE FROM users WHERE chat_id = $1', [uid]);

                    await log(fromId, 'remove_user', uid);
                    bot.answerCallbackQuery(query.id, { text: 'User removed successfully.' });
                    return showUserList(chatId, msgId, 0);
                } catch (err) {
                    console.error('[AdminBot] Error removing user:', err);
                    return bot.sendMessage(chatId, '❌ Error removing user.');
                }
            }

            // ─── Withdrawal History ───
            if (data === 'adm_wd_history') {
                return showCompletedWithdrawalsHistory(chatId, msgId, 0);
            }

            if (data.startsWith('adm_wd_hist_p_')) {
                const page = parseInt(data.replace('adm_wd_hist_p_', ''), 10);
                return showCompletedWithdrawalsHistory(chatId, msgId, page);
            }

            if (data === 'adm_top_winners') {
                return showTopWinners(chatId, msgId);
            }

            if (data === 'adm_game_history') {
                return showAdminGameHistory(chatId, msgId);
            }

            // ── Set Forced Winners (Next Round) ──
            if (data === 'adm_set_forced_winners') {
                const currentForced = gameState.getForcedWinners ? gameState.getForcedWinners() : [];
                const currentText = currentForced.length > 0
                    ? `Currently queued: *${currentForced.join(', ')}*`
                    : `None currently queued.`;
                state[chatId] = { step: 'waiting_for_forced_winners' };
                return editMsg(
                    chatId,
                    msgId,
                    `🏆 *Set Forced Winners (Next Round)*\n\n` +
                    `${currentText}\n\n` +
                    `Enter 1–4 card numbers (1–500), separated by commas or spaces.\n\n` +
                    `_Example: \`12, 157, 280\`_\n\n` +
                    `⚠️ This will only apply for ONE round, then auto-clears.`,
                    { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'adm_game_monitor' }]] }
                );
            }

            if (data.startsWith('adm_user_msg_')) {
                const uid = data.replace('adm_user_msg_', '');
                state[chatId] = { step: 'user_msg_input', targetId: uid };
                return editMsg(chatId, msgId, `💬 *Direct Message to User \`${uid}\`*\n\nType your message below. It will be sent to the user immediately.`, backBtn(`adm_user_view_${uid}`));
            }

            // Fallback: ensure every callback query gets answered to clear the spinner
            answerQuery();

        } catch (err) {
            console.error('[AdminBot] callback_query error:', err.message);
            try { bot.answerCallbackQuery(query.id, { text: '⚠️ Error: ' + err.message.slice(0, 100), show_alert: true }); } catch (_) { }
            try { bot.sendMessage(query.message.chat.id, '⚠️ An error occurred. Please try again.'); } catch (_) { }
        }
    });

    // ─── Text message state machine ───────────────────────────────────────────────
    bot.on('message', async msg => {
        const chatId = msg.chat.id;
        const st = state[chatId];

        // Allow photos if in bc_image_input step
        const isPhotoInput = st && st.step === 'bc_image_input' && msg.photo;

        if (!isPhotoInput && (!msg.text || msg.text.startsWith('/'))) return;
        const perms = await getAdminPermissions(chatId);
        if (!hasPerm(perms, 'all') && !await isAdmin(chatId).catch(() => false)) return;

        if (!st) return;
        const input = (msg.text || '').trim();

        // ── TX verifier input ──
        if (st.step === 'tx_verify_input') {
            delete state[chatId];
            return handleTxVerify(chatId, input);
        }

        // -- Edit Account Name --
        if (st.step === 'edit_acc_name') {
            const method = st.method;
            state[chatId] = { step: 'edit_acc_no', method, name: input };
            return bot.sendMessage(chatId, `Name saved: *${input}*\n\n💳 Please enter the *Account Number* for ${method.toUpperCase()}:`, { parse_mode: 'Markdown' });
        }

        // -- Edit Account Number --
        if (st.step === 'edit_acc_no') {
            const method = st.method;
            const name = st.name;
            delete state[chatId];
            saveSetting(`dep_${method}_acc_name`, name);
            saveSetting(`dep_${method}_acc_no`, input);
            bot.sendMessage(chatId, `✅ *Successfully changed account details!*\nThe ${method.toUpperCase()} deposit account is changed for users to deposit.`, { parse_mode: 'Markdown' });
            return showDwChangeAccMenu(chatId, null);
        }

        // ── Balance adjustment ──
        if (st.step === 'balance_amount') {
            const amount = parseFloat(input);
            if (isNaN(amount) || amount < 0) {
                return bot.sendMessage(chatId, '❌ Invalid amount. Enter a positive number:');
            }
            const uid = st.targetId;
            const isAgent = st.targetType === 'agent';
            const table = isAgent ? 'agents' : 'users';
            const balanceCol = 'balance';
            const idCol = isAgent ? 'chat_id' : 'chat_id'; // Both use chat_id

            let newBalance;
            try {
                let res;
                if (st.action === 'add') {
                    res = await db.query(`UPDATE ${table} SET balance = balance + $1 WHERE chat_id = $2 RETURNING balance`, [amount, uid]);
                    await log(chatId, `add_balance_${st.targetType}`, uid, `+${amount}`);
                } else if (st.action === 'deduct') {
                    res = await db.query(`UPDATE ${table} SET balance = GREATEST(balance - $1, 0) WHERE chat_id = $2 RETURNING balance`, [amount, uid]);
                    await log(chatId, `deduct_balance_${st.targetType}`, uid, `-${amount}`);
                } else { // set
                    res = await db.query(`UPDATE ${table} SET balance = $1 WHERE chat_id = $2 RETURNING balance`, [amount, uid]);
                    await log(chatId, `set_balance_${st.targetType}`, uid, `=${amount}`);
                }
                newBalance = res.rows[0]?.balance ?? '?';
            } catch (err) {
                console.error(`[AdminBot] ${st.targetType} balance update error:`, err);
                delete state[chatId];
                return bot.sendMessage(chatId, `⚠️ Error updating ${st.targetType} balance.`);
            }
            delete state[chatId];
            const txPrefix = isAgent ? 'AGB' : 'ADM';
            const txId = txPrefix + Math.random().toString(36).substring(2, 10).toUpperCase();

            const targetBot = isAgent ? agentBot : bingoBot;
            if (targetBot) {
                let msgText = '';
                const formatLabel = st.targetType.charAt(0).toUpperCase() + st.targetType.slice(1);

                if (st.action === 'add') {
                    msgText = `✅ *Deposit Successful!*\n\n` +
                        `💰 Amount: *${amount.toFixed(2)} ETB*\n` +
                        `🆔 TX ID: \`${txId}\`\n` +
                        `Admin has credited funds to your account.`;
                } else if (st.action === 'deduct') {
                    msgText = `💸 *Balance Deducted*\n\n` +
                        `💰 Amount: *${amount.toFixed(2)} ETB*\n` +
                        `🆔 TX ID: \`${txId}\`\n` +
                        `Admin has deducted funds from your account.`;
                } else {
                    msgText = `⚙️ *Balance Updated*\n\n` +
                        `🆔 TX ID: \`${txId}\`\n` +
                        `Admin has set or adjusted your balance.`;
                }

                msgText += `\n\nYour new balance: *${parseFloat(newBalance).toFixed(2)} ETB*`;
                msgText += `\n🕐 Date: ${new Date().toLocaleString()}`;

                targetBot.sendMessage(uid, msgText, { parse_mode: 'Markdown' }).catch(err => {
                    console.error(`[AdminBot] Failed to send notification to ${st.targetType} ${uid}:`, err.message);
                });
            } else {
                console.warn(`[AdminBot] No bot instance found to notify ${st.targetType} ${uid}. Check tokens.`);
            }
            const perms = await getAdminPermissions(chatId);
            return bot.sendMessage(chatId,
                `✅ Balance updated for ${st.targetType} \`${uid}\`.\n\nNew balance: *${parseFloat(newBalance).toFixed(2)} ETB*\nTX ID: \`${txId}\``,
                { parse_mode: 'Markdown', reply_markup: mainMenu(perms) }
            );
        }

        // ── Bonus balance adjustment ──
        if (st.step === 'bonus_balance_amount') {
            const amount = parseFloat(input);
            if (isNaN(amount) || amount < 0) {
                return bot.sendMessage(chatId, '❌ Invalid amount. Enter a positive number:');
            }
            const uid = st.targetId;
            let newBonusBalance;
            try {
                let res;
                if (st.action === 'add') {
                    res = await db.query(`UPDATE users SET bonus_balance = COALESCE(bonus_balance, 0) + $1 WHERE chat_id = $2 RETURNING bonus_balance`, [amount, uid]);
                    await log(chatId, `add_bonus_user`, uid, `+${amount}`);
                } else { // deduct
                    res = await db.query(`UPDATE users SET bonus_balance = GREATEST(COALESCE(bonus_balance, 0) - $1, 0) WHERE chat_id = $2 RETURNING bonus_balance`, [amount, uid]);
                    await log(chatId, `deduct_bonus_user`, uid, `-${amount}`);
                }
                newBonusBalance = res.rows[0]?.bonus_balance ?? 0;
            } catch (err) {
                console.error(`[AdminBot] User bonus balance update error:`, err);
                delete state[chatId];
                return bot.sendMessage(chatId, `⚠️ Error updating user bonus balance.`);
            }
            delete state[chatId];

            if (bingoBot) {
                const notifyMsg = st.action === 'add'
                    ? `🎁 *Bonus Credited!*\n\nJust credited bonus balance *${amount.toFixed(2)} ETB*`
                    : `💸 *Bonus Deducted*\n\nJust deducted bonus balance *${amount.toFixed(2)} ETB*`;

                bingoBot.sendMessage(uid, notifyMsg + `\nNew bonus balance: *${parseFloat(newBonusBalance).toFixed(2)} ETB*`, { parse_mode: 'Markdown' }).catch(() => { });
            }

            const perms = await getAdminPermissions(chatId);
            return bot.sendMessage(chatId,
                `✅ Bonus balance updated for user \`${uid}\`.\n\nNew bonus balance: *${parseFloat(newBonusBalance).toFixed(2)} ETB*`,
                { parse_mode: 'Markdown', reply_markup: mainMenu(perms) }
            );
        }

        // ── Fix deposit: user lookup ──
        if (st.step === 'fix_dep_uid') {
            const search = input;
            const res = await db.query(
                'SELECT chat_id, first_name, username, balance, phone_number FROM users WHERE phone_number = $1 OR username ILIKE $2 OR CAST(chat_id AS TEXT) = $3',
                [search, search.replace(/^@/, ''), search]
            );
            if (!res.rows.length) {
                return bot.sendMessage(chatId, `❌ User not found: \`${search}\`\n\nTry again:`, { parse_mode: 'Markdown' });
            }
            const u = res.rows[0];
            state[chatId] = { step: 'fix_dep_amount', targetId: u.chat_id };
            return bot.sendMessage(chatId,
                `👤 Found: *${u.first_name || ''}* ${u.username ? '@' + u.username : ''}\n💰 Balance: *${u.balance} ETB*\n\nEnter amount to add:`,
                { parse_mode: 'Markdown' }
            );
        }

        if (st.step === 'fix_dep_amount') {
            const amount = parseFloat(input);
            if (isNaN(amount) || amount <= 0) return bot.sendMessage(chatId, '❌ Invalid amount. Enter a positive number:');
            const uid = st.targetId;
            const res = await db.query('UPDATE users SET balance = balance + $1 WHERE chat_id = $2 RETURNING balance', [amount, uid]);
            await log(chatId, 'fix_deposit', uid, `+${amount}`);
            delete state[chatId];
            const txId = 'FIX' + Math.random().toString(36).substring(2, 10).toUpperCase();
            if (bingoBot) {
                const msgText = `✅ *Deposit Successful!*\n\n` +
                    `💰 Amount: *${amount.toFixed(2)} ETB*\n` +
                    `🆔 TX ID: \`${txId}\`\n` +
                    `Admin has credited funds to your account.\n\n` +
                    `Your new balance: *${parseFloat(res.rows[0]?.balance).toFixed(2)} ETB*\n` +
                    `🕐 Date: ${new Date().toLocaleString()}`;

                bingoBot.sendMessage(uid, msgText, { parse_mode: 'Markdown' }).catch(err => {
                    console.error(`[AdminBot] Failed to send fix_deposit notification to ${uid}:`, err.message);
                });
            } else {
                console.warn(`[AdminBot] No bingoBot instance found to notify user ${uid}. Check BOT_TOKEN.`);
            }
            const perms = await getAdminPermissions(chatId);
            return bot.sendMessage(chatId, `✅ Added *${amount} ETB* to user \`${uid}\`.\nTX ID: \`${txId}\``, { parse_mode: 'Markdown', reply_markup: mainMenu(perms) });
        }

        // ── Direct message to user ──
        if (st.step === 'user_msg_input') {
            const uid = st.targetId;
            const text = input;
            delete state[chatId];
            if (bingoBot) {
                try {
                    await bingoBot.sendMessage(uid, text, { parse_mode: 'Markdown' });
                    await log(chatId, 'send_user_msg', uid, text.slice(0, 100));
                    bot.sendMessage(chatId, `✅ Message sent to user \`${uid}\`.`, { parse_mode: 'Markdown' });
                    return showUserDetail(chatId, null, uid);
                } catch (e) {
                    return bot.sendMessage(chatId, `❌ Failed to send message: ${e.message}`);
                }
            } else {
                return bot.sendMessage(chatId, '❌ Bingo Bot instance not available.');
            }
        }

        // ── Broadcast text input ──
        if (st.step === 'bc_text_input') {
            state[chatId] = { ...st, step: 'broadcast_preview', text: input, attachPlay: false, attachInvite: false };
            return renderBroadcastPreview(chatId, null, state[chatId]);
        }

        // ── Broadcast image input ──
        if (st.step === 'bc_image_input') {
            let photoId = null;
            if (msg.photo && msg.photo.length > 0) {
                // Get the largest photo
                photoId = msg.photo[msg.photo.length - 1].file_id;
            } else {
                return bot.sendMessage(chatId, '❌ Please send an image.');
            }

            // Store file_id directly — works for preview (same bot), buffer-download at send time
            if (st.type === 'both') {
                state[chatId] = { step: 'bc_text_input', image: photoId, type: 'both' };
                return bot.sendMessage(chatId, '🖼️ Image received! Now please enter the *caption* text for this image:', { parse_mode: 'Markdown' });
            } else {
                state[chatId] = { step: 'broadcast_preview', image: photoId, type: 'image', attachPlay: false, attachInvite: false };
                return renderBroadcastPreview(chatId, null, state[chatId]);
            }
        }

        // ── Add Admin ID input ──
        if (st.step === 'add_admin_id') {
            const targetId = input;
            if (!/^\d+$/.test(targetId)) return bot.sendMessage(chatId, '❌ Invalid ID. Please enter a numeric Telegram ID:');
            delete state[chatId];
            await db.query(
                'INSERT INTO admins (chat_id, username, added_by) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
                [targetId, '', chatId]
            );
            await log(chatId, 'add_admin', targetId);
            const perms = await getAdminPermissions(chatId);
            bot.sendMessage(chatId, `✅ Admin \`${targetId}\` added.`, { parse_mode: 'Markdown', reply_markup: mainMenu(perms) });
            if (bingoBot) {
                bingoBot.sendMessage(targetId, `🛠️ You have been added as a Smart Bingo Admin!\n\nSend /start to @${ADMIN_BOT_USERNAME} to open the panel.`).catch(() => { });
            } else {
                bot.sendMessage(targetId, `🛠️ You have been added as a Smart Bingo Admin!\n\nSend /start to @${ADMIN_BOT_USERNAME} to open the panel.`).catch(() => { });
            }
            return;
        }

        // ── Remove Admin ID input ──
        if (st.step === 'remove_admin_id') {
            const targetId = input;
            if (!/^\d+$/.test(targetId)) return bot.sendMessage(chatId, '❌ Invalid ID. Please enter a numeric Telegram ID:');
            if (String(targetId) === String(SEED_ADMIN_ID)) {
                delete state[chatId];
                const perms = await getAdminPermissions(chatId);
                return bot.sendMessage(chatId, '⛔ Cannot remove root admin.', { reply_markup: mainMenu(perms) });
            }
            delete state[chatId];
            await db.query('DELETE FROM admins WHERE chat_id = $1', [targetId]);
            await log(chatId, 'remove_admin', targetId);
            const perms = await getAdminPermissions(chatId);
            return bot.sendMessage(chatId, `✅ Admin \`${targetId}\` removed.`, { parse_mode: 'Markdown', reply_markup: mainMenu(perms) });
        }

        // ── Limit Handlers ──
        if (st.step === 'set_stake') {
            updateStake(chatId, null, input);
            delete state[chatId];
            return;
        }

        if (st.step === 'tpl_update') {
            const key = st.targetId;
            await db.query('INSERT INTO message_templates (key, template) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET template = $2', [key, input]);
            await log(chatId, 'update_template', key, input.slice(0, 50));
            delete state[chatId];
            bot.sendMessage(chatId, `✅ Template \`${key}\` updated!`, { parse_mode: 'Markdown' });
            return showSettings(chatId, null);
        }

        // ── Search Handlers ──
        if (st.step === 'search_phone') {
            delete state[chatId];
            const res = await db.query('SELECT chat_id FROM users WHERE phone_number LIKE $1', ['%' + input.slice(-9)]);
            if (!res.rows.length) return bot.sendMessage(chatId, `❌ No user found with phone matching: \`${input}\``, { parse_mode: 'Markdown', reply_markup: mainMenu(perms) });
            return showUserDetail(chatId, null, res.rows[0].chat_id);
        }

        if (st.step === 'search_username') {
            delete state[chatId];
            const cleanUser = input.replace(/^@/, '');
            const res = await db.query('SELECT chat_id FROM users WHERE username ILIKE $1', [cleanUser]);
            if (!res.rows.length) return bot.sendMessage(chatId, `❌ No user found with username: \`${input}\``, { parse_mode: 'Markdown', reply_markup: mainMenu(perms) });
            return showUserDetail(chatId, null, res.rows[0].chat_id);
        }

        if (st.step === 'search_txid') {
            delete state[chatId];
            const res = await db.query('SELECT chat_id, tx_id FROM deposits WHERE tx_id ILIKE $1', [input]);
            if (!res.rows.length) return bot.sendMessage(chatId, `❌ Transaction \`${esc(input)}\` not found.`, { parse_mode: 'Markdown', reply_markup: mainMenu(perms) });
            return showUserDetail(chatId, null, res.rows[0].chat_id);
        }

        if (st.step === 'search_chatid') {
            delete state[chatId];
            const cleanId = input.trim().replace(/^@/, '');
            if (!/^\d+$/.test(cleanId)) return bot.sendMessage(chatId, `❌ Invalid Chat ID. Must be a number.`, { parse_mode: 'Markdown', reply_markup: mainMenu(perms) });
            const res = await db.query('SELECT chat_id FROM users WHERE chat_id = $1', [cleanId]);
            if (!res.rows.length) return bot.sendMessage(chatId, `❌ No user found with Chat ID: \`${esc(cleanId)}\``, { parse_mode: 'Markdown', reply_markup: mainMenu(perms) });
            return showUserDetail(chatId, null, res.rows[0].chat_id);
        }

        if (st.step === 'search_name') {
            delete state[chatId];
            const term = '%' + input.trim() + '%';
            const res = await db.query(
                `SELECT chat_id, first_name, last_name FROM users
                 WHERE first_name ILIKE $1 OR last_name ILIKE $1
                 ORDER BY first_name LIMIT 10`,
                [term]
            );
            if (!res.rows.length) return bot.sendMessage(chatId, `❌ No user found with name matching: \`${esc(input)}\``, { parse_mode: 'Markdown', reply_markup: mainMenu(perms) });
            if (res.rows.length === 1) return showUserDetail(chatId, null, res.rows[0].chat_id);
            // Multiple matches — show a pick list
            const kb = res.rows.map(u => [{
                text: `${u.first_name || ''} ${u.last_name || ''} (${u.chat_id})`.trim(),
                callback_data: `adm_user_view_${u.chat_id}`
            }]);
            kb.push([{ text: '🔙 Back to Search', callback_data: 'adm_search' }]);
            return bot.sendMessage(chatId,
                `📛 *${res.rows.length} users found* matching "${esc(input)}":\n\nSelect one:`,
                { parse_mode: 'Markdown', reply_markup: { inline_keyboard: kb } }
            );
        }

        // ── Limit update handlers ──
        const limitSteps = {
            'limit_min_deposit': 'min_deposit',
            'limit_max_deposit': 'max_deposit',
            'limit_min_withdrawal': 'min_withdrawal',
            'limit_max_withdrawal': 'max_withdrawal'
        };

        if (limitSteps[st.step]) {
            const key = limitSteps[st.step];
            const val = parseFloat(input);
            if (isNaN(val) || val < 0) return bot.sendMessage(chatId, '❌ Invalid amount. Enter a positive number:');

            await saveSetting(key, val);
            await log(chatId, 'update_limit', key, val);
            delete state[chatId];

            bot.sendMessage(chatId, `✅ *${key.replace('_', ' ').toUpperCase()}* updated to *${val} ETB*`, { parse_mode: 'Markdown' });
            return showSettings(chatId, null);
        }

        const bonusSteps = {
            'bonus_welcome': 'welcome_bonus',
            'bonus_inviter': 'inviter_bonus',
        };

        if (bonusSteps[st.step]) {
            const key = bonusSteps[st.step];
            let val = 0;
            if (input.toLowerCase() !== 'none') {
                val = parseFloat(input);
                if (isNaN(val) || val < 0) return bot.sendMessage(chatId, '❌ Invalid amount. Enter a positive number or "none":');
            }

            await saveSetting(key, val);
            await log(chatId, 'update_bonus', key, val);
            delete state[chatId];

            bot.sendMessage(chatId, `✅ *${key.replace('_', ' ').toUpperCase()}* updated to *${val} ETB*`, { parse_mode: 'Markdown' });
            return showBonusSettings(chatId, null);
        }

        // ── Winner Bonus (one-time) ──
        if (st.step === 'bonus_winner') {
            let val = 0;
            if (input.toLowerCase() !== 'none') {
                val = parseFloat(input);
                if (isNaN(val) || val < 0) return bot.sendMessage(chatId, '❌ Invalid amount. Enter a positive number or "none":');
            }
            await saveSetting('winner_bonus', val);
            // Activate only if amount > 0, otherwise deactivate
            await saveSetting('winner_bonus_active', val > 0 ? 'true' : 'false');
            await log(chatId, 'update_bonus', 'winner_bonus', val);
            delete state[chatId];
            const statusMsg = val > 0
                ? `✅ *Winner Bonus* set to *${val} ETB* — 🟢 Active!\n\nThe very next winner will receive this bonus.`
                : `✅ *Winner Bonus* disabled.`;
            bot.sendMessage(chatId, statusMsg, { parse_mode: 'Markdown' });
            return showBonusSettings(chatId, null);
        }

        // ── Deposit Bonus % ──
        if (st.step === 'bonus_deposit') {
            let val = 0;
            if (input.toLowerCase() !== 'none') {
                val = parseFloat(input);
                if (isNaN(val) || val < 0) return bot.sendMessage(chatId, '❌ Invalid percentage. Enter 0-100 or "none":');
            }
            await saveSetting('deposit_bonus_pct', val);
            await log(chatId, 'update_bonus', 'deposit_bonus_pct', val);
            delete state[chatId];
            const statusMsg = val > 0
                ? `✅ *Deposit Bonus* set to *${val}%*\n\nUsers will now receive an extra ${val}% on every deposit.`
                : `✅ *Deposit Bonus* disabled (0%).`;
            bot.sendMessage(chatId, statusMsg, { parse_mode: 'Markdown' });
            return showBonusSettings(chatId, null);
        }

        // ── Forced Winners State ──
        if (st.step === 'waiting_for_forced_winners') {
            const cardIds = input.split(/[\s,]+/).map(id => parseInt(id)).filter(id => !isNaN(id) && id >= 1 && id <= 500);
            if (cardIds.length === 0) {
                return bot.sendMessage(chatId, '❌ Invalid input. Please enter valid card numbers between 1 and 500 (e.g. 12, 157, 280):', {
                    reply_markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'adm_game_monitor' }]] }
                });
            }
            if (cardIds.length > 4) {
                return bot.sendMessage(chatId, '❌ You can only force up to 4 cards at a time. Please try again:', {
                    reply_markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'adm_game_monitor' }]] }
                });
            }
            const untakenCards = cardIds.filter(id => !gameState.takenCards || !gameState.takenCards.has(id));
            if (untakenCards.length > 0) {
                return bot.sendMessage(chatId, `❌ Card(s) ${untakenCards.map(id => `#${id}`).join(', ')} are not currently taken. Please try again:`, {
                    reply_markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'adm_game_monitor' }]] }
                });
            }
            gameState.setForcedWinners(cardIds);
            delete state[chatId];
            const permsForced = await getAdminPermissions(chatId);
            return bot.sendMessage(chatId, `🏆 *Success!* Forced winners set for next round: *${cardIds.map(id => `#${id}`).join(', ')}*.\n\nThis will activate for *one round only* then auto-clears.`, {
                parse_mode: 'Markdown',
                reply_markup: mainMenu(permsForced)
            });
        }

        // ── Robot count ──
        if (st.step === 'set_robot_count') {
            const val = parseInt(input);
            if (isNaN(val) || val < 0) {
                return bot.sendMessage(chatId, '❌ Invalid number. Enter 0 or a positive integer (e.g. 10):');
            }
            delete state[chatId];

            // Persist to DB
            await saveSetting('robot_count', val);
            await log(chatId, 'set_robot_count', '', `count=${val}`);

            // Apply immediately to live game engine
            if (gameState && gameState.setRobotCount) {
                gameState.setRobotCount(val);
            }

            const perms = await getAdminPermissions(chatId);
            const statusMsg = val > 0
                ? `✅ *Robot count set to ${val}*\n\n🤖 From the next board selection, *${val} robot${val !== 1 ? 's' : ''}* will slowly join each game automatically.`
                : `✅ *Robots disabled.*\n\n🔴 No robots will join future games.`;
            return bot.sendMessage(chatId, statusMsg, { parse_mode: 'Markdown', reply_markup: mainMenu(perms) });
        }
    });

    // ─── Section helpers ──────────────────────────────────────────────────────────

    function esc(text) {
        if (!text) return '';
        return text.toString()
            .replace(/_/g, '\\_')
            .replace(/\*/g, '\\*')
            .replace(/\[/g, '\\[')
            .replace(/`/g, '\\`');
    }

    function editMsg(chatId, msgId, text, keyboard) {
        const opts = {
            chat_id: chatId,
            message_id: msgId,
            parse_mode: 'Markdown',
            reply_markup: keyboard
        };

        if (msgId) {
            return bot.editMessageText(text, opts).catch(err => {

                if (
                    err.message?.includes('message is not modified') ||
                    err.message?.includes('message to edit not found')
                ) return;

                // Retry without Markdown if parse failed (e.g. special chars in name)
                if (
                    err.message?.includes('parse entities') ||
                    err.message?.includes('Bad Request')
                ) {
                    return bot.editMessageText(text, {
                        chat_id: chatId,
                        message_id: msgId,
                        reply_markup: keyboard
                    }).catch(() => { });
                }

                console.error('[AdminBot] editMsg error:', err.message);
            });
        }

        return bot.sendMessage(chatId, text, {
            parse_mode: 'Markdown',
            reply_markup: keyboard
        }).catch(() =>
            bot.sendMessage(chatId, text, { reply_markup: keyboard })
        );
    }

    async function askLimit(chatId, msgId, action) {
        const labels = {
            min_deposit: 'Minimum Deposit',
            max_deposit: 'Maximum Deposit',
            min_withdrawal: 'Minimum Withdrawal',
            max_withdrawal: 'Maximum Withdrawal'
        };
        const label = labels[action];
        if (!label) return;
        state[chatId] = { step: `limit_${action}` };
        bot.deleteMessage(chatId, msgId).catch(() => { });
        bot.sendMessage(chatId, `Please enter the new amount for *${label}*:`, {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'adm_settings' }]] }
        });
    }

    async function askBonusLimit(chatId, msgId, action) {
        const labels = {
            welcome: 'Welcome Bonus',
            inviter: 'Inviter Bonus',
            winner: 'Winner Bonus (one-time ETB)',
            deposit: 'Deposit Bonus (%)',
        };
        const label = labels[action];
        if (!label) return;
        state[chatId] = { step: `bonus_${action}` };
        bot.deleteMessage(chatId, msgId).catch(() => { });

        let prompt;
        if (action === 'winner') {
            prompt = `Please enter the *Winner Bonus* amount in ETB (e.g. 50).\n\nThis bonus will be given to the very next winner ONCE, then resets.\nType *0* or "none" to disable.`;
        } else if (action === 'deposit') {
            prompt = `Please enter the *Deposit Bonus %* (e.g. 10 for 10%).\n\nUsers will receive extra % on every deposit.\nType *0* or "none" to disable.`;
        } else {
            prompt = `Please enter the new amount for *${label}* (or type "none"):`;
        }

        bot.sendMessage(chatId, prompt, {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'adm_bonus_settings' }]] }
        });
    }

    // ── Users ──
    async function showUserList(chatId, msgId, page = 0) {
        const PAGE = 10;
        const countRes = await db.query('SELECT COUNT(*) AS count FROM users');
        const total = parseInt(countRes.rows[0].count, 10);
        const res = await db.query(
            'SELECT chat_id, first_name, username, phone_number, balance, is_blocked FROM users ORDER BY chat_id LIMIT $1 OFFSET $2',
            [PAGE, page * PAGE]
        );
        const lines = res.rows.map((u, i) => {
            const name = esc(u.first_name || (u.username ? '@' + u.username : String(u.chat_id)));
            const blocked = u.is_blocked ? ' 🚫' : '';
            return `${page * PAGE + i + 1}. *${name}*${blocked} — ${u.balance} ETB`;
        }).join('\n');

        const navBtns = [];
        if (page > 0) navBtns.push({ text: '⬅️ Prev', callback_data: `adm_users_p_${page - 1}` });
        if ((page + 1) * PAGE < total) navBtns.push({ text: 'Next ➡️', callback_data: `adm_users_p_${page + 1}` });

        const userBtns = res.rows.map(u => [
            { text: `${u.first_name || u.username || u.chat_id}`, callback_data: `adm_user_view_${u.chat_id}` }
        ]);

        const keyboard = {
            inline_keyboard: [
                ...userBtns,
                navBtns.length ? navBtns : [],
                [{ text: '🔙 Main Menu', callback_data: 'adm_back' }]
            ].filter(r => r.length)
        };
        return editMsg(chatId, msgId, `👥 *Users* (${total} total) — Page ${page + 1}\n\n${lines || 'No users yet.'}`, keyboard);
    }

    async function searchUser(chatId, msgId, query) {
        const res = await db.query(
            `SELECT chat_id, first_name, last_name, username, phone_number, balance, is_blocked
             FROM users
             WHERE phone_number ILIKE $1 OR username ILIKE $2 OR CAST(chat_id AS TEXT) = $3`,
            ['%' + query + '%', '%' + query.replace(/^@/, '') + '%', query]
        );
        if (!res.rows.length) {
            return editMsg(chatId, msgId, `❌ No user found for: \`${query}\``, backBtn('adm_users'));
        }
        const u = res.rows[0];
        return showUserDetail(chatId, msgId, u.chat_id);
    }

    async function showUserDetail(chatId, msgId, uid) {
        const res = await db.query(
            'SELECT chat_id, first_name, last_name, username, phone_number, balance, bonus_balance, is_blocked, is_frozen, games_played, games_won FROM users WHERE chat_id = $1',
            [uid]
        );
        if (!res.rows.length) return editMsg(chatId, msgId, `❌ User \`${uid}\` not found.`, backBtn('adm_users'));
        const u = res.rows[0];
        const name = esc([u.first_name, u.last_name].filter(Boolean).join(' ') || (u.username ? '@' + u.username : 'N/A'));
        const depRes = await db.query('SELECT COALESCE(SUM(amount),0) AS total FROM deposits WHERE chat_id = $1', [uid]);
        const wdRes = await db.query('SELECT COALESCE(SUM(amount),0) AS total FROM withdrawals WHERE chat_id = $1 AND status = $2', [uid, 'completed']);

        // games_played and games_won are now tracked directly on the users table

        // Check Agent Status
        const agentCheck = await db.query('SELECT is_approved FROM agents WHERE chat_id = $1', [uid]);
        const isAgent = agentCheck.rows.length > 0;

        // Get last seen (last card taken)
        let lastSeenText = 'Never';
        try {
            const lastSeenRes = await db.query('SELECT MAX(created_at) as last_seen FROM agent_earnings WHERE user_id = $1', [uid]);
            if (lastSeenRes.rows[0].last_seen) {
                lastSeenText = new Date(lastSeenRes.rows[0].last_seen).toLocaleString('en-GB', { timeZone: 'Africa/Addis_Ababa', hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit', year: 'numeric' });
            }
        } catch (e) { console.error('Error getting last seen:', e); }

        let statusText = u.is_blocked ? '🚫 *BLOCKED*' : '✅ Active';
        if (u.is_frozen) statusText += ' | ❄️ *FROZEN*';

        const text =
            `👤 *User Profile*\n\n` +
            `🆔 ID: \`${u.chat_id}\`\n` +
            `👤 Name: *${name}*\n` +
            `📱 Phone: ${esc(u.phone_number || 'N/A')}\n` +
            `🔖 Username: ${u.username ? '@' + esc(u.username) : 'N/A'}\n` +
            `🎮 Total Played: *${u.games_played || 0}*\n` +
            `🏆 Total Wins: *${u.games_won || 0}*\n` +
            `💰 Main Balance: *${parseFloat(u.balance).toFixed(2)} ETB*\n` +
            `🎁 Bonus Balance: *${parseFloat(u.bonus_balance || 0).toFixed(2)} ETB*\n` +
            `📥 Total Deposited: ${parseFloat(depRes.rows[0].total).toFixed(2)} ETB\n` +
            `📤 Total Withdrawn: ${parseFloat(wdRes.rows[0].total).toFixed(2)} ETB\n\n` +
            `Status: ${statusText}\n` +
            `🕒 Last Seen: \`${lastSeenText}\``;

        const blockBtn = u.is_blocked
            ? { text: '✅ Unblock User', callback_data: `adm_user_unblock_${uid}` }
            : { text: '🚫 Block User', callback_data: `adm_user_block_${uid}` };

        const freezeBtn = u.is_frozen
            ? { text: '☀️ Unfreeze User', callback_data: `adm_user_unfreeze_${uid}` }
            : { text: '❄️ Freeze User', callback_data: `adm_user_freeze_${uid}` };

        const agentBtn = isAgent
            ? { text: '➖ Remove Agent', callback_data: `adm_user_rem_agent_prompt_${uid}` }
            : { text: '➕ Add Agent', callback_data: `adm_user_add_agent_prompt_${uid}` };

        const kb = {
            inline_keyboard: [
                [{ text: '➕ Add Balance', callback_data: `adm_user_addbal_${uid}` },
                { text: '➖ Deduct Balance', callback_data: `adm_user_deduct_${uid}` }],
                [{ text: '🎁 Add Bonus', callback_data: `adm_user_addbonus_${uid}` },
                { text: '💔 Deduct Bonus', callback_data: `adm_user_deductbonus_${uid}` }],
                [{ text: '⚙️ Set Balance', callback_data: `adm_user_setbal_${uid}` }, blockBtn],
                [freezeBtn, { text: '📜 Withdrawal History', callback_data: `adm_user_wd_hist_${uid}` }],
                [{ text: '📥 Deposit History', callback_data: `adm_user_dep_hist_${uid}` }, agentBtn],
                [{ text: '🔍 Audit Trail', callback_data: `adm_audit_trail_${uid}` },
                { text: '💬 Send Message', callback_data: `adm_user_msg_${uid}` }],
                [{ text: '🗑 Remove User', callback_data: `adm_user_remove_${uid}` }],
                [{ text: '🔙 Users List', callback_data: 'adm_users' }],
            ]
        };
        return editMsg(chatId, msgId, text, kb);
    }

    async function showUserWithdrawalHistory(chatId, msgId, uid) {
        const res = await db.query(
            `SELECT id, amount, method, status, created_at FROM withdrawals 
             WHERE chat_id = $1 ORDER BY created_at DESC LIMIT 20`,
            [uid]
        );
        const lines = res.rows.map(w => {
            const date = new Date(w.created_at).toLocaleString('en-GB', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit', year: 'numeric' });
            return `• *${w.amount} ETB* (${w.status}) — ${w.method}\n  📅 \`${date}\``;
        }).join('\n\n');

        return editMsg(chatId, msgId, `📜 *Withdrawal History (User: ${uid})*\n\n${lines || 'No history found.'}`, backBtn(`adm_user_view_${uid}`));
    }

    async function showAuditTrail(chatId, msgId, uid) {
        try {
            const res = await db.query(`
                (SELECT '📥 Deposit' AS type, amount, method, created_at, 'completed' AS status FROM deposits WHERE chat_id = $1)
                UNION ALL
                (SELECT '📤 Withdraw' AS type, amount, method, created_at, status FROM withdrawals WHERE chat_id = $1)
                ORDER BY created_at DESC LIMIT 30
            `, [uid]);

            const lines = res.rows.map(r => {
                const date = new Date(r.created_at).toLocaleString('en-GB', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' });
                return `${r.type}: *${r.amount} ETB* (${r.method}) [${r.status}]\n   📅 \`${date}\``;
            });

            const text = `🔍 *Audit Trail for User: \`${uid}\`*\n_Last 30 transactions_\n\n${lines.join('\n\n') || 'No transactions yet.'}`;
            return editMsg(chatId, msgId, text, backBtn(`adm_user_view_${uid}`));
        } catch (err) {
            console.error('[AdminBot] Audit trail error:', err);
            return editMsg(chatId, msgId, '⚠️ Error loading audit trail.', backBtn(`adm_user_view_${uid}`));
        }
    }

    async function showAgentInvitedUsers(chatId, msgId, uid, page = 0) {
        try {
            const PAGE_SIZE = 10;
            const offset = page * PAGE_SIZE;

            const now = new Date();
            const etNow = new Date(now.getTime() + 3 * 3600 * 1000);
            const startOfTodayET = new Date(etNow);
            startOfTodayET.setUTCHours(0, 0, 0, 0);
            const startOfTodayIso = new Date(startOfTodayET.getTime() - 3 * 3600 * 1000).toISOString();
            const sevenDaysAgoIso = new Date(now.getTime() - 7 * 24 * 3600 * 1000).toISOString();

            // Compute global stats
            const statsRes = await db.query(`
                SELECT 
                    COUNT(DISTINCT u.chat_id) AS total_invited,
                    COALESCE(SUM(ae.amount), 0) AS total_commission,
                    COUNT(DISTINCT CASE WHEN ae.created_at >= $2 THEN u.chat_id END) AS active_today,
                    COUNT(DISTINCT CASE WHEN ae.created_at >= $3 THEN u.chat_id END) AS active_week
                FROM users u
                LEFT JOIN agent_earnings ae ON ae.user_id = u.chat_id AND ae.agent_id = $1
                WHERE u.referred_by = $1
            `, [uid, startOfTodayIso, sevenDaysAgoIso]);

            const st = statsRes.rows[0];
            if (st.total_invited == 0) {
                return editMsg(chatId, msgId, `👥 *Invited Users for Agent ${uid}*\n\nNo users have joined yet.`, backBtn(`adm_agent_view_${uid}`));
            }

            // Get users list with rank and status
            const usersRes = await db.query(`
                SELECT
                    u.chat_id,
                    u.first_name,
                    u.last_name,
                    u.username,
                    COUNT(ae.id) AS total_games,
                    COALESCE(SUM(ae.amount), 0) AS total_earned,
                    MAX(ae.created_at) AS last_played,
                    (SELECT COUNT(*) FROM game_history WHERE winners LIKE '%' || CAST(u.chat_id AS TEXT) || '%') AS total_wins
                FROM users u
                LEFT JOIN agent_earnings ae ON ae.user_id = u.chat_id AND ae.agent_id = $1
                WHERE u.referred_by = $1
                GROUP BY u.chat_id, u.first_name, u.last_name, u.username
                ORDER BY total_earned DESC, u.chat_id DESC
            `, [uid]);

            const allUsers = usersRes.rows;
            const totalUsers = allUsers.length;
            const pageUsers = allUsers.slice(offset, offset + PAGE_SIZE);

            const userBtns = pageUsers.map((u, i) => {
                const globalRank = offset + i;
                let medal = '';
                if (globalRank === 0) medal = '🥇 ';
                else if (globalRank === 1) medal = '🥈 ';
                else if (globalRank === 2) medal = '🥉 ';

                let statusIcon = '🔴';
                if (u.last_played) {
                    const diffDays = (new Date() - new Date(u.last_played)) / (1000 * 3600 * 24);
                    if (diffDays <= 1) statusIcon = '🟢';
                    else if (diffDays <= 7) statusIcon = '🟡';
                } else {
                    statusIcon = '🆕';
                }

                const name = [u.first_name, u.last_name].filter(Boolean).join(' ') || (u.username ? '@' + u.username : `User_${u.chat_id}`);
                const title = `${medal}${statusIcon} ${name} | ${parseFloat(u.total_earned).toFixed(2)} ETB`;
                return [{ text: title, callback_data: `adm_user_view_${u.chat_id}` }];
            });

            // Navigation
            const navBtns = [];
            if (page > 0) navBtns.push({ text: '⬅️ Prev', callback_data: `adm_agent_users_${page - 1}_${uid}` });
            if (offset + PAGE_SIZE < totalUsers) navBtns.push({ text: 'Next ➡️', callback_data: `adm_agent_users_${page + 1}_${uid}` });

            const text =
                `👥 *Invited Users Dashboard (Agent: ${uid})*\n\n` +
                `📊 *Summary*\n` +
                `• Total Invited: *${st.total_invited}*\n` +
                `• Active Today: *${st.active_today}*\n` +
                `• Active This Week: *${st.active_week}*\n` +
                `• Total Commission: *${parseFloat(st.total_commission).toFixed(2)} ETB*\n\n` +
                `_Click a user below for detailed stats._`;

            const kb = {
                inline_keyboard: [
                    ...userBtns,
                    navBtns.length ? navBtns : [],
                    [{ text: '🔙 Back to Agent', callback_data: `adm_agent_view_${uid}` }]
                ].filter(r => r.length > 0)
            };

            return editMsg(chatId, msgId, text, kb);
        } catch (err) {
            console.error('[AdminBot] showAgentInvitedUsers error:', err);
            return editMsg(chatId, msgId, '⚠️ Error loading invited users.', backBtn(`adm_agent_view_${uid}`));
        }
    }

    // ── Agents ──
    async function showAgentsMenu(chatId, msgId) {
        const pendingRes = await db.query('SELECT COUNT(*) AS count FROM pending_agents');
        const pending = pendingRes.rows[0].count;
        const kb = {
            inline_keyboard: [
                [{ text: `📋 Pending Requests (${pending})`, callback_data: 'adm_agents_pending' }],
                [{ text: '📋 All Agents', callback_data: 'adm_agents_all' }],
                [{ text: '➕ Add Agent', callback_data: 'adm_agent_add' }],
                [{ text: '🔙 Main Menu', callback_data: 'adm_back' }],
            ]
        };
        return editMsg(chatId, msgId, `🧑‍💼 *Agent Management*\n\nPending requests: *${pending}*`, kb);
    }

    async function showNonAgentUsers(chatId, msgId, page = 0) {
        const PAGE_SIZE = 10;
        const offset = page * PAGE_SIZE;

        try {
            // Get total non-agents
            const countRes = await db.query(`
            SELECT COUNT(*) AS count
            FROM users u 
            LEFT JOIN agents a ON u.chat_id = a.chat_id 
            WHERE a.chat_id IS NULL OR a.is_approved = FALSE
        `);
            const total = parseInt(countRes.rows[0].count, 10);

            // Get paginated users
            const res = await db.query(`
            SELECT u.chat_id, u.first_name, u.username, u.phone_number 
            FROM users u 
            LEFT JOIN agents a ON u.chat_id = a.chat_id 
            WHERE a.chat_id IS NULL OR a.is_approved = FALSE 
            ORDER BY u.chat_id DESC 
            LIMIT $1 OFFSET $2
        `, [PAGE_SIZE, offset]);

            const rows = [];

            for (const u of res.rows) {
                // Safe fallback for display name
                const name =
                    u.first_name ||
                    u.username ||
                    u.phone_number ||
                    u.chat_id;

                // Escape Markdown
                const safeName = String(name).replace(/[_*[\\]()~`>#+-=|{}.!]/g, '\\$&');

                rows.push([{
                    text: `👤 ${safeName}`,
                    callback_data: `adm_agadd_view_${u.chat_id}`
                }]);
            }

            // Pagination buttons
            const nav = [];
            if (page > 0) {
                nav.push({ text: '⬅️ Prev', callback_data: `adm_agadd_p_${page - 1}` });
            }
            if (offset + PAGE_SIZE < total) {
                nav.push({ text: 'Next ➡️', callback_data: `adm_agadd_p_${page + 1}` });
            }
            if (nav.length) rows.push(nav);

            // Back button
            rows.push([{ text: '🔙 Back to Agents', callback_data: 'adm_agents' }]);

            const text = `➕ *Select User to Add as Agent* (${total} available)\n\nPage ${page + 1}`;

            if (msgId) {
                return bot.editMessageText(text, {
                    chat_id: chatId,
                    message_id: msgId,
                    parse_mode: 'Markdown',
                    reply_markup: { inline_keyboard: rows }
                });
            }

            return bot.sendMessage(chatId, text, {
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: rows }
            });

        } catch (err) {
            console.error('[AdminBot] Error loading non-agents:', err);
        }
    }

    async function showAddAgentProfile(adminChatId, msgId, targetId) {
        try {
            const res = await db.query(
                'SELECT * FROM users WHERE chat_id = $1',
                [targetId]
            );

            if (!res.rows.length) {
                return;
            }

            const u = res.rows[0];

            // Use the shared esc() helper (Markdown v1 safe)
            const firstName = esc(u.first_name || '');
            const lastName = esc(u.last_name || '');
            const username = u.username ? '@' + esc(u.username) : 'N/A';
            const phone = u.phone_number || 'N/A';

            const text =
                `👤 *User Profile*\n\n` +
                `*ID:* \`${u.chat_id}\`\n` +
                `*Name:* ${firstName} ${lastName}\n` +
                `*Username:* ${username}\n` +
                `*Phone:* ${phone}\n\n` +
                `Do you want to add this user as an Agent?`;

            const keyboard = {
                inline_keyboard: [
                    [
                        {
                            text: '❌ Cancel',
                            callback_data: `adm_agadd_cancel_${targetId}`
                        },
                        {
                            text: '✅ Add to Agents',
                            callback_data: `adm_agadd_confirm_${targetId}`
                        }
                    ]
                ]
            };

            return bot.editMessageText(text, {
                chat_id: adminChatId,
                message_id: msgId,
                parse_mode: 'Markdown',
                reply_markup: keyboard
            });

        } catch (err) {
            console.error('[AdminBot] Profile error:', err);
        }
    }

    async function showPendingAgents(chatId, msgId) {
        const res = await db.query('SELECT * FROM pending_agents ORDER BY requested_at');
        if (!res.rows.length) {
            return editMsg(chatId, msgId, '✅ No pending agent requests.', backBtn('adm_agents'));
        }
        for (const p of res.rows) {
            const name = [p.first_name, p.last_name].filter(Boolean).join(' ') || 'N/A';
            const text =
                `📋 *Agent Request*\n\n` +
                `👤 Name: *${esc(name)}*\n` +
                `🔖 Username: ${p.username ? '@' + esc(p.username) : 'N/A'}\n` +
                `🆔 ID: \`${p.chat_id}\`\n` +
                `📱 Phone: ${esc(p.phone || 'N/A')}\n` +
                `🕐 Requested: ${new Date(p.requested_at).toLocaleString()}`;

            bot.sendMessage(chatId, text, {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [[
                        { text: '✅ Approve', callback_data: `adm_agent_approve_${p.chat_id}` },
                        { text: '❌ Reject', callback_data: `adm_agent_reject_${p.chat_id}` },
                    ]]
                }
            });
        }
        bot.sendMessage(chatId, `_${res.rows.length} pending request(s) shown above._`, {
            parse_mode: 'Markdown',
            reply_markup: backBtn('adm_agents')
        });
    }

    async function approveAgent(chatId, msgId, adminId, uid) {
        const pendingRes = await db.query('SELECT * FROM pending_agents WHERE chat_id = $1', [uid]);

        if (!pendingRes.rows.length) {
            return editMsg(chatId, msgId, '⚠️ Request not found or already processed.', backBtn('adm_agents'));
        }

        const p = pendingRes.rows[0];
        const refCode = `ref_${uid}`;

        await db.query(`
        INSERT INTO agents (chat_id, first_name, username, balance, is_approved, referral_code)
        VALUES ($1, $2, $3, 0.00, TRUE, $4)
        ON CONFLICT (chat_id) DO UPDATE 
        SET is_approved = TRUE, referral_code = $4, first_name = $2, username = $3
    `, [uid, p.first_name, p.username, refCode]);

        await db.query('DELETE FROM pending_agents WHERE chat_id = $1', [uid]);
        await log(adminId, 'approve_agent', uid);

        const link = `https://t.me/${BINGO_BOT_USERNAME}?start=ref_${uid}`;

        // Plain text message
        const congratsMsg = `🎉 Congratulations! You are now a Smart Bingo Agent!

Your referral link:
${link}

Share it and earn 1 ETB per card played by your users!

Invite ያደረጉት ሰው 1 ካርቴላ ይዞ ሲጫወት 1 ብር commission ያገኛሉ።

ለማስጀመር /start ይጫኑ `;

        if (agentBot) {
            agentBot.sendMessage(uid, congratsMsg)
                .catch(err => console.warn(`[AdminBot] approveAgent notify skipped: ${err.message}`));
        }

        const displayName = (p.first_name || uid)
            .toString()
            .replace(/[_*`[\]()]/g, '\\$&');

        return editMsg(
            chatId,
            msgId,
            `✅ Agent *${displayName}* approved!\n\nReferral: \`${link}\``,
            backBtn('adm_agents')
        );
    }

    async function rejectAgent(chatId, msgId, adminId, uid) {
        const pendingRes = await db.query(
            'SELECT first_name FROM pending_agents WHERE chat_id = $1',
            [uid]
        );

        await db.query('DELETE FROM pending_agents WHERE chat_id = $1', [uid]);
        await log(adminId, 'reject_agent', uid);

        if (agentBot) {
            agentBot.sendMessage(
                uid,
                '❌ Your agent application was not approved at this time. Contact support for more info.'
            ).catch(err => console.warn(`[AdminBot] rejectAgent notify skipped: ${err.message}`));
        }

        const name = (pendingRes.rows[0]?.first_name || uid)
            .toString()
            .replace(/[_*`[\]()]/g, '\\$&');

        return editMsg(
            chatId,
            msgId,
            `❌ Agent *${name}* rejected.`,
            backBtn('adm_agents')
        );
    }

    async function showAllAgents(chatId, msgId) {
        const res = await db.query(
            `SELECT a.chat_id, a.first_name, a.username, a.balance, a.is_approved, a.is_blocked,
                    COALESCE(sub.total_earned, 0) AS total_earned,
                    (SELECT COUNT(*) FROM users WHERE referred_by = a.chat_id) AS invited
             FROM agents a
             LEFT JOIN (
                 SELECT agent_id, SUM(amount) AS total_earned
                 FROM agent_earnings GROUP BY agent_id
             ) sub ON sub.agent_id = a.chat_id
             ORDER BY total_earned DESC`
        );
        if (!res.rows.length) return editMsg(chatId, msgId, '🧑‍💼 No agents yet.', backBtn('adm_agents'));

        const lines = res.rows.map((a, i) => {
            const name = esc(a.first_name || (a.username ? '@' + a.username : String(a.chat_id)));
            const status = a.is_blocked ? '🚫' : a.is_approved ? '✅' : '⏳';
            return `${i + 1}. ${status} *${name}* — ${a.invited} users | ${parseFloat(a.total_earned).toFixed(2)} ETB`;
        }).join('\n');

        const agentBtns = res.rows.map(a => [
            { text: a.first_name || a.username || String(a.chat_id), callback_data: `adm_agent_view_${a.chat_id}` }
        ]);

        return editMsg(chatId, msgId, `🧑‍💼 *All Agents* (${res.rows.length})\n\n${lines}`, {
            inline_keyboard: [...agentBtns, [{ text: '🔙 Agents Menu', callback_data: 'adm_agents' }]]
        });
    }

    async function showAgentDetail(chatId, msgId, uid) {
        const res = await db.query(
            `SELECT a.chat_id, a.first_name, a.username, a.balance, a.is_approved, a.is_blocked, a.referral_code,
                    COALESCE(e.total_earned, 0) AS total_earned,
                    (SELECT COUNT(*) FROM users WHERE referred_by = a.chat_id) AS invited
             FROM agents a
             LEFT JOIN (
                 SELECT agent_id, SUM(amount) AS total_earned
                 FROM agent_earnings
                 GROUP BY agent_id
             ) e ON e.agent_id = a.chat_id
             WHERE a.chat_id = $1`,
            [uid]
        );
        if (!res.rows.length) return editMsg(chatId, msgId, `❌ Agent \`${uid}\` not found.`, backBtn('adm_agents'));
        const a = res.rows[0];
        const name = esc(a.first_name || (a.username ? '@' + a.username : String(a.chat_id)));
        const link = `https://t.me/${BINGO_BOT_USERNAME}?start=ref_${uid}`;

        const text =
            `🧑‍💼 *Agent Profile*\n\n` +
            `🆔 ID: \`${a.chat_id}\`\n` +
            `👤 Name: *${name}*\n` +
            `🔖 Username: ${a.username ? '@' + esc(a.username) : 'N/A'}\n` +
            `💰 Balance: *${parseFloat(a.balance).toFixed(2)} ETB*\n` +
            `📊 Total Earned: *${parseFloat(a.total_earned).toFixed(2)} ETB*\n` +
            `👥 Invited Users: *${a.invited}*\n` +
            `🔗 Referral: \`${link}\`\n` +
            `${a.is_blocked ? '🚫 *BLOCKED*' : a.is_approved ? '✅ Active' : '⏳ Pending'}`;

        const blockBtn = a.is_blocked
            ? { text: '✅ Unblock Agent', callback_data: `adm_agent_unblock_${uid}` }
            : { text: '🚫 Block Agent', callback_data: `adm_agent_block_${uid}` };

        return editMsg(chatId, msgId, text, {
            inline_keyboard: [
                [{ text: '👥 Invited Users', callback_data: `adm_agent_users_${uid}` }],
                [{ text: '➕ Add Balance', callback_data: `adm_agent_addbal_${uid}` },
                { text: '➖ Deduct Balance', callback_data: `adm_agent_deduct_${uid}` }],
                [{ text: '⚙️ Set Balance', callback_data: `adm_agent_setbal_${uid}` }, blockBtn],
                [{ text: '📜 Withdrawal History', callback_data: `adm_agent_wd_hist_${uid}` }, { text: '🗑 Remove Agent', callback_data: `adm_agent_remove_${uid}` }],
                [{ text: '🔙 Agents Menu', callback_data: 'adm_agents' }],
            ]
        });
    }

    async function showAgentWithdrawalHistory(chatId, msgId, uid) {
        const res = await db.query(
            `SELECT id, amount, method, status, created_at FROM agent_withdrawals 
             WHERE agent_id = $1 ORDER BY created_at DESC LIMIT 20`,
            [uid]
        );
        const lines = res.rows.map(w => {
            const date = new Date(w.created_at).toLocaleString('en-GB', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit', year: 'numeric' });
            return `• *${w.amount} ETB* (${w.status}) — ${w.method}\n  📅 \`${date}\``;
        }).join('\n\n');

        return editMsg(chatId, msgId, `📜 *Withdrawal History (Agent: ${uid})*\n\n${lines || 'No history found.'}`, backBtn(`adm_agent_view_${uid}`));
    }


    // ── Deposits ──
    async function showDeposits(chatId, msgId, page = 0) {
        const PAGE = 8;
        const total = parseInt((await db.query('SELECT COUNT(*) AS count FROM deposits')).rows[0].count, 10);
        const res = await db.query(
            `SELECT d.id, d.tx_id, d.amount, d.method, d.created_at,
                    u.first_name, u.username, u.phone_number
             FROM deposits d LEFT JOIN users u ON u.chat_id = d.chat_id
             ORDER BY d.created_at DESC LIMIT $1 OFFSET $2`,
            [PAGE, page * PAGE]
        );
        const lines = res.rows.map((d, i) => {
            const name = esc(d.first_name || (d.username ? '@' + d.username : d.phone_number || '?'));
            const date = new Date(d.created_at).toLocaleString('en-GB', { timeZone: 'Africa/Addis_Ababa', hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' });
            return `${page * PAGE + i + 1}. *${name}* — ${d.amount} ETB (${esc(d.method)})\n   📅 \`${date}\` | \`${(d.tx_id || '').slice(0, 10)}...\``;
        }).join('\n');

        const nav = [];
        if (page > 0) nav.push({ text: '⬅️ Prev', callback_data: `adm_deps_p_${page - 1}` });
        if ((page + 1) * PAGE < total) nav.push({ text: 'Next ➡️', callback_data: `adm_deps_p_${page + 1}` });

        return editMsg(chatId, msgId, `💰 *Deposit History* (${total} total) — Page ${page + 1}\n\n${lines || 'No deposits.'}`, {
            inline_keyboard: [
                ...(nav.length ? [nav] : []),
                [{ text: '📝 Manual Deposits', callback_data: 'adm_manual_deposits' }],
                [{ text: '🔧 Fix Deposit / Add Balance', callback_data: 'adm_dep_fix' }],
                [{ text: '🔙 Main Menu', callback_data: 'adm_back' }],
            ]
        });
    }

    async function showManualDeposits(chatId, msgId, page = 0) {
        const PAGE = 8;
        const offset = page * PAGE;
        try {
            const countRes = await db.query(`SELECT COUNT(*) AS count FROM admin_log WHERE action IN ('fix_deposit', 'add_balance_user', 'add_balance_agent')`);
            const total = parseInt(countRes.rows[0].count, 10);

            const res = await db.query(`
                SELECT 
                    l.created_at, 
                    l.admin_id, 
                    l.target as receiver_id, 
                    l.detail,
                    COALESCE(u.first_name || ' ' || COALESCE(u.last_name, ''), a.first_name, 'Unknown') as receiver_name
                FROM admin_log l
                LEFT JOIN users u ON l.target = CAST(u.chat_id AS TEXT)
                LEFT JOIN agents a ON l.target = CAST(a.chat_id AS TEXT)
                WHERE l.action IN ('fix_deposit', 'add_balance_user', 'add_balance_agent')
                ORDER BY l.created_at DESC
                LIMIT $1 OFFSET $2
            `, [PAGE, offset]);

            const lines = res.rows.map((l, i) => {
                const date = new Date(l.created_at).toLocaleString('en-GB', { timeZone: 'Africa/Addis_Ababa', hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' });
                const amount = l.detail.replace('=', '').replace('+', '').replace('-', '');
                return `${offset + i + 1}. *${esc(l.receiver_name)}* (\`${l.receiver_id}\`)\n   💰 Amount: *${amount} ETB* | Admin: \`${l.admin_id}\` \n   📅 \`${date}\``;
            }).join('\n\n');

            const nav = [];
            if (page > 0) nav.push({ text: '⬅️ Prev', callback_data: `adm_manual_deps_p_${page - 1}` });
            if (offset + PAGE < total) nav.push({ text: 'Next ➡️', callback_data: `adm_manual_deps_p_${page + 1}` });

            const text = `📝 *Manual Deposit History* (${total} total)\nPage ${page + 1}\n\n${lines || '_No manual deposits logged._'}`;

            return editMsg(chatId, msgId, text, {
                inline_keyboard: [
                    nav.length ? nav : [],
                    [{ text: '🔙 Back to Deposits', callback_data: 'adm_deposits' }]
                ].filter(r => r.length > 0)
            });
        } catch (err) {
            console.error('[AdminBot] showManualDeposits error:', err);
            return editMsg(chatId, msgId, '⚠️ Error loading manual deposits.', backBtn('adm_deposits'));
        }
    }

    // ── Withdrawals ──
    async function showWithdrawals(chatId, msgId) {
        // User withdrawals
        const userWds = await db.query(
            `SELECT w.id, w.amount, w.method, w.account_name, w.account_details, w.created_at,
                    u.first_name, u.username, u.chat_id AS uid
             FROM withdrawals w LEFT JOIN users u ON u.chat_id = w.chat_id
             WHERE w.status = 'pending' ORDER BY w.created_at`
        );
        // Agent withdrawals
        const agentWds = await db.query(
            `SELECT w.id, w.amount, w.method, w.account_name, w.account_details, w.created_at,
                    a.first_name, a.username, a.chat_id AS uid
             FROM agent_withdrawals w LEFT JOIN agents a ON a.chat_id = w.agent_id
             WHERE w.status = 'pending' ORDER BY w.created_at`
        );

        const totalPending = userWds.rows.length + agentWds.rows.length;
        if (totalPending === 0) {
            return editMsg(chatId, msgId, '✅ No pending withdrawals.', backBtn());
        }

        // Send each pending withdrawal as a separate message
        bot.sendMessage(chatId, `💸 *Pending Withdrawals* (${totalPending} total)`, {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [[{ text: '📜 Withdrawal History', callback_data: 'adm_wd_history' }]]
            }
        });

        for (const w of userWds.rows) {
            const name = w.first_name || (w.username ? '@' + w.username : String(w.uid));
            bot.sendMessage(chatId,
                `💸 *User Withdrawal #${w.id}*\n\n` +
                `👤 Requester: *USER*\n` +
                `👤 Name: *${name}*\n` +
                `🆔 ID: \`${w.uid}\`\n` +
                `💰 Amount: *${w.amount} ETB*\n` +
                `💳 Method: *${w.method.toUpperCase()}*\n` +
                `📝 Name: *${esc(w.account_name || 'N/A')}*\n` +
                `📋 Account: \`${w.account_details}\`\n` +
                `🕐 Requested: ${new Date(w.created_at).toLocaleString()}`,
                {
                    parse_mode: 'Markdown',
                    reply_markup: {
                        inline_keyboard: [[
                            { text: '✅ Completed', callback_data: `adm_wd_done_${w.id}` },
                            { text: '❌', callback_data: `adm_wd_rej_${w.id}` }
                        ]]
                    }
                }
            );
        }

        for (const w of agentWds.rows) {
            const name = w.first_name || (w.username ? '@' + w.username : String(w.uid));
            bot.sendMessage(chatId,
                `💸 *Agent Withdrawal #${w.id}*\n\n` +
                `🧑‍💼 Requester: *AGENT*\n` +
                `🧑‍💼 Name: *${esc(name)}*\n` +
                `🆔 ID: \`${w.uid}\`\n` +
                `💰 Amount: *${w.amount} ETB*\n` +
                `💳 Method: *${esc(w.method.toUpperCase())}*\n` +
                `📋 Account: \`${esc(w.account_details)}\`\n` +
                `🕐 Requested: ${new Date(w.created_at).toLocaleString()}`,
                {
                    parse_mode: 'Markdown',
                    reply_markup: {
                        inline_keyboard: [[
                            { text: '✅ Completed', callback_data: `agwd_done_${w.id}` },
                            { text: '❌', callback_data: `agwd_rej_${w.id}` }
                        ]]
                    }
                }
            );
        }
    }

    async function completeUserWithdrawal(chatId, msgId, adminId, wdId) {
        const res = await db.query(
            `UPDATE withdrawals SET status = 'completed' WHERE id = $1 AND status = 'pending' RETURNING chat_id, amount`,
            [wdId]
        );
        if (!res.rows.length) {
            return bot.editMessageText('⚠️ Already processed.', { chat_id: chatId, message_id: msgId });
        }
        const { chat_id: uid, amount } = res.rows[0];
        await log(adminId, 'complete_withdrawal', wdId, `user ${uid} amount ${amount}`);

        // Notify user
        if (bingoBot) {
            bingoBot.sendMessage(uid,
                `✅ *Withdrawal Completed!*\n\nYour withdrawal of *${parseFloat(amount).toFixed(2)} ETB* has been processed! 🎉`,
                { parse_mode: 'Markdown' }
            ).catch(err => {
                console.error(`[AdminBot] Failed to send withdrawal notification to user ${uid}:`, err.message);
            });
        }

        // Delete message from admin chat to clean inbox
        bot.deleteMessage(chatId, msgId).catch(() => { });

        bot.sendMessage(chatId, `✅ Withdrawal #${wdId} marked completed. User notified.`);
    }

    async function completeAgentWithdrawal(chatId, msgId, adminId, wdId) {
        const res = await db.query(
            `UPDATE agent_withdrawals SET status = 'completed' WHERE id = $1 AND status = 'pending' RETURNING agent_id, amount`,
            [wdId]
        );
        if (!res.rows.length) {
            return bot.editMessageText('⚠️ Already processed.', { chat_id: chatId, message_id: msgId });
        }
        const { agent_id, amount } = res.rows[0];
        await log(adminId, 'complete_agent_withdrawal', wdId, `agent ${agent_id} amount ${amount}`);

        if (agentBot) {
            agentBot.sendMessage(agent_id,
                `✅ *Withdrawal Completed!*\n\nYour withdrawal of *${parseFloat(amount).toFixed(2)} ETB* has been processed! 🎉`,
                { parse_mode: 'Markdown' }
            ).catch(err => {
                console.error(`[AdminBot] Failed to send withdrawal notification to agent ${agent_id}:`, err.message);
            });
        }

        // Delete message from admin chat
        bot.deleteMessage(chatId, msgId).catch(() => { });

        bot.sendMessage(chatId, `✅ Agent withdrawal #${wdId} marked completed. Agent notified.`);
    }

    async function rejectUserWithdrawal(chatId, msgId, adminId, wdId) {
        const res = await db.query(
            `UPDATE withdrawals 
         SET status = 'rejected' 
         WHERE id = $1 AND status = 'pending' 
         RETURNING chat_id, amount`,
            [wdId]
        );

        if (!res.rows.length) {
            return bot.editMessageText('⚠️ Already processed.', { chat_id: chatId, message_id: msgId });
        }

        const { chat_id: uid, amount } = res.rows[0];

        // Refund balance
        await db.query(
            'UPDATE users SET balance = balance + $1 WHERE chat_id = $2',
            [amount, uid]
        );

        await log(adminId, 'reject_withdrawal', wdId, `user ${uid} amount ${amount} refunded`);

        if (bingoBot) {
            bingoBot.sendMessage(
                uid,
                `❌ *Withdrawal Rejected*\n\nYour withdrawal request for *${parseFloat(amount).toFixed(2)} ETB* has been rejected properly and the funds have been returned to your balance.`,
                { parse_mode: 'Markdown' }
            ).catch(() => { });
        }

        bot.deleteMessage(chatId, msgId).catch(() => { });
        bot.sendMessage(chatId, `❌ Withdrawal #${wdId} rejected. Funds refunded and user notified.`);
    }


    async function rejectAgentWithdrawal(chatId, msgId, adminId, wdId) {
        const res = await db.query(
            `UPDATE agent_withdrawals 
         SET status = 'rejected' 
         WHERE id = $1 AND status = 'pending' 
         RETURNING agent_id, amount`,
            [wdId]
        );

        if (!res.rows.length) {
            return bot.editMessageText('⚠️ Already processed.', { chat_id: chatId, message_id: msgId });
        }

        const { agent_id, amount } = res.rows[0];

        // Refund agent balance
        await db.query(
            'UPDATE agents SET balance = balance + $1 WHERE chat_id = $2',
            [amount, agent_id]
        );

        await log(adminId, 'reject_agent_withdrawal', wdId, `agent ${agent_id} amount ${amount} refunded`);

        if (agentBot) {
            agentBot.sendMessage(
                agent_id,
                `❌ *Withdrawal Rejected*\n\nYour withdrawal request for *${parseFloat(amount).toFixed(2)} ETB* has been rejected properly and the funds have been returned to your agent balance.`,
                { parse_mode: 'Markdown' }
            ).catch(() => { });
        }

        bot.deleteMessage(chatId, msgId).catch(() => { });
        bot.sendMessage(chatId, `❌ Agent withdrawal #${wdId} rejected. Funds refunded and agent notified.`);
    }

    async function showCompletedWithdrawalsHistory(chatId, msgId, page = 0) {
        const PAGE_SIZE = 10;
        const offset = page * PAGE_SIZE;

        try {
            const countRes = await db.query('SELECT COUNT(*) AS count FROM withdrawals WHERE status = \'completed\'');
            const agentCountRes = await db.query('SELECT COUNT(*) AS count FROM agent_withdrawals WHERE status = \'completed\'');
            const total = parseInt(countRes.rows[0].count, 10) + parseInt(agentCountRes.rows[0].count, 10);

            // Fetch combined user and agent withdrawals
            const res = await db.query(`
                SELECT 'user' as type, w.id, w.amount, w.method, w.created_at, w.account_name, w.account_details, u.first_name, u.username 
                 FROM withdrawals w LEFT JOIN users u ON w.chat_id = u.chat_id WHERE w.status = 'completed'
                UNION ALL
                SELECT 'agent' as type, aw.id, aw.amount, aw.method, aw.created_at, aw.account_name, aw.account_details, a.first_name, a.username 
                 FROM agent_withdrawals aw LEFT JOIN agents a ON aw.agent_id = a.chat_id WHERE aw.status = 'completed'
                ORDER BY created_at DESC LIMIT $1 OFFSET $2
            `, [PAGE_SIZE, offset]);

            const lines = res.rows.map(w => {
                const date = new Date(w.created_at).toLocaleString('en-GB', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit', year: 'numeric' });
                const type = w.type === 'user' ? '👤 User' : '🧑‍💼 Agent';
                const name = esc(w.first_name || (w.username ? '@' + w.username : 'N/A'));
                return `• ${type} | *${w.amount} ETB* (${esc(w.method)})\n  👤 User: *${name}*\n  📝 Name: *${esc(w.account_name || 'N/A')}*\n  📅 \`${date}\` | \`${esc(w.account_details)}\``;
            });

            const navBtns = [];
            if (page > 0) navBtns.push({ text: '⬅️ Prev', callback_data: `adm_wd_hist_p_${page - 1}` });
            if (offset + PAGE_SIZE < total) navBtns.push({ text: 'Next ➡️', callback_data: `adm_wd_hist_p_${page + 1}` });

            const keyboard = {
                inline_keyboard: [
                    navBtns.length ? navBtns : [],
                    [{ text: '🔙 Back to Withdrawals', callback_data: 'adm_withdraws' }],
                    [{ text: '🔙 Main Menu', callback_data: 'adm_back' }]
                ].filter(r => r.length > 0)
            };

            const text = `📜 *Withdrawal History* (${total} total)\nPage ${page + 1}\n\n${lines.join('\n\n') || 'No completed withdrawals yet.'}`;
            return editMsg(chatId, msgId, text, keyboard);
        } catch (err) {
            console.error('[AdminBot] showCompletedWithdrawalsHistory error:', err);
            return editMsg(chatId, msgId, '⚠️ Error loading withdrawal history.', backBtn());
        }
    }

    // ── Stats ──
    async function handleStats(chatId, msgId) {
        await loadSettings();
        const sysFee = parseFloat(settings.system_fee) || 4;

        // Helper to get stats for a specific condition
        const getStatsByCondition = async (whereClause) => {
            const historyRes = await db.query(`SELECT COALESCE(SUM(player_count), 0) AS cards FROM game_history WHERE ${whereClause}`);
            const earningsRes = await db.query(`SELECT COALESCE(SUM(amount), 0) AS expenses FROM agent_earnings WHERE ${whereClause}`);

            const cards = parseInt(historyRes.rows[0].cards, 10);
            const expenses = parseFloat(earningsRes.rows[0].expenses);
            const profit = (cards * sysFee) - expenses;

            return { cards, profit };
        };

        const getPNLStat = async (whereClause) => {
            const depRes = await db.query(`SELECT COALESCE(SUM(amount), 0) AS total, method FROM deposits WHERE method IN ('telebirr','cbebirr','cbe') AND ${whereClause} GROUP BY method`);
            
            let depTelebirr = 0;
            let depCbe = 0;
            let depCbebirr = 0;
            let totalDep = 0;
            
            for (const r of depRes.rows) {
                const amt = parseFloat(r.total);
                totalDep += amt;
                if (r.method === 'telebirr') depTelebirr = amt;
                else if (r.method === 'cbe') depCbe = amt;
                else if (r.method === 'cbebirr') depCbebirr = amt;
            }

            const wdRes = await db.query(`SELECT COALESCE(SUM(amount), 0) AS total FROM withdrawals WHERE method IN ('telebirr','cbebirr','cbe') AND status = 'completed' AND ${whereClause}`);
            const manualRes = await db.query(`SELECT COALESCE(SUM(
                CASE WHEN detail ~ '^[+-]?[0-9]+(\\.[0-9]+)?$' THEN CAST(REPLACE(detail, '+', '') AS DECIMAL) ELSE 0 END
            ), 0) AS total FROM admin_log WHERE action IN ('fix_deposit', 'add_balance_user', 'add_balance_agent') AND ${whereClause}`);

            return {
                diff: totalDep - parseFloat(wdRes.rows[0]?.total || 0),
                manual: parseFloat(manualRes.rows[0]?.total || 0),
                dep: totalDep,
                depTelebirr,
                depCbe,
                depCbebirr,
                wd: parseFloat(wdRes.rows[0]?.total || 0)
            };
        };

        try {
            // PostgreSQL-compatible date conditions in East African Time (EAT = UTC+3)
            const dayCond       = "created_at AT TIME ZONE 'Africa/Addis_Ababa' >= (NOW() AT TIME ZONE 'Africa/Addis_Ababa')::date";
            const yesterdayCond = "created_at AT TIME ZONE 'Africa/Addis_Ababa' >= (NOW() AT TIME ZONE 'Africa/Addis_Ababa')::date - INTERVAL '1 day' AND created_at AT TIME ZONE 'Africa/Addis_Ababa' < (NOW() AT TIME ZONE 'Africa/Addis_Ababa')::date";
            const weekCond      = "created_at AT TIME ZONE 'Africa/Addis_Ababa' >= (NOW() AT TIME ZONE 'Africa/Addis_Ababa')::date - INTERVAL '6 days'";
            const monthCond     = "created_at AT TIME ZONE 'Africa/Addis_Ababa' >= DATE_TRUNC('month', NOW() AT TIME ZONE 'Africa/Addis_Ababa')";
            const yearCond      = "created_at AT TIME ZONE 'Africa/Addis_Ababa' >= DATE_TRUNC('year',  NOW() AT TIME ZONE 'Africa/Addis_Ababa')";

            const [total, daily, weekly, monthly, m3, m6, yearly, uRes, agRes, bRes, pnlD, pnlYes, pnlW, pnlM, pnlY] = await Promise.all([
                getStatsByCondition("1=1"), // total
                getStatsByCondition(dayCond), // daily
                getStatsByCondition(weekCond), // weekly
                getStatsByCondition(monthCond), // monthly
                getStatsByCondition("created_at AT TIME ZONE 'Africa/Addis_Ababa' >= NOW() AT TIME ZONE 'Africa/Addis_Ababa' - INTERVAL '3 months'"),
                getStatsByCondition("created_at AT TIME ZONE 'Africa/Addis_Ababa' >= NOW() AT TIME ZONE 'Africa/Addis_Ababa' - INTERVAL '6 months'"),
                getStatsByCondition(yearCond),
                db.query('SELECT COUNT(*) AS count FROM users'),
                db.query("SELECT COUNT(*) AS count FROM agents WHERE is_approved = TRUE"),
                db.query("SELECT COUNT(*) AS count FROM users WHERE is_blocked = FALSE AND balance > 0"),
                getPNLStat(dayCond),
                getPNLStat(yesterdayCond),
                getPNLStat(weekCond),
                getPNLStat(monthCond),
                getPNLStat(yearCond)
            ]);

            const text =
                `📊 *Detailed System Stats* \n` +
                `━━━━━━━━━━━━━━━━━━━━\n\n` +
                `👥 *Users & Agents*\n` +
                `• Total Users: *${uRes.rows[0].count}*\n` +
                `• Active (balance>0): *${bRes.rows[0].count}*\n` +
                `• Approved Agents: *${agRes.rows[0].count}*\n\n` +
                `📊 *PNL*\n` +
                `• PNL: *D:${pnlD.diff.toFixed(0)}* | *Yes:${pnlYes.diff.toFixed(0)}* | *W:${pnlW.diff.toFixed(0)}* | *M:${pnlM.diff.toFixed(0)}* | *Y:${pnlY.diff.toFixed(0)}*\n` +
                `• total deposits: *D:${pnlD.dep.toFixed(0)}* | *W:${pnlW.dep.toFixed(0)}* | *M:${pnlM.dep.toFixed(0)}* | *Y:${pnlY.dep.toFixed(0)}*\n` +
                `• total withdrawals: *D:${pnlD.wd.toFixed(0)}* | *W:${pnlW.wd.toFixed(0)}* | *M:${pnlM.wd.toFixed(0)}* | *Y:${pnlY.wd.toFixed(0)}*\n` +
                `• manual deposit: *D:${pnlD.manual.toFixed(0)}* | *Yes:${pnlYes.manual.toFixed(0)}* | *W:${pnlW.manual.toFixed(0)}* | *M:${pnlM.manual.toFixed(0)}* | *Y:${pnlY.manual.toFixed(0)}*\n` +
                `• telebirr deposit: *D:${pnlD.depTelebirr.toFixed(0)}* | *W:${pnlW.depTelebirr.toFixed(0)}* | *M:${pnlM.depTelebirr.toFixed(0)}* | *Y:${pnlY.depTelebirr.toFixed(0)}*\n` +
                `• CBE deposits: *D:${pnlD.depCbe.toFixed(0)}* | *W:${pnlW.depCbe.toFixed(0)}* | *M:${pnlM.depCbe.toFixed(0)}* | *Y:${pnlY.depCbe.toFixed(0)}*\n` +
                `• CBEbirr deposits: *D:${pnlD.depCbebirr.toFixed(0)}* | *W:${pnlW.depCbebirr.toFixed(0)}* | *M:${pnlM.depCbebirr.toFixed(0)}* | *Y:${pnlY.depCbebirr.toFixed(0)}*\n\n` +
                `📈 *System Activity (Cards Sold)*\n` +
                `• Daily: *${daily.cards}*\n` +
                `• Weekly: *${weekly.cards}*\n` +
                `• Monthly: *${monthly.cards}*\n` +
                `• 3-Month: *${m3.cards}*\n` +
                `• 6-Month: *${m6.cards}*\n` +
                `• Yearly: *${yearly.cards}*\n` +
                `• All-Time Total: *${total.cards}*\n\n` +
                `💰 *System Gain (Net Profit in ETB)*\n` +
                `• Daily: *${daily.profit.toFixed(2)}*\n` +
                `• Weekly: *${weekly.profit.toFixed(2)}*\n` +
                `• Monthly: *${monthly.profit.toFixed(2)}*\n` +
                `• 3-Month: *${m3.profit.toFixed(2)}*\n` +
                `• 6-Month: *${m6.profit.toFixed(2)}*\n` +
                `• Yearly: *${yearly.profit.toFixed(2)}*\n` +
                `• All-Time Total: *${total.profit.toFixed(2)}*\n\n` +
                `⚙️ *Current Multipliers*\n` +
                `• System Fee per Card: *${sysFee} ETB*\n` +
                `• Agent Commission: *${settings.agent_commission} ETB*`;

            if (msgId) return editMsg(chatId, msgId, text, {
                inline_keyboard: [
                    [{ text: '🏆 Top Winners', callback_data: 'adm_top_winners' }],
                    [{ text: '🔙 Back', callback_data: 'adm_back' }]
                ]
            });
            return bot.sendMessage(chatId, text, {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '🏆 Top Winners', callback_data: 'adm_top_winners' }],
                        [{ text: '🔙 Back', callback_data: 'adm_back' }]
                    ]
                }
            });
        } catch (err) {
            console.error('[AdminBot] handleStats error:', err);
            return bot.sendMessage(chatId, '⚠️ Error loading statistics.', { reply_markup: backBtn() });
        }
    }

    async function showMoneyStats(chatId, msgId, page = 0) {
        const PAGE_SIZE = 15;
        try {
            // 1. Calculate Total Balance (Users + Agents)
            const userBalRes = await db.query('SELECT COALESCE(SUM(balance), 0) AS total FROM users');
            const agentBalRes = await db.query('SELECT COALESCE(SUM(balance), 0) AS total FROM agents');
            const totalSystemBalance = parseFloat(userBalRes.rows[0].total) + parseFloat(agentBalRes.rows[0].total);

            // 2. Count total users with balance > 0
            const countRes = await db.query('SELECT COUNT(*) AS count FROM users WHERE balance > 0');
            const totalUsersWithMoney = parseInt(countRes.rows[0].count, 10);

            // 3. Get users sorted by balance DESC
            const usersRes = await db.query(`
                SELECT chat_id, first_name, username, balance 
                FROM users 
                WHERE balance > 0 
                ORDER BY balance DESC 
                LIMIT $1 OFFSET $2
            `, [PAGE_SIZE, page * PAGE_SIZE]);

            const userBal = parseFloat(userBalRes.rows[0].total);
            const agentBal = parseFloat(agentBalRes.rows[0].total);

            let text = `💰 *Money & Balance Stats*\n`;
            text += `━━━━━━━━━━━━━━━━━━━━\n\n`;
            text += `🏦 *System Balance:* \`${totalSystemBalance.toFixed(2)} ETB\`\n`;
            text += `• Total User Balance: \`${userBal.toFixed(2)} ETB\`\n`;
            text += `• Total Agent Balance: \`${agentBal.toFixed(2)} ETB\`\n\n`;
            text += `👥 Users with balance: *${totalUsersWithMoney}*\n\n`;
            text += `📋 *Top Wealthy Users (Page ${page + 1}):*\n`;

            const lines = usersRes.rows.map((u, i) => {
                const name = esc(u.first_name || (u.username ? '@' + u.username : String(u.chat_id)));
                return `${page * PAGE_SIZE + i + 1}. *${name}* — \`${parseFloat(u.balance).toFixed(2)} ETB\``;
            });

            text += lines.join('\n') || '_No users with balance found._';

            // 4. Get agents sorted by balance DESC
            const agentsRes = await db.query(`
                SELECT chat_id, first_name, username, balance 
                FROM agents 
                WHERE balance > 0 
                ORDER BY balance DESC 
                LIMIT 10
            `);

            text += `\n\n🧑‍💼 *Top Wealthy Agents:*\n`;
            const agentLines = agentsRes.rows.map((a, i) => {
                const name = esc(a.first_name || (a.username ? '@' + a.username : String(a.chat_id)));
                return `${i + 1}. *${name}* — \`${parseFloat(a.balance).toFixed(2)} ETB\``;
            });
            text += agentLines.join('\n') || '_No agents with balance found._';

            const navBtns = [];
            if (page > 0) navBtns.push({ text: '⬅️ Prev', callback_data: `adm_money_p_${page - 1}` });
            if ((page + 1) * PAGE_SIZE < totalUsersWithMoney) navBtns.push({ text: 'Next ➡️', callback_data: `adm_money_p_${page + 1}` });

            const keyboard = {
                inline_keyboard: [
                    navBtns.length ? navBtns : [],
                    [{ text: '🔙 Back', callback_data: 'adm_back' }]
                ].filter(r => r.length > 0)
            };

            return editMsg(chatId, msgId, text, keyboard);
        } catch (err) {
            console.error('[AdminBot] showMoneyStats error:', err);
            return editMsg(chatId, msgId, '⚠️ Error loading money stats.', backBtn());
        }
    }

    async function showTopWinners(chatId, msgId) {
        try {
            const res = await db.query(`
                SELECT 
                    w->>'id' as userId,
                    w->>'name' as name,
                    COUNT(*) as wins,
                    SUM((w->>'prize')::decimal) as total_prizes
                FROM game_history, jsonb_array_elements(winners) AS w
                GROUP BY userId, name
                ORDER BY wins DESC, total_prizes DESC
                LIMIT 20
            `);

            let text = `🏆 *Top 20 Winners (Hall of Fame)*\n`;
            text += `━━━━━━━━━━━━━━━━━━━━\n\n`;

            if (res.rows.length === 0) {
                text += `_No winners yet._`;
            } else {
                res.rows.forEach((r, i) => {
                    const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : '•';
                    text += `${medal} *${esc(r.name)}*\n   🏆 Wins: *${r.wins}* | 💰 Total: *${parseFloat(r.total_prizes).toFixed(2)} ETB*\n`;
                });
            }

            return editMsg(chatId, msgId, text, {
                inline_keyboard: [
                    [{ text: '🔙 Back to Stats', callback_data: 'adm_stats' }]
                ]
            });
        } catch (err) {
            console.error('[AdminBot] showTopWinners error:', err);
            return editMsg(chatId, msgId, '⚠️ Error loading leaderboard.', backBtn('adm_stats'));
        }
    }

    async function showSettingsMenu(chatId, msgId) {
        const kb = {
            inline_keyboard: [
                [{ text: '⚙️ System Variables', callback_data: 'adm_sys_settings' }],
                [{ text: '🎁 Bonus Settings', callback_data: 'adm_bonus_settings' }],
                [{ text: '🔄 D/W Methods', callback_data: 'adm_dw_methods' }],
                [{ text: '🔙 Main Menu', callback_data: 'adm_back' }]
            ]
        };
        return editMsg(chatId, msgId, '⚙️ *Settings Menu*\n\nChoose a category:', kb);
    }

    async function showBonusSettings(chatId, msgId) {
        await loadSettings();
        const kb = {
            inline_keyboard: [
                [{ text: '🎁 Welcome Bonus', callback_data: 'adm_bonus_welcome' }],
                [{ text: '🏆 Winner Bonus', callback_data: 'adm_bonus_winner' }],
                [{ text: '💳 Deposit Bonus %', callback_data: 'adm_bonus_deposit' }],
                [{ text: '🔙 Settings Menu', callback_data: 'adm_settings' }]
            ]
        };

        const wb = settings.welcome_bonus !== undefined ? parseFloat(settings.welcome_bonus) : 20;
        const winBonus = settings.winner_bonus !== undefined ? parseFloat(settings.winner_bonus) : 0;
        const winBonusActive = settings.winner_bonus_active === 'true' || settings.winner_bonus_active === true;
        const depBonusPct = settings.deposit_bonus_pct !== undefined ? parseFloat(settings.deposit_bonus_pct) : 0;

        const text =
            `🎁 *Bonus Settings*\n\n` +
            `• Welcome Bonus: *${wb} ETB*\n` +
            `• Winner Bonus: *${winBonus} ETB* ${winBonusActive ? '🟢 (Active — next winner gets it)' : '⚫ (Inactive)'}\n` +
            `• Deposit Bonus: *${depBonusPct}%*\n\n` +
            `Select a bonus to update.`;

        return editMsg(chatId, msgId, text, kb);
    }

    function showDwMethodsMenu(chatId, msgId) {
        const text = `🔄 *Deposit / Withdrawal Methods*\n\nSelect which methods to configure:`;
        const keyboard = {
            inline_keyboard: [
                [
                    { text: '💳 Deposit Methods', callback_data: 'adm_dw_dep_menu' },
                    { text: '💸 Withdrawal Methods', callback_data: 'adm_dw_wd_menu' }
                ],
                [{ text: '🔙 Back', callback_data: 'adm_settings' }]
            ]
        };
        return editMsg(chatId, msgId, text, keyboard);
    }

    function showDwDepMenu(chatId, msgId) {
        const cbeActive = settings.dep_cbe_active !== false && settings.dep_cbe_active !== 'false';
        const cbebirrActive = settings.dep_cbebirr_active !== false && settings.dep_cbebirr_active !== 'false';
        const telebirrActive = settings.dep_telebirr_active !== false && settings.dep_telebirr_active !== 'false';
        const abyssiniaActive = settings.dep_abyssinia_active !== false && settings.dep_abyssinia_active !== 'false';

        const text = `💳 *Configure Deposit Methods*\n\nEnable or disable deposit methods (or configure account details):`;
        const keyboard = {
            inline_keyboard: [
                [
                    { text: `CBE ${cbeActive ? '✅' : '❌'}`, callback_data: 'adm_dw_toggle_dep_cbe' },
                    { text: `CBEBirr ${cbebirrActive ? '✅' : '❌'}`, callback_data: 'adm_dw_toggle_dep_cbebirr' }
                ],
                [
                    { text: `Telebirr ${telebirrActive ? '✅' : '❌'}`, callback_data: 'adm_dw_toggle_dep_telebirr' },
                    { text: `Abyssinia ${abyssiniaActive ? '✅' : '❌'}`, callback_data: 'adm_dw_toggle_dep_abyssinia' }
                ],
                [{ text: '⚙️ Change Account', callback_data: 'adm_dw_change_acc_menu' }],
                [{ text: '🔙 Back', callback_data: 'adm_dw_methods' }]
            ]
        };
        return editMsg(chatId, msgId, text, keyboard);
    }

    function showDwWdMenu(chatId, msgId) {
        const cbeActive = settings.wd_cbe_active !== false && settings.wd_cbe_active !== 'false';
        const cbebirrActive = settings.wd_cbebirr_active !== false && settings.wd_cbebirr_active !== 'false';
        const telebirrActive = settings.wd_telebirr_active !== false && settings.wd_telebirr_active !== 'false';
        const abyssiniaActive = settings.wd_abyssinia_active !== false && settings.wd_abyssinia_active !== 'false';

        const text = `💸 *Configure Withdrawal Methods*\n\nEnable or disable withdrawal banks/methods:`;
        const keyboard = {
            inline_keyboard: [
                [
                    { text: `CBE ${cbeActive ? '✅' : '❌'}`, callback_data: 'adm_dw_toggle_wd_cbe' },
                    { text: `CBEBirr ${cbebirrActive ? '✅' : '❌'}`, callback_data: 'adm_dw_toggle_wd_cbebirr' }
                ],
                [
                    { text: `Telebirr ${telebirrActive ? '✅' : '❌'}`, callback_data: 'adm_dw_toggle_wd_telebirr' },
                    { text: `Abyssinia ${abyssiniaActive ? '✅' : '❌'}`, callback_data: 'adm_dw_toggle_wd_abyssinia' }
                ],
                [{ text: '🔙 Back', callback_data: 'adm_dw_methods' }]
            ]
        };
        return editMsg(chatId, msgId, text, keyboard);
    }

    function showDwChangeAccMenu(chatId, msgId) {
        const cbeNo   = settings.dep_cbe_acc_no   || '(not set)';
        const cbeName = settings.dep_cbe_acc_name  || '(not set)';
        const birNo   = settings.dep_cbebirr_acc_no   || '(not set)';
        const birName = settings.dep_cbebirr_acc_name  || '(not set)';
        const tbNo    = settings.dep_telebirr_acc_no   || '(not set)';
        const tbName  = settings.dep_telebirr_acc_name  || '(not set)';
        const abyNo   = settings.dep_abyssinia_acc_no   || '(not set)';
        const abyName = settings.dep_abyssinia_acc_name  || '(not set)';

        const text =
            `⚙️ *Change Deposit Account Details*\n` +
            `━━━━━━━━━━━━━━━━━━━\n\n` +
            `🏦 *CBE*\n` +
            `   👤 Name: \`${cbeName}\`\n` +
            `   🔢 Acc No: \`${cbeNo}\`\n\n` +
            `📱 *CBEBirr*\n` +
            `   👤 Name: \`${birName}\`\n` +
            `   🔢 Acc No: \`${birNo}\`\n\n` +
            `📲 *Telebirr*\n` +
            `   👤 Name: \`${tbName}\`\n` +
            `   🔢 Acc No: \`${tbNo}\`\n\n` +
            `🏛 *Abyssinia*\n` +
            `   👤 Name: \`${abyName}\`\n` +
            `   🔢 Acc No: \`${abyNo}\`\n\n` +
            `━━━━━━━━━━━━━━━━━━━\n` +
            `👇 Tap a bank to update its account:`;

        const keyboard = {
            inline_keyboard: [
                [
                    { text: '🏦 CBE', callback_data: 'adm_dw_edit_acc_cbe' },
                    { text: '📱 CBEBirr', callback_data: 'adm_dw_edit_acc_cbebirr' }
                ],
                [
                    { text: '📲 Telebirr', callback_data: 'adm_dw_edit_acc_telebirr' },
                    { text: '🏛 Abyssinia', callback_data: 'adm_dw_edit_acc_abyssinia' }
                ],
                [{ text: '🔙 Back', callback_data: 'adm_dw_dep_menu' }]
            ]
        };
        return editMsg(chatId, msgId, text, keyboard);
    }

    async function showSettings(chatId, msgId) {
        await loadSettings();
        const mm = (settings.maintenance_mode === true || settings.maintenance_mode === 'true');
        const mmText = mm ? '🛑 *ENABLED*' : '✅ *DISABLED*';
        const na = (settings.notify_agent_requests !== false); // Default true
        const nw = (settings.notify_withdrawals !== false);   // Default true
        const naText = na ? '🔔 *ON*' : '🔕 *OFF*';
        const nwText = nw ? '🔔 *ON*' : '🔕 *OFF*';

        const kb = {
            inline_keyboard: [
                [{ text: (mm ? '✅ Disable Maintenance' : '🛑 Enable Maintenance'), callback_data: 'adm_mm_toggle' }],
                [{ text: (na ? '🔕 Disable Agent Notifications' : '🔔 Enable Agent Notifications'), callback_data: 'adm_notify_agent_toggle' }],
                [{ text: (nw ? '🔕 Disable Withdrawal Notifications' : '🔔 Enable Withdrawal Notifications'), callback_data: 'adm_notify_wd_toggle' }],
                [{ text: '🎯 Change Stake', callback_data: 'adm_set_stake' }, { text: '✍️ Templates', callback_data: 'adm_templates' }],
                [{ text: '💸 Finance Limits', callback_data: 'adm_fin_limits' }],
                [{ text: '🚨 Emergency Kill-switch', callback_data: 'adm_emergency' }],
                [{ text: '🔙 Back', callback_data: 'adm_settings' }]
            ]
        };
        const text = `⚙️ *System Settings & Controls*\n\n` +
            `Maintenance Mode: ${mmText}\n` +
            `Agent Requests Notification: ${naText}\n` +
            `Withdrawals Notification: ${nwText}\n` +
            `Current Stake: *${settings.stake} ETB*\n` +
            `System Fee: *${settings.system_fee} ETB*\n` +
            `Agent Commission: *${settings.agent_commission} ETB*\n\n` +
            `Choose an option to modify:`;
        return editMsg(chatId, msgId, text, kb);
    }

    async function updateStake(chatId, msgId, amount, queryId) {
        const val = parseFloat(amount);
        if (isNaN(val) || val <= 0) return bot.sendMessage(chatId, '❌ Invalid stake amount.');

        // Auto-calculate fee and commission:
        // Owner cut = 20% of stake (e.g. 10 ETB -> 2 ETB per card)
        // Agent commission = 25% of owner cut = 5% of stake (e.g. 10 ETB -> 0.5 ETB per card)
        const fee = parseFloat((val * 0.20).toFixed(2));
        const commission = parseFloat((val * 0.05).toFixed(2));

        // Use saveSetting to ensure sync with game state and broadcast to frontend
        await saveSetting('stake', val);
        await saveSetting('system_fee', fee);
        await saveSetting('agent_commission', commission);

        await log(chatId, 'update_stake', val, `fee:${fee}, comm:${commission}`);
        if (queryId) bot.answerCallbackQuery(queryId, { text: `✅ Stake set to ${val} ETB! Fee: ${fee} ETB, Agent: ${commission} ETB` }).catch(() => { });
        return showSettings(chatId, msgId);
    }

    bot.on('polling_error', err =>
        console.error('[AdminBot] Polling error:', err.code, err.message)
    );

    async function showLogs(chatId, msgId, page = 0) {
        const PAGE_SIZE = 15;
        const offset = page * PAGE_SIZE;

        try {
            const countRes = await db.query('SELECT COUNT(*) AS count FROM admin_log');
            const total = parseInt(countRes.rows[0].count, 10);

            const res = await db.query(
                'SELECT * FROM admin_log ORDER BY created_at DESC LIMIT $1 OFFSET $2',
                [PAGE_SIZE, offset]
            );

            const lines = res.rows.map(l => {
                const date = new Date(l.created_at).toLocaleString('en-GB', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' });
                return `• \`${date}\` *${l.action}* | \`${l.target || ''}\` ${l.detail ? '(' + l.detail + ')' : ''}`;
            });
            const navBtns = [];
            if (page > 0) navBtns.push({ text: '⬅️ Newer', callback_data: `adm_logs_p_${page - 1}` });
            if (offset + PAGE_SIZE < total) navBtns.push({ text: 'Older ➡️', callback_data: `adm_logs_p_${page + 1}` });

            const keyboard = {
                inline_keyboard: [
                    navBtns.length ? navBtns : [],
                    [{ text: '🔙 Main Menu', callback_data: 'adm_back' }]
                ].filter(r => r.length > 0)
            };

            const text = `📜 *Audit Logs* (${total} total)\nPage ${page + 1}\n\n${lines.join('\n') || 'No logs yet.'}`;
            return editMsg(chatId, msgId, text, keyboard);
        } catch (err) {
            console.error('[AdminBot] showLogs error:', err);
            return editMsg(chatId, msgId, '⚠️ Error loading logs.', backBtn());
        }
    }

    async function showSystemHealth(chatId, msgId) {
        let dbStatus = '✅ Connected';
        try { await db.query('SELECT 1'); } catch (e) { dbStatus = '❌ Error'; }

        const mem = process.memoryUsage();
        const uptime = process.uptime();
        const uptimeStr = `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m`;

        const text =
            `🖥 *System Health Monitor*\n\n` +
            `🗄 Database: *${dbStatus}*\n` +
            `⏱ Uptime: *${uptimeStr}*\n` +
            `🧠 RAM Usage: *${(mem.rss / 1024 / 1024).toFixed(1)} MB*\n` +
            `🔄 Mode: *${settings.maintenance_mode === 'true' ? 'Maintenance' : 'Live'}*\n` +
            `💡 System Version: *2.1.0-admin-pro*`;

        return editMsg(chatId, msgId, text, backBtn());
    }

    async function verifyIntegrity(chatId, msgId) {
        
        const res = await db.query('SELECT chat_id, balance, phone_number FROM users');
        let issues = [];
        let checked = 0;

        for (const u of res.rows) {
            checked++;
            const dep = await db.query('SELECT COALESCE(SUM(amount), 0) as total FROM deposits WHERE chat_id = $1', [u.chat_id]);
            const wd = await db.query('SELECT COALESCE(SUM(amount), 0) as total FROM withdrawals WHERE chat_id = $1 AND status = \'completed\'', [u.chat_id]);
            const game = await db.query('SELECT COALESCE(SUM(amount), 0) as total FROM user_game_transactions WHERE userId = $1', [u.chat_id]); // If exists

            // Expected balance (simple logic)
            const expected = parseFloat(dep.rows[0].total) - parseFloat(wd.rows[0].total);
            const actual = parseFloat(u.balance);

            if (Math.abs(expected - actual) > 0.1) {
                issues.push(`⚠️ User \`${u.chat_id}\` (${u.phone_number}): Expected *${expected.toFixed(1)}*, Found *${actual.toFixed(1)}*`);
            }
        }

        const text = `🔍 *Data Integrity Report*\n\n` +
            `Checked: *${checked}* users\n` +
            `Discrepancies: *${issues.length}*\n\n` +
            (issues.length ? issues.join('\n') : '✅ All balances match transaction logs!');

        return editMsg(chatId, msgId, text, backBtn());
    }

    // ─── ADMIN MANAGEMENT (RBAC) ──────────────────────────────────────────────────
    async function showAdminsList(chatId, msgId) {
        const res = await db.query('SELECT chat_id, username, created_at, role FROM admins ORDER BY created_at');
        const kbs = [];
        for (const a of res.rows) {
            const roleStr = a.role === 'SUPER_ADMIN' ? '👑 ' : '🛡️ ';
            kbs.push([{ text: `${roleStr}${a.chat_id} ${a.username ? '@' + a.username : ''}`, callback_data: `adm_admin_view_${a.chat_id}` }]);
        }
        if (await isSuperAdmin(chatId)) {
            kbs.push([
                { text: '➕ Add Admin', callback_data: 'adm_admin_add' },
                { text: '➖ Remove Admin', callback_data: 'adm_admin_rem' }
            ]);
        }
        kbs.push([{ text: '🔙 Back', callback_data: 'adm_back' }]);
        const text = `🛡️ *Manage Admins (${res.rows.length})*\n\nSelect an admin to manage permissions. Only Super Admins can edit permissions.`;
        return editMsg(chatId, msgId, text, { inline_keyboard: kbs });
    }

    async function showAdminDetail(chatId, msgId, targetId) {
        const res = await db.query('SELECT * FROM admins WHERE chat_id = $1', [targetId]);
        if (!res.rows.length) return;
        const adm = res.rows[0];
        const isSuper = String(targetId) === String(SEED_ADMIN_ID) || adm.role === 'SUPER_ADMIN';

        let perms = adm.permissions || {};
        if (typeof perms === 'string') {
            try { perms = JSON.parse(perms); } catch (e) { perms = {}; }
        }

        const kbs = [];
        let row = [];
        for (let i = 0; i < PERM_KEYS.length; i++) {
            const p = PERM_KEYS[i];

            // Super Admins automatically have all standard permissions, so we hide them to avoid clutter.
            // But they MIGHT want to toggle their own notifications, so we still show notification toggles if they are a super admin.
            if (isSuper && p.key !== 'notif_wd' && p.key !== 'notif_ag') continue;

            const has = !!perms[p.key];
            row.push({ text: `${has ? '✅' : '❌'} ${p.label}`, callback_data: `adm_perm_toggle_${targetId}_${p.key}` });
            if (row.length === 2) { kbs.push(row); row = []; }
        }
        if (row.length) kbs.push(row);

        kbs.push([{ text: '🔙 Back to Admins', callback_data: 'adm_admins' }]);

        const updatedAt = new Date().toLocaleTimeString('en-GB');
        const text = `🛡️ *Admin Details*\n\n` +
            `ID: \`${adm.chat_id}\`\n` +
            `Username: ${adm.username ? '@' + adm.username : 'N/A'}\n` +
            `Role: ${isSuper ? '👑 SUPER\_ADMIN' : '🛡️ ADMIN'}\n` +
            `Added By: \`${adm.added_by || 'System'}\`\n` +
            `_Updated: ${updatedAt}_\n\n` +
            (isSuper ? `_Super Admins have full access implicitly._` : `Toggle permissions below:`);

        return editMsg(chatId, msgId, text, { inline_keyboard: kbs });
    }

    async function toggleAdminPermission(chatId, msgId, targetId, permKey, queryId) {
        // answerQuery is one-shot — Telegram ignores duplicate answers
        let _answered = false;
        const ack = (text = '', alert = false) => {
            if (_answered) return;
            _answered = true;
            if (queryId) bot.answerCallbackQuery(queryId, text ? { text, show_alert: alert } : {}).catch(() => {});
        };
        try {
            if (!await isSuperAdmin(chatId)) {
                return ack('⛔ Only Super Admins can toggle permissions.', true);
            }
            if (String(targetId) === String(SEED_ADMIN_ID) && permKey !== 'notif_wd' && permKey !== 'notif_ag') {
                return ack('⛔ Cannot modify Root Admin core permissions.', true);
            }

            const res = await db.query('SELECT permissions FROM admins WHERE chat_id = $1', [targetId]);
            if (!res.rows.length) {
                return ack('❌ Admin not found.', true);
            }

            let perms = res.rows[0].permissions || {};
            if (typeof perms === 'string') {
                try { perms = JSON.parse(perms); } catch (e) { perms = {}; }
            }

            perms[permKey] = !perms[permKey]; // flip
            await db.query('UPDATE admins SET permissions = $1 WHERE chat_id = $2', [JSON.stringify(perms), targetId]);

            ack(`${perms[permKey] ? '✅' : '❌'} ${permKey} is now ${perms[permKey] ? 'ON' : 'OFF'}`);
            return showAdminDetail(chatId, msgId, targetId);
        } catch (err) {
            console.error('[AdminBot] toggleAdminPermission error:', err.message);
            ack(`❌ Error: ${err.message.slice(0, 100)}`, true);
        }
    }

    // ─── Game Monitor & History ──────────────────────────────────────────────────
    async function showGameMonitor(chatId, msgId) {
        try {
            const st = await gameState.getFullState(chatId);

            const phaseEmoji = st.phase === 'lobby' ? '⏳' : st.phase === 'playing' ? '🎲' : '✅';
            const phaseText = st.phase === 'lobby' ? 'Waiting (Lobby)' : st.phase === 'playing' ? 'Running' : 'Finished';

            let text = `🎮 *Live Game Monitor*\n\n`;
            text += `🚦 Status: ${phaseEmoji} *${phaseText}*\n`;
            text += `⏱ Timer: *${st.timer}s*\n`;
            text += `👥 Players in Room: *${st.playerCount}*\n`;
            text += `🎟 Cards Sold: *${st.totalTaken}*\n`;
            text += `💰 Win Pot: *${parseFloat(st.winPot).toFixed(2)} ETB*\n`;
            text += `🎯 Current Stake: *${st.stake} ETB*\n\n`;

            if (st.phase === 'playing') {
                text += `🔢 Numbers Called: *${st.calledNumbers.length} / 75*\n`;
                text += `🔄 Last Call: *${st.calledNumbers[st.calledNumbers.length - 1] || 'None'}*\n`;
            }

            const kb = {
                inline_keyboard: [
                    [{ text: '🔄 Refresh Status', callback_data: 'adm_game_monitor' }],
                    [{ text: '👥 Active Users (Cards Taken)', callback_data: 'adm_game_active_users' }],
                    [{ text: '🏆 Set Next Winners', callback_data: 'adm_set_forced_winners' }],
                    [{ text: '📜 Game History (Last 100)', callback_data: 'adm_game_history' }],
                    [{ text: '🔙 Main Menu', callback_data: 'adm_back' }]
                ]
            };

            return editMsg(chatId, msgId, text, kb);
        } catch (err) {
            console.error('[AdminBot] Game Monitor error:', err);
            return editMsg(chatId, msgId, '⚠️ Error loading game monitor.', backBtn());
        }
    }

    async function showActiveGameUsers(chatId, msgId) {
        try {
            const takenCardsMap = gameState.takenCards;

            if (!takenCardsMap || takenCardsMap.size === 0) {
                return editMsg(
                    chatId,
                    msgId,
                    '🎮 *Active Users*\n\n_No users have taken cards in the current game._',
                    backBtn('adm_game_monitor')
                );
            }

            // ── Aggregate cards per user, split robots from real users ──────────
            const userCards = {};   // { [userId]: [cardIds] }
            const robotCards = {};  // { [robotId]: { name, cards[] } }

            takenCardsMap.forEach((info, cardId) => {
                const uIdStr = String(info.userId);
                if (uIdStr.startsWith('robot_')) {
                    if (!robotCards[uIdStr]) robotCards[uIdStr] = { name: info.userName, cards: [] };
                    robotCards[uIdStr].cards.push(cardId);
                } else {
                    if (!userCards[uIdStr]) userCards[uIdStr] = [];
                    userCards[uIdStr].push(cardId);
                }
            });

            const realUserIds = Object.keys(userCards);
            const robotIds = Object.keys(robotCards);

            let text = `👥 *Active Users in Game*\n━━━━━━━━━━━━━━━━━━━━\n\n`;

            // ── Real users — fetch from DB ───────────────────────────────────────
            let counter = 1;
            if (realUserIds.length > 0) {
                const res = await db.query(
                    'SELECT chat_id, first_name, username, balance FROM users WHERE chat_id = ANY($1::bigint[])',
                    [realUserIds]
                );

                res.rows.forEach((u) => {
                    const name = esc(
                        u.first_name ||
                        (u.username ? '@' + u.username : String(u.chat_id))
                    );
                    const cardsArray = (userCards[String(u.chat_id)] || []).sort((a, b) => a - b);
                    const cardsText = cardsArray.length > 0 ? cardsArray.map(c => `#${c}`).join(' & ') : 'None';

                    text += `${counter}. 👤 *${name}*\n`;
                    text += `   ├ Cards: *${cardsText}*\n`;
                    text += `   └ Bal: \`${parseFloat(u.balance).toFixed(2)} ETB\`\n\n`;
                    counter++;
                });
            }

            // ── Robots — list name + cards, hide balance ─────────────────────────
            if (robotIds.length > 0) {
                robotIds.forEach((rid) => {
                    const { name, cards } = robotCards[rid];
                    const cardsArray = cards.sort((a, b) => a - b);
                    const cardsText = cardsArray.map(c => `#${c}`).join(' & ');

                    text += `${counter}. 🤖 *${esc(name)}*\n`;
                    text += `   ├ Cards: *${cardsText}*\n`;
                    text += `   └ Bal: _🤖 Robot_\n\n`;
                    counter++;
                });
            }

            // ── Summary footer ────────────────────────────────────────────────────
            text += `━━━━━━━━━━━━━━━━━━━━\n`;
            text += `👤 Real: *${realUserIds.length}* | 🤖 Robots: *${robotIds.length}* | Total cards: *${takenCardsMap.size}*`;

            const kb = {
                inline_keyboard: [
                    [{ text: '🔄 Refresh Active Users', callback_data: 'adm_game_active_users' }],
                    [{ text: '🔙 Back to Monitor', callback_data: 'adm_game_monitor' }]
                ]
            };

            return editMsg(chatId, msgId, text, kb);

        } catch (err) {
            console.error('[AdminBot] Active Users error:', err);
            return editMsg(
                chatId,
                msgId,
                '⚠️ Error loading active users.',
                backBtn('adm_game_monitor')
            );
        }
    }

    async function showAdminGameHistory(chatId, msgId, page = 0) {
        const PAGE_SIZE = 10;
        const offset = page * PAGE_SIZE;
        try {
            const countRes = await db.query('SELECT COUNT(*) AS count FROM game_history');
            const total = parseInt(countRes.rows[0].count, 10);

            const res = await db.query('SELECT * FROM game_history ORDER BY id DESC LIMIT $1 OFFSET $2', [PAGE_SIZE, offset]);
            if (!res.rows.length) {
                return editMsg(chatId, msgId, '📜 *Game History*\n\nNo games completed yet.', backBtn('adm_game_monitor'));
            }

            let text = `📜 *Game History* (${total} total)\nPage ${page + 1}\n\n`;
            for (const g of res.rows) {
                const d = new Date(g.created_at).toLocaleString('en-GB', { timeZone: 'Africa/Addis_Ababa', hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' });
                text += `🎲 *Game #${g.id}* — 📅 \`${d}\`\n`;
                text += `👥 Players: ${g.player_count} | 💰 Pot: ${parseFloat(g.total_pot).toFixed(2)} ETB\n`;

                let winners = [];
                try {
                    winners = typeof g.winners === 'string' ? JSON.parse(g.winners) : g.winners;
                } catch (e) { }

                if (winners && winners.length > 0) {
                    text += `🏆 Winners:\n` + winners.map(w => {
                        const basePrize = parseFloat(w.prize || 0);
                        const bonus = parseFloat(w.winnerBonus || 0);
                        const totalWin = basePrize + bonus;
                        const winText = bonus > 0 
                            ? `${basePrize.toFixed(2)} ETB + bonus ${bonus.toFixed(2)} ETB = ${totalWin.toFixed(2)} ETB`
                            : `${basePrize.toFixed(2)} ETB`;
                        return `  └ ${esc(w.name)} (\`${w.id}\`) (*${winText}*)`;
                    }).join('\n') + `\n\n`;
                } else {
                    text += `🏆 Winners: None (House won)\n\n`;
                }
            }

            const navBtns = [];
            if (page > 0) navBtns.push({ text: '⬅️ Newer', callback_data: `adm_game_hist_p_${page - 1}` });
            if (offset + PAGE_SIZE < total) navBtns.push({ text: 'Older ➡️', callback_data: `adm_game_hist_p_${page + 1}` });

            const kb = {
                inline_keyboard: [
                    navBtns.length ? navBtns : [],
                    [{ text: '🔙 Back to Monitor', callback_data: 'adm_game_monitor' }]
                ]
            };
            return editMsg(chatId, msgId, text, kb);
        } catch (err) {
            console.error('[AdminBot] Game History error:', err);
            return editMsg(chatId, msgId, '⚠️ Error loading game history.', backBtn('adm_game_monitor'));
        }
    }

    // ─── Transaction Verifier ─────────────────────────────────────────────────────
    /**
     * Extracts a Transaction ID from raw text (e.g. SMS).
     * Supports: Telebirr (TEL...), CBE (FT...), CBEBirr (Digits), Abyssinia (FT...)
     */
    function extractTxId(text) {
        if (!text) return '';
        text = text.trim();

        // 1. Check for full receipt URLs first (highest confidence)
        const urlMatch = text.match(/(https?:\/\/(?:transactioninfo\.ethiotelecom\.et|cbepay1\.cbe\.com\.et|apps\.cbe\.com\.et|cs\.bankofabyssinia\.com)\/[^\s\"']+)/i);
        if (urlMatch) {
            const url = urlMatch[1];
            const idFromUrl = url.match(/[/?](?:receipt\/|TID=|id=|trx=)([A-Z0-9]+)/i);
            if (idFromUrl) return idFromUrl[1].toUpperCase();
        }

        // 2. Specific patterns (ignoring \b for Amharic compatibility)
        const patterns = [
            /(?:txn?\s*id)[:\s]+([A-Z0-9]{8,25})/i,
            /(?:transaction\s*(?:number|id|no\.?)[:\s]+)([A-Z0-9]{8,25})/i,
            /ID[:\s]+(TEL[A-Z0-9]{10,15})/i,
            /ID[:\s]+(FT[A-Z0-9]{10,20})/i,
            /TID[:\s]*(\d{8,15})/i,
        ];

        for (const p of patterns) {
            const m = text.match(p);
            if (m && m[1]) {
                const id = m[1].toUpperCase();
                if (id.length >= 8) return id;
            }
        }

        // 3. Fallback: Split by Amharic and Latin whitespace/separators
        // Ethiopic separators: ፡ (comma), ። (full stop), ፣ (comma), ፤ (semicolon)
        const words = text.split(/[\s,;፡።,;፡።፣፤]+/).map(w => w.replace(/^[^\w\d]+|[^\w\d]+$/gi, ''));

        // Priority prefixes
        const priorityPrefixes = ['FT', 'TEL', 'TX', 'DCC', 'DBD', 'CR', 'TID'];
        for (const w of words) {
            const up = w.toUpperCase();
            if (up.length >= 8 && up.length <= 25) {
                if (priorityPrefixes.some(p => up.startsWith(p))) return up;
            }
        }

        // Any word that has both letters and numbers
        for (const w of words) {
            const up = w.toUpperCase();
            if (up.length >= 8 && up.length <= 25) {
                if (/[A-Z]/.test(up) && /[0-9]/.test(up)) return up;
                if (/^\d{10,15}$/.test(up)) return up; // Pure digits
            }
        }

        // Last resort: If the whole input is short and alphanumeric
        const cleanShort = text.replace(/^[^\w\d]+|[^\w\d]+$/gi, '').toUpperCase();
        return cleanShort.length >= 8 && cleanShort.length <= 25 && !cleanShort.includes(' ') ? cleanShort : '';
    }

    /**
     * Extracts a phone number hint from raw SMS text.
     * Used for CBEBirr lookups that require a PH (phone) parameter.
     * Returns the first Ethiopian phone number found (09XXXXXXXX or 2519XXXXXXXX).
     */
    function extractPhoneHint(text) {
        if (!text) return '';
        // Match 09XXXXXXXX or 2519XXXXXXXX or +2519XXXXXXXX patterns
        const m = text.match(/(\+?251\s*9[\s\-]?\d[\s\-]?\d[\s\-]?\d[\s\-]?\d[\s\-]?\d[\s\-]?\d[\s\-]?\d[\s\-]?\d)|(0\s*9[\s\-]?\d[\s\-]?\d[\s\-]?\d[\s\-]?\d[\s\-]?\d[\s\-]?\d[\s\-]?\d[\s\-]?\d)/);
        if (!m) return '';
        const raw = (m[0] || '').replace(/[\s\-\+]/g, '');
        if (raw.startsWith('251')) return raw;
        if (raw.startsWith('09')) return '251' + raw.slice(1);
        return raw;
    }

    async function handleTxVerify(chatId, input) {
        try {
            const txId = extractTxId(input);
            if (!txId) return bot.sendMessage(chatId, '❌ Could not find a valid Transaction ID in the text provided.');
            // Extract phone hint from input (useful for CBEBirr receipt lookup)
            const phoneHint = extractPhoneHint(input);

            // Send "looking up..." message
            const waitMsg = await bot.sendMessage(chatId,
                '🔍 *Looking up transaction:* `' + esc(txId) + '`...\nChecking Telebirr, CBEBirr, CBE, Abyssinia...',
                { parse_mode: 'Markdown' }
            );

            // ── Step 1: Check deposits DB (user already deposited this?) ──
            const depCheck = await db.query(
                `SELECT d.tx_id, d.amount, d.method, d.created_at, u.first_name, u.username, u.phone_number, u.chat_id
                 FROM deposits d LEFT JOIN users u ON u.chat_id = d.chat_id
                 WHERE d.tx_id ILIKE $1`,
                [txId]
            );

            // ── Step 2: Check used_transactions DB (admin manually marked?) ──
            const usedCheck = await db.query(
                'SELECT * FROM used_transactions WHERE tx_id ILIKE $1', [txId]
            );

            // ── Step 3: Scrape / lookup the actual transaction from bank ──
            let txInfo = null;
            try {
                txInfo = await lookupTransaction(txId, phoneHint);
            } catch (err) {
                console.error('[AdminBot] TX lookup error:', err.message);
            }

            bot.deleteMessage(chatId, waitMsg.message_id).catch(() => { });

            // Build the response
            let text = `🔍 *Transaction Verifier*\n\n🆔 TX ID: \`${esc(txId)}\`\n`;

            // Bank info
            if (txInfo && txInfo.ok) {
                text += `🏦 Bank: *${txInfo.method}*\n`;
                text += `💰 Amount: *${parseFloat(txInfo.amount).toFixed(2)} ETB*\n`;
                if (txInfo.receiverName) text += `📥 Receiver: *${esc(txInfo.receiverName)}*\n`;
                if (txInfo.receiverAccount) text += `🏧 Receiver Acc: \`${esc(txInfo.receiverAccount)}\`\n`;
                if (txInfo.senderName) text += `📤 Sender: *${esc(txInfo.senderName)}*\n`;
                if (txInfo.senderAccount) text += `🏧 Sender Acc: \`${esc(txInfo.senderAccount)}\`\n`;
                if (txInfo.date) text += `📅 Date: \`${esc(txInfo.date)}\`\n`;
            } else {
                text += `🏦 Bank info: _Could not fetch from bank (receipt may have expired or TX ID format unknown)_\n`;
            }

            text += '\n━━━━━━━━━━━━━━━━━\n';

            const keyboard = [];

            // DB status
            if (depCheck.rows.length > 0) {
                const d = depCheck.rows[0];
                const userName = esc(d.first_name || (d.username ? '@' + d.username : 'Unknown'));
                const date = new Date(d.created_at).toLocaleString('en-GB', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit', year: 'numeric' });
                text += `🔴 *STATUS: ALREADY USED (Deposit)*\n\n`;
                text += `👤 Used By: *${userName}*\n`;
                text += `📱 Phone: ${esc(d.phone_number || 'N/A')}\n`;
                text += `🆔 User ID: \`${d.chat_id}\`\n`;
                text += `💰 Deposited: *${d.amount} ETB* (${esc(d.method)})\n`;
                text += `📅 Deposited At: \`${date}\`\n\n`;
                text += `⚠️ _This TX ID was submitted by a user. Decline the request._`;
                keyboard.push([{ text: '👤 View User Profile', callback_data: `adm_user_view_${d.chat_id}` }]);
            } else if (usedCheck.rows.length > 0) {
                const u = usedCheck.rows[0];
                const markedAt = new Date(u.marked_at).toLocaleString('en-GB', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit', year: 'numeric' });
                text += `🔴 *STATUS: ALREADY MARKED AS USED (Admin)*\n\n`;
                text += `📅 Marked At: \`${markedAt}\`\n`;
                text += `🏦 Bank: ${esc(u.bank || 'N/A')}\n`;
                text += `💰 Amount: ${u.amount ? parseFloat(u.amount).toFixed(2) + ' ETB' : 'N/A'}\n\n`;
                text += `⚠️ _This TX ID was already manually verified and marked. Decline if submitted again._`;
            } else {
                text += `✅ *STATUS: UNUSED*\n\n`;
                text += `This TX ID has NOT been used in any deposit and has NOT been marked by admin.\n\n`;
                text += `✅ _Safe to approve after verifying the details above._`;
                keyboard.push([{ text: '✅ Mark as Used (Fraud Prevention)', callback_data: `adm_tx_mark_used_${txId}` }]);
            }

            keyboard.push([{ text: '🔙 Main Menu', callback_data: 'adm_back' }]);

            return bot.sendMessage(chatId, text, {
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: keyboard }
            });
        } catch (e) {
            console.error('[AdminBot] handleTxVerify crash prevented:', e);
            return bot.sendMessage(chatId, '⚠️ Error processing transaction verification. Please try with just the ID.');
        }
    }

    async function markTxAsUsed(chatId, msgId, adminId, txId) {
        try {
            // Get TX info if available (for storage)
            let txInfo = null;
            try { txInfo = await lookupTransaction(txId); } catch (_) { }

            await db.query(
                `INSERT INTO used_transactions (tx_id, bank, amount, receiver_name, receiver_account, sender_name, sender_account, tx_date, marked_by)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                 ON CONFLICT (tx_id) DO NOTHING`,
                [
                    txId,
                    txInfo?.method || null,
                    txInfo?.amount || null,
                    txInfo?.receiverName || null,
                    txInfo?.receiverAccount || null,
                    txInfo?.senderName || null,
                    txInfo?.senderAccount || null,
                    txInfo?.date || null,
                    adminId
                ]
            );

            await log(adminId, 'mark_tx_used', txId, `Bank: ${txInfo?.method || 'unknown'}, Amount: ${txInfo?.amount || '?'}`);

            bot.editMessageText(
                `✅ *Transaction Marked as Used*\n\n` +
                `🆔 TX ID: \`${esc(txId)}\`\n` +
                `🏦 Bank: ${txInfo?.method || 'N/A'}\n` +
                `💰 Amount: ${txInfo?.amount ? parseFloat(txInfo.amount).toFixed(2) + ' ETB' : 'N/A'}\n\n` +
                `This TX ID is now stored. If a user tries to reuse it, it will be flagged as fraud.`,
                { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: backBtn() }
            ).catch(() => {
                bot.sendMessage(chatId, `✅ TX \`${esc(txId)}\` marked as used.`, { parse_mode: 'Markdown', reply_markup: backBtn() });
            });
        } catch (err) {
            console.error('[AdminBot] markTxAsUsed error:', err);
            bot.sendMessage(chatId, '⚠️ Error marking transaction. It may already be marked.');
        }
    }
    // ──────────────────────────────────────────────────────────────────────────────

    async function showSecurityLogs(chatId, msgId) {
        if (!await isSuperAdmin(chatId)) return;

        try {
            const res = await db.query(`
                SELECT s.*, u.first_name, u.username, u.phone_number 
                FROM suspicious_logs s
                LEFT JOIN users u ON s.chat_id = u.chat_id
                ORDER BY s.created_at DESC LIMIT 20
            `);

            if (!res.rows.length) return editMsg(chatId, msgId, '🚨 *Security Logs*\n\n✅ No suspicious activity detected.', backBtn());

            const lines = res.rows.map(s => {
                const date = new Date(s.created_at).toLocaleString('en-GB', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' });
                const name = esc(s.first_name || (s.username ? '@' + s.username : String(s.chat_id)));
                return `🚨 *${s.type}*\n👤 User: [${name}](tg://user?id=${s.chat_id}) (\`${s.chat_id}\`)\n📝 Details: \`${esc(s.details)}\`\n📅 \`${date}\``;
            });

            return editMsg(chatId, msgId, `🚨 *Security Logs (Last 20)*\n\n${lines.join('\n\n')}`, backBtn());
        } catch (err) {
            console.error('[AdminBot] Security log error:', err);
            return editMsg(chatId, msgId, '⚠️ Error loading security logs.', backBtn());
        }
    }
    // ──────────────────────────────────────────────────────────────────────────────

    // ─── Broadcast Interactive UI ────────────────────────────────────────────────
    async function renderBroadcastPreview(chatId, msgId, st) {
        let text = `📢 *Broadcast Preview*\n\nType: *${st.type.toUpperCase()}*\n`;
        if (st.image) text += `🖼️ [Image Attached]\n`;
        if (st.text) text += `---\n${st.text}\n---\n`;
        text += `\n_Configure buttons below, then send:_`;

        const kb = {
            inline_keyboard: [
                [{ text: `${st.attachPlay ? '✅' : '❌'} Button: Play Now`, callback_data: 'adm_bc_toggle_play' }],
                [{ text: `${st.attachInvite ? '✅' : '❌'} Button: Invite Friends`, callback_data: 'adm_bc_toggle_invite' }],
                [{ text: '🚀 Send Broadcast', callback_data: 'adm_bc_send' }],
                [{ text: '❌ Cancel', callback_data: 'adm_back' }]
            ]
        };

        if (st.image) {
            if (msgId) bot.deleteMessage(chatId, msgId).catch(() => { });
            return bot.sendPhoto(chatId, st.image, { caption: text, parse_mode: 'Markdown', reply_markup: kb });
        }
        return editMsg(chatId, msgId, text, kb);
    }

    async function executeBroadcast(chatId, msgId, st) {
        if (msgId && !st.image) bot.editMessageText('⏳ *Sending broadcast... Please wait.*', { chat_id: chatId, message_id: msgId }).catch(() => { });
        else bot.sendMessage(chatId, '⏳ *Sending broadcast... Please wait.*', { parse_mode: 'Markdown' });

        const users = await db.query('SELECT chat_id FROM users');
        let sent = 0, failed = 0;

        const opts = { parse_mode: 'Markdown' };
        let row = [];
        if (st.attachPlay) row.push({ text: '🎮 Play Now', web_app: { url: FRONTEND_URL } });
        if (st.attachInvite) row.push({ text: '🔗 Invite Friends', url: `https://t.me/${BINGO_BOT_USERNAME}?start=invite` });
        if (row.length > 0) opts.reply_markup = { inline_keyboard: [row] };

        const targetBot = bingoBot || bot;

        // st.image is a file_id from the admin bot.
        // Download the image as a Buffer so Telegram does not need to fetch any URL.
        let imageBuffer = null;
        if (st.image) {
            try {
                const fileLink = await bot.getFileLink(st.image);
                imageBuffer = await new Promise((resolve, reject) => {
                    const parsed = new URL(fileLink);
                    const lib = parsed.protocol === 'https:' ? require('https') : require('http');
                    lib.get(fileLink, (res) => {
                        const chunks = [];
                        res.on('data', c => chunks.push(c));
                        res.on('end', () => resolve(Buffer.concat(chunks)));
                        res.on('error', reject);
                    }).on('error', reject);
                });
            } catch (dlErr) {
                console.error('[AdminBot] Failed to download broadcast image:', dlErr.message);
                bot.sendMessage(chatId, '❌ Failed to download the image. Please send the broadcast again with a newly uploaded image.', { parse_mode: 'Markdown' });
                return;
            }
        }

        for (const { chat_id } of users.rows) {
            try {
                if (imageBuffer) {
                    await targetBot.sendPhoto(chat_id, imageBuffer, { ...opts, caption: st.text || '' });
                } else if (st.text) {
                    await targetBot.sendMessage(chat_id, st.text, opts);
                }
                sent++;
            } catch (_) { failed++; }
        }

        await log(chatId, 'broadcast', st.type, (st.text || 'Image only').slice(0, 80));

        const kb = { inline_keyboard: [[{ text: '🔙 Main Menu', callback_data: 'adm_back' }]] };
        return bot.sendMessage(chatId, `📢 *Broadcast complete*\n\n✅ Sent: ${sent}\n❌ Failed: ${failed}`, { parse_mode: 'Markdown', reply_markup: kb });
    }
    // ──────────────────────────────────────────────────────────────────────────────

    // ─── GLOBAL WITHDRAWALS ───────────────────────────────────────────────────────
    async function showGlobalWithdrawals(chatId, msgId, isAgent, page = 0) {
        const PAGE_SIZE = 10;
        const offset = page * PAGE_SIZE;
        const table = isAgent ? 'agent_withdrawals' : 'withdrawals';
        const userTable = isAgent ? 'agents' : 'users';
        const title = isAgent ? 'Agent' : 'User';
        const cbBase = isAgent ? 'adm_g_wd_a_p_' : 'adm_g_wd_u_p_';

        try {
            const countRes = await db.query(`SELECT COUNT(*) AS count FROM ${table} WHERE status != 'pending'`);
            const total = parseInt(countRes.rows[0].count, 10);

            const res = await db.query(`
                SELECT w.*, u.first_name, u.username ${!isAgent ? ', u.phone_number' : ''}
                FROM ${table} w
                LEFT JOIN ${userTable} u ON u.chat_id = w.${isAgent ? 'agent_id' : 'chat_id'}
                WHERE w.status != 'pending'
                ORDER BY w.created_at DESC
                LIMIT $1 OFFSET $2
            `, [PAGE_SIZE, offset]);

            const lines = res.rows.map(w => {
                const d = new Date(w.created_at).toLocaleString('en-GB', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' });
                const phone = !isAgent ? ` (${esc(w.phone_number) || 'No Phone'})` : '';
                const name = esc(w.first_name || (w.username ? '@' + w.username : 'Unknown'));
                const status = w.status === 'completed' ? '✅' : '❌';
                return `• ${status} *${w.amount} ETB* via ${esc(w.method)}\n  └ ${name}${phone} | \`${d}\``;
            });

            const navBtns = [];
            if (page > 0) navBtns.push({ text: '⬅️ Newer', callback_data: `${cbBase}${page - 1}` });
            if (offset + PAGE_SIZE < total) navBtns.push({ text: 'Older ➡️', callback_data: `${cbBase}${page + 1}` });

            const kbs = {
                inline_keyboard: [
                    navBtns.length ? navBtns : [],
                    [{ text: '🔙 Back', callback_data: 'adm_back' }]
                ].filter(r => r.length > 0)
            };

            const text = `📜 *Global ${title} Withdrawals* (History)\nTotal: ${total} | Page ${page + 1}\n\n${lines.join('\n\n') || 'No history found.'}`;
            return editMsg(chatId, msgId, text, kbs);
        } catch (err) {
            console.error('[AdminBot] showGlobalWithdrawals error:', err);
            return editMsg(chatId, msgId, '⚠️ Error loading history.', backBtn());
        }
    }

    // Export settings so gameState.js can read them
    module.exports = {
        bot,
        getSettings: () => settings,
        reloadSettings: loadSettings,
        processUpdate: (update) => bot.processUpdate(update)
    };
    console.log('[AdminBot] Admin bot initialized (Webhook mode)');
}
