/**
 * agentBot.js
 * Smart Bingo — Agent Bot
 *
 * Self-service agent registration flow:
 *   /start (non-agent) → Request buttons → confirmation → admin approval → referral link
 *   /start (approved)  → dashboard menu with buttons
 *
 * Commission: 1 ETB per card played by referred users (25% of 4 ETB owner cut)
 * Withdrawal: any day, minimum 100 ETB
 */

require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const db = require('./db');

const AGENT_BOT_TOKEN = process.env.AGENT_BOT_TOKEN;
const ADMIN_BOT_TOKEN = process.env.ADMIN_BOT_TOKEN;
const BINGO_BOT_USERNAME = process.env.BINGO_BOT_USERNAME || 'SmartBingo12Bot';
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;
const SUPPORT_USERNAME = '@Smartbingosupport';
const WEBAPP_URL = process.env.WEBAPP_URL || process.env.FRONTEND_URL || 'http://localhost:5173';

if (!AGENT_BOT_TOKEN) {
    console.warn('[AgentBot] AGENT_BOT_TOKEN not set in .env — agent bot disabled');
    module.exports = null;
} else {
    const isLocal = process.env.USE_POLLING === 'true' || !WEBAPP_URL || WEBAPP_URL.includes('localhost') || !WEBAPP_URL.includes('http');
    // webHook:false — Express handles the webhook route in server.js
    const botOptions = { polling: isLocal, webHook: false };
    const bot = new TelegramBot(AGENT_BOT_TOKEN, botOptions);

    // Admin bot instance used only for sending messages (no polling)
    const adminBotModule = require('./adminBot');
    const adminMessenger = adminBotModule.bot;

    // Patch sendMessage to log outgoing messages
    const originalSendMessage = bot.sendMessage.bind(bot);
    bot.sendMessage = async (...args) => {
        console.log(`[AgentBot] Sending message to ${args[0]}: "${args[1].slice(0, 50)}..."`);
        return originalSendMessage(...args);
    };

    bot.setMyCommands([
        { command: 'start', description: 'Open Agent Dashboard' },
    ]).catch(err => console.error('[AgentBot] Failed to set commands:', err));

    bot.on('message', (msg) => {
        console.log(`[AgentBot] Message from ${msg.chat.id}: "${msg.text || '[not text]'}"`);
    });

    const pendingWithdraw = {};



    async function checkMaintenance(chatId) {
        const settings = adminBotModule.getSettings();
        if (settings.maintenance_mode === true || settings.maintenance_mode === 'true') {
            const isAdmin = await db.query('SELECT 1 FROM admins WHERE chat_id = $1', [chatId]);
            if (isAdmin.rows.length === 0) {
                bot.sendMessage(chatId, '🛠 *System Maintenance*\n\nThe agent system is currently undergoing maintenance. Please try again later!', { parse_mode: 'Markdown' });
                return true;
            }
        }
        return false;
    }

    // ─── Helpers ─────────────────────────────────────────────────────────────────

    async function getAgent(chatId) {
        const res = await db.query(
            'SELECT chat_id, first_name, username, balance, is_approved, is_blocked, referral_code FROM agents WHERE chat_id = $1',
            [chatId]
        );
        return res.rows[0] || null;
    }

    function referralLink(agentChatId) {
        return `https://t.me/${BINGO_BOT_USERNAME}?start=ref_${agentChatId}`;
    }

    const esc = (text) => {
        if (!text) return '';
        return String(text).replace(/[_*[\]()~`>#+-=|{}.!]/g, '\\$&');
    };

    async function showAgentWithdrawalHistory(chatId, msgId, page = 0) {
        const PAGE_SIZE = 10;
        const offset = page * PAGE_SIZE;

        try {
            const countRes = await db.query('SELECT COUNT(*) FROM agent_withdrawals WHERE agent_id = $1', [chatId]);
            const total = parseInt(countRes.rows[0].count, 10);

            const res = await db.query(
                'SELECT * FROM agent_withdrawals WHERE agent_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3',
                [chatId, PAGE_SIZE, offset]
            );

            const lines = res.rows.map(w => {
                const date = new Date(w.created_at).toLocaleString('en-GB', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit', year: 'numeric' });
                const status = w.status === 'completed' ? '✅' : w.status === 'pending' ? '⏳' : '❌';
                return `• ${status} *${w.amount} ETB* via ${esc(w.method)}\n  📅 \`${date}\` | \`${esc(w.account_details)}\``;
            });

            const navBtns = [];
            if (page > 0) navBtns.push({ text: '⬅️ Prev', callback_data: `ag_wd_history_p_${page - 1}` });
            if (offset + PAGE_SIZE < total) navBtns.push({ text: 'Next ➡️', callback_data: `ag_wd_history_p_${page + 1}` });

            const keyboard = {
                inline_keyboard: [
                    navBtns.length ? navBtns : [],
                    [{ text: '🔙 Back', callback_data: 'ag_back' }]
                ].filter(r => r.length > 0)
            };

            const text = `📜 *Withdrawal History* (${total} total)\nPage ${page + 1}\n\n${lines.join('\n\n') || '_No withdrawals yet._'}`;

            if (msgId) {
                return bot.editMessageText(text, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: keyboard });
            }
            return bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: keyboard });
        } catch (err) {
            console.error('[AgentBot] showAgentWithdrawalHistory error:', err);
            const errorText = '⚠️ Error loading withdrawal history.';
            if (msgId) return bot.editMessageText(errorText, { chat_id: chatId, message_id: msgId, reply_markup: { inline_keyboard: [[{ text: '🔙 Back', callback_data: 'ag_back' }]] } });
            return bot.sendMessage(chatId, errorText, { reply_markup: { inline_keyboard: [[{ text: '🔙 Back', callback_data: 'ag_back' }]] } });
        }
    }

    // ─── Dashboard menu (for approved agents) ─────────────────────────────────────
    function dashboardKeyboard() {
        return {
            inline_keyboard: [
                [
                    { text: '💰 My Balance', callback_data: 'ag_balance' },
                    { text: '👥 My Invited Users', callback_data: 'ag_users' },
                ],
                [
                    { text: '🔗 My Referral Link', callback_data: 'ag_reflink' },
                    { text: '📈 Earnings Report', callback_data: 'ag_report' },
                ],
                [
                    { text: '💸 Withdraw', callback_data: 'ag_withdraw' },
                    { text: '📜 Withdrawal History', callback_data: 'ag_wd_history' },
                ],
                [
                    { text: 'ℹ️ Help', callback_data: 'ag_help' },
                ],
            ]
        };
    }

    async function sendDashboard(chatId, agentName, editMsgId) {
        const text =
            `👨‍💼 *Agent Dashboard*\n\n` +
            `Welcome, *${agentName}*! 🎉\n\n` +
            `Choose an option below:`;

        if (editMsgId) {
            return bot.editMessageText(text, {
                chat_id: chatId,
                message_id: editMsgId,
                parse_mode: 'Markdown',
                reply_markup: dashboardKeyboard(),
            });
        }
        return bot.sendMessage(chatId, text, {
            parse_mode: 'Markdown',
            reply_markup: dashboardKeyboard(),
        });
    }

    // ─── /start ──────────────────────────────────────────────────────────────────
    bot.onText(/\/start/, async (msg) => {
        const chatId = msg.chat.id;
        delete pendingWithdraw[chatId];

        try {
            const agent = await getAgent(chatId);

            // ── APPROVED AGENT → check if blocked, else dashboard ──
            if (agent && agent.is_approved) {
                if (agent.is_blocked) {
                    return bot.sendMessage(chatId, '⛔ *Your agent account has been suspended.* Contact support for more info.', { parse_mode: 'Markdown' });
                }
                const name = agent.first_name || agent.username || `Agent_${chatId}`;
                return sendDashboard(chatId, name);
            }

            // ── PENDING REQUEST? ──
            const pendingRes = await db.query(
                'SELECT chat_id FROM pending_agents WHERE chat_id = $1',
                [chatId]
            );
            if (pendingRes.rows.length > 0) {
                return bot.sendMessage(chatId,
                    `⏳ *Request Pending*\n\n` +
                    `Your agent request has been submitted and is awaiting admin approval.\n\n` +
                    `We will notify you once it's approved!`,
                    { parse_mode: 'Markdown' }
                );
            }

            // ── NOT AN AGENT → show registration option ──
            return bot.sendMessage(chatId,
                `❌ *You are not registered as an agent*\n\n` +
                `Press the button below to apply and start earning commissions!`,
                {
                    parse_mode: 'Markdown',
                    reply_markup: {
                        inline_keyboard: [[
                            { text: '📝 Request Agent', callback_data: 'ag_req_start' },
                            { text: '❌ Cancel', callback_data: 'ag_req_cancel' },
                        ]]
                    }
                }
            );
        } catch (err) {
            console.error('[AgentBot] /start error:', err);
            bot.sendMessage(chatId, '⚠️ Sorry, there was an issue opening your dashboard. Please try again or contact support if the problem persists.', { parse_mode: 'Markdown' });
        }
    });

    // ─── Callback query handler ───────────────────────────────────────────────────
    bot.on('callback_query', async (query) => {
        try {
            const chatId = query.message.chat.id;
            if (await checkMaintenance(chatId)) return bot.answerCallbackQuery(query.id);

            const msgId = query.message.message_id;
            const data = query.data;
            const fromId = query.from.id;
            const settings = adminBotModule.getSettings();

            // Handle withdrawal kill-switch
            if (data === 'ag_withdraw') {
                if (settings.kill_withdrawals === true || settings.kill_withdrawals === 'true') {
                    return bot.answerCallbackQuery(query.id, { text: '🚫 Withdrawals are temporarily disabled.', show_alert: true });
                }
            }

            bot.answerCallbackQuery(query.id).catch(() => { });

            // ════════════════════════════════════════════════════════════════════
            // REGISTRATION FLOW
            // ════════════════════════════════════════════════════════════════════

            if (data === 'ag_req_start') {
                return bot.editMessageText(
                    `📋 *Agent Request*\n\nAre you sure you want to apply to become an agent?\n\n` +
                    `Once approved by admin, you will receive a unique referral link to invite players.`,
                    {
                        chat_id: chatId, message_id: msgId, parse_mode: 'Markdown',
                        reply_markup: {
                            inline_keyboard: [[
                                { text: '✅ Yes, request', callback_data: 'ag_req_confirm' },
                                { text: '❌ No', callback_data: 'ag_req_cancel' },
                            ]]
                        }
                    }
                );
            }

            if (data === 'ag_req_cancel') {
                return bot.editMessageText(
                    `👋 *Cancelled.*\n\nFeel free to come back anytime to apply for agent status!`,
                    { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' }
                );
            }

            if (data === 'ag_req_confirm') {
                try {
                    // Get user info from main users table if exists
                    const userRes = await db.query(
                        'SELECT first_name, last_name, username, phone_number FROM users WHERE chat_id = $1',
                        [chatId]
                    );
                    const user = userRes.rows[0] || {};
                    const firstName = query.from.first_name || user.first_name || '';
                    const lastName = query.from.last_name || user.last_name || '';
                    const username = query.from.username || user.username || '';
                    const phone = user.phone_number || 'N/A';

                    // Save to pending_agents (upsert)
                    await db.query(`
                    INSERT INTO pending_agents (chat_id, first_name, last_name, username, phone)
                    VALUES ($1, $2, $3, $4, $5)
                    ON CONFLICT (chat_id) DO UPDATE
                      SET first_name = EXCLUDED.first_name,
                          last_name  = EXCLUDED.last_name,
                          username   = EXCLUDED.username,
                          phone      = EXCLUDED.phone,
                          requested_at = NOW()
                `, [chatId, firstName, lastName, username, phone]);

                    if (settings.notify_agent_requests !== false && adminMessenger) {
                        try {
                            const notifyRes = await db.query("SELECT chat_id FROM admins WHERE (permissions::jsonb ->> 'notif_ag') = 'true'");
                            const adminIds = notifyRes.rows.map(r => r.chat_id);
                            
                            const escHtml = str => String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
                            const fullName = [firstName, lastName].filter(Boolean).join(' ') || 'N/A';
                            const adminMsg = 
                                `📝 <b>New Agent Request</b>\n\n` +
                                `👤 Name: ${escHtml(fullName)}\n` +
                                `📞 Phone: ${escHtml(phone)}\n` +
                                `🆔 ID: <code>${chatId}</code>\n` +
                                `📱 Username: ${username ? '@' + escHtml(username) : 'None'}`;

                            for (const adminId of adminIds) {
                                adminMessenger.sendMessage(adminId, adminMsg, {
                                    parse_mode: 'HTML',
                                    reply_markup: {
                                        inline_keyboard: [[
                                            { text: '✅ Approve Agent', callback_data: `adm_agent_approve_${chatId}` },
                                            { text: '❌ Reject', callback_data: `adm_agent_reject_${chatId}` },
                                        ]]
                                    }
                                }).catch(err => console.error('[AgentBot] Admin notify error:', err));
                            }
                        } catch (err) {
                            console.error('Error fetching admins for agent notify:', err);
                        }
                    } else if (!adminMessenger) {
                        console.warn('[AgentBot] ADMIN_BOT_TOKEN not set — admin not notified of agent request');
                    }

                    return bot.editMessageText(
                        `✅ *Request Submitted!*\n\n` +
                        `Your agent application has been sent to the admin.\n\n` +
                        `You will receive a notification here once it's approved. 🎉`,
                        { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' }
                    );

                } catch (err) {
                    console.error('[AgentBot] ag_req_confirm error:', err);
                    bot.editMessageText('⚠️ Failed to submit request. Please try again later or contact support.',
                        { chat_id: chatId, message_id: msgId });
                }
            }

            // ════════════════════════════════════════════════════════════════════
            // ADMIN APPROVAL / REJECTION  (fromId must be ADMIN_CHAT_ID)
            // ════════════════════════════════════════════════════════════════════

            if (data.startsWith('ag_approve_')) {
                if (String(fromId) !== String(ADMIN_CHAT_ID)) {
                    return bot.answerCallbackQuery(query.id, { text: '⛔ Not authorized.' });
                }
                const targetId = data.replace('ag_approve_', '');
                try {
                    const pendingRes = await db.query(
                        'SELECT * FROM pending_agents WHERE chat_id = $1',
                        [targetId]
                    );
                    if (pendingRes.rows.length === 0) {
                        return bot.editMessageText('⚠️ Request not found (already processed?)',
                            { chat_id: chatId, message_id: msgId });
                    }
                    const p = pendingRes.rows[0];
                    const refCode = `ref_${targetId}`;

                    // Create or update agent record
                    await db.query(`
                    INSERT INTO agents (chat_id, first_name, username, balance, is_approved, referral_code)
                    VALUES ($1, $2, $3, 0.00, TRUE, $4)
                    ON CONFLICT (chat_id) DO UPDATE
                      SET is_approved = TRUE,
                          referral_code = EXCLUDED.referral_code,
                          first_name = EXCLUDED.first_name,
                          username   = EXCLUDED.username
                `, [targetId, p.first_name, p.username, refCode]);

                    // Remove from pending
                    await db.query('DELETE FROM pending_agents WHERE chat_id = $1', [targetId]);

                    const link = referralLink(targetId);

                    // Notify the approved agent
                    bot.sendMessage(targetId,
                        `🎉 *Congratulations! You are now a Smart Bingo Agent!*\n\n` +
                        `Here is your unique referral link:\n\n` +
                        `🔗 \`${link}\`\n\n` +
                        `Share this link with people. When they register and play, you earn *0.5 ETB per card*!\n\n` +
                        `Use /start to open your agent dashboard.`,
                        { parse_mode: 'Markdown' }
                    ).catch(() => { });

                    // Update admin message
                    return bot.editMessageText(
                        `✅ *Agent Approved*\n\n` + query.message.text + `\n\n_Referral: ${link}_`,
                        { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' }
                    );

                } catch (err) {
                    console.error('[AgentBot] ag_approve error:', err);
                    bot.editMessageText('⚠️ Error approving agent.',
                        { chat_id: chatId, message_id: msgId });
                }
            }

            if (data.startsWith('ag_reject_')) {
                if (String(fromId) !== String(ADMIN_CHAT_ID)) return;
                const targetId = data.replace('ag_reject_', '');
                try {
                    await db.query('DELETE FROM pending_agents WHERE chat_id = $1', [targetId]);

                    bot.sendMessage(targetId,
                        `❌ *Agent Request Rejected*\n\n` +
                        `Your agent application was not approved at this time.\n\n` +
                        `Contact ${SUPPORT_USERNAME} for more information.`,
                        { parse_mode: 'Markdown' }
                    ).catch(() => { });

                    return bot.editMessageText(
                        `❌ *Agent Rejected*\n\n` + query.message.text,
                        { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' }
                    );
                } catch (err) {
                    console.error('[AgentBot] ag_reject error:', err);
                }
            }

            // ════════════════════════════════════════════════════════════════════
            // DASHBOARD MENU ACTIONS  (approved agents only)
            // ════════════════════════════════════════════════════════════════════

            // Guard: only approved, non-blocked agents can use dashboard
            const agent = await getAgent(chatId).catch(() => null);
            if (!agent || !agent.is_approved) return;

            if (agent.is_blocked) {
                return bot.answerCallbackQuery(query.id, { text: '⛔ Account suspended.', show_alert: true });
            }

            const agentName = agent.first_name || agent.username || `Agent_${chatId}`;

            // ── 💰 Balance ──
            if (data === 'ag_balance') {
                const balance = parseFloat(agent.balance).toFixed(2);
                return bot.editMessageText(
                    `💰 *Your Agent Balance*\n\n` +
                    `Current Balance: *${balance} ETB*\n\n` +
                    `Use 💸 Withdraw to cash out *(min ${parseFloat(settings.min_withdrawal || 100)} ETB)*`,
                    {
                        chat_id: chatId, message_id: msgId, parse_mode: 'Markdown',
                        reply_markup: { inline_keyboard: [[{ text: '🔙 Back', callback_data: 'ag_back' }]] }
                    }
                );
            }

            // ── 🔗 Referral Link ──
            if (data === 'ag_reflink') {
                const link = referralLink(chatId);
                return bot.editMessageText(
                    `🔗 *Your Referral Link*\n\n` +
                    `\`${link}\`\n\n` +
                    `Share this link! When someone registers via your link and plays, you earn *1 ETB per card*.\n\n` +
                    `📊 Check 👥 *My Invited Users* to see who joined.`,
                    {
                        chat_id: chatId, message_id: msgId, parse_mode: 'Markdown',
                        reply_markup: { inline_keyboard: [[{ text: '🔙 Back', callback_data: 'ag_back' }]] }
                    }
                );
            }

            // ── 👥 Invited Users (Paginated & Profiles) ──
            if (data === 'ag_users' || data.startsWith('ag_users_p_')) {
                const page = data.startsWith('ag_users_p_') ? parseInt(data.replace('ag_users_p_', ''), 10) : 0;
                
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
                    `, [chatId, startOfTodayIso, sevenDaysAgoIso]);
                    
                    const st = statsRes.rows[0];
                    if (st.total_invited == 0) {
                        return bot.editMessageText(
                            `👥 *Your Invited Users*\n\nNo users have joined yet.\n\nShare your referral link to start earning!`,
                            { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🔙 Back', callback_data: 'ag_back' }]] } }
                        );
                    }

                    // Get users list
                    const usersRes = await db.query(`
                        SELECT
                            u.chat_id,
                            u.first_name,
                            u.last_name,
                            u.username,
                            COUNT(ae.id) AS total_games,
                            COALESCE(SUM(ae.amount), 0) AS total_earned,
                            MAX(ae.created_at) AS last_played
                        FROM users u
                        LEFT JOIN agent_earnings ae ON ae.user_id = u.chat_id AND ae.agent_id = $1
                        WHERE u.referred_by = $1
                        GROUP BY u.chat_id, u.first_name, u.last_name, u.username
                        ORDER BY total_earned DESC, u.chat_id DESC
                    `, [chatId]);

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
                        
                        const name = [u.first_name, u.last_name].filter(Boolean).join(' ') || (u.username ? '@' + u.username : `User`);
                        const title = `${medal}${statusIcon} ${name} | ${parseFloat(u.total_earned).toFixed(2)} ETB`;
                        
                        return [{ text: title, callback_data: `ag_user_prof_${u.chat_id}` }];
                    });

                    // Navigation
                    const navBtns = [];
                    if (page > 0) navBtns.push({ text: '⬅️ Prev', callback_data: `ag_users_p_${page - 1}` });
                    if (offset + PAGE_SIZE < totalUsers) navBtns.push({ text: 'Next ➡️', callback_data: `ag_users_p_${page + 1}` });
                    
                    const kbRows = [...userBtns];
                    if (navBtns.length) kbRows.push(navBtns);
                    kbRows.push([{ text: '🔙 Dashboard', callback_data: 'ag_back' }]);

                    const text = 
                        `👥 *Invited Users Dashboard*\n\n` +
                        `📊 *Summary*\n` +
                        `• Total Invited: *${st.total_invited}*\n` +
                        `• Active Today: *${st.active_today}*\n` +
                        `• Active This Week: *${st.active_week}*\n` +
                        `• Total Commission: *${parseFloat(st.total_commission).toFixed(2)} ETB*\n\n` +
                        `_Click a user below for detailed stats._`;

                    return bot.editMessageText(text, {
                        chat_id: chatId, message_id: msgId, parse_mode: 'Markdown',
                        reply_markup: { inline_keyboard: kbRows }
                    });
                } catch (err) {
                    console.error('[AgentBot] ag_users error:', err);
                }
            }

            // ── 👤 Individual User Profile ──
            if (data.startsWith('ag_user_prof_')) {
                const uid = data.replace('ag_user_prof_', '');
                try {
                    const uRes = await db.query(`
                        SELECT 
                            u.chat_id, u.first_name, u.last_name, u.username, u.created_at,
                            COUNT(ae.id) AS total_games,
                            COALESCE(SUM(ae.amount), 0) AS total_earned,
                            MAX(ae.created_at) AS last_played
                        FROM users u
                        LEFT JOIN agent_earnings ae ON ae.user_id = u.chat_id AND ae.agent_id = $1
                        WHERE u.chat_id = $2 AND u.referred_by = $1
                        GROUP BY u.chat_id, u.first_name, u.last_name, u.username, u.created_at
                    `, [chatId, uid]);
                    
                    if (!uRes.rows.length) return bot.answerCallbackQuery(query.id, { text: 'User not found.', show_alert: true });
                    const u = uRes.rows[0];
                    
                    // Count wins
                    const winsRes = await db.query(`SELECT COUNT(*) as count FROM game_history WHERE winners LIKE '%' || $1 || '%'`, [String(uid)]);
                    const totalWins = parseInt(winsRes.rows[0].count, 10);
                    
                    const joinDate = u.created_at ? new Date(u.created_at).toLocaleDateString('en-GB') : 'Unknown';
                    let lastPlayedText = 'Never';
                    if (u.last_played) {
                        const lp = new Date(u.last_played);
                        lastPlayedText = lp.toLocaleDateString('en-GB') + ' ' + lp.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
                    }
                    
                    const name = [u.first_name, u.last_name].filter(Boolean).join(' ') || '';
                    const username = u.username ? '@' + u.username : 'No username';
                    
                    const text = 
                        `👤 *User Profile*\n\n` +
                        `Name: *${esc(name)}*\n` +
                        `Username: ${esc(username)}\n` +
                        `📅 Joined your team: *${joinDate}*\n\n` +
                        `🎮 Games Played: *${u.total_games}*\n` +
                        `🏆 Games Won: *${totalWins}*\n` +
                        `🕒 Last Played: *${lastPlayedText}*\n\n` +
                        `💵 **Profit generated: ${parseFloat(u.total_earned).toFixed(2)} ETB**`;
                        
                    return bot.editMessageText(text, {
                        chat_id: chatId, message_id: msgId, parse_mode: 'Markdown',
                        reply_markup: { inline_keyboard: [[{ text: '🔙 Back to Users', callback_data: 'ag_users' }]] }
                    });
                } catch (e) {
                    console.error('[AgentBot] ag_user_prof error:', e);
                }
            }

            // ── 📈 Earnings Report ──
if (data === 'ag_report') {
    try {
        const now = new Date();
        const etNow = new Date(now.getTime() + 3 * 3600 * 1000);
        
        const startOfTodayET = new Date(etNow);
        startOfTodayET.setUTCHours(0, 0, 0, 0);
        const startOfTodayIso = new Date(startOfTodayET.getTime() - 3 * 3600 * 1000).toISOString();
        
        const startOfMonthET = new Date(etNow);
        startOfMonthET.setUTCDate(1);
        startOfMonthET.setUTCHours(0, 0, 0, 0);
        const startOfMonthIso = new Date(startOfMonthET.getTime() - 3 * 3600 * 1000).toISOString();
        
        const day = etNow.getUTCDay();
        const diffToMonday = (day === 0 ? 6 : day - 1);
        const startOfWeekET = new Date(startOfTodayET);
        startOfWeekET.setUTCDate(startOfWeekET.getUTCDate() - diffToMonday);
        const startOfWeekIso = new Date(startOfWeekET.getTime() - 3 * 3600 * 1000).toISOString();

        const lastWdRes = await db.query("SELECT MAX(created_at) as last_wd FROM agent_withdrawals WHERE agent_id = $1 AND status = 'completed'", [chatId]);
        let lastWdIso = lastWdRes.rows[0]?.last_wd || '1970-01-01T00:00:00.000Z';
        if (typeof lastWdIso === 'object') lastWdIso = lastWdIso.toISOString();
        if (!lastWdIso.endsWith('Z')) lastWdIso += 'Z';
        const startOfWeekMaxWd = lastWdIso > startOfWeekIso ? lastWdIso : startOfWeekIso;

        const statsRes = await db.query(`
        SELECT 
            COALESCE(SUM(amount), 0) AS total_earned,
            COALESCE(SUM(CASE WHEN created_at >= $2 THEN amount ELSE 0 END), 0) AS this_month,
            COALESCE(SUM(CASE WHEN created_at >= $3 THEN amount ELSE 0 END), 0) AS this_week,
            COALESCE(SUM(CASE WHEN created_at >= $4 THEN amount ELSE 0 END), 0) AS today
        FROM agent_earnings 
        WHERE agent_id = $1
    `, [chatId, startOfMonthIso, startOfWeekMaxWd, startOfTodayIso]);

        const stats = statsRes.rows[0];

        const grandTotal = parseFloat(stats.total_earned).toFixed(2);
        const monthEarned = parseFloat(stats.this_month).toFixed(2);
        const weekEarned = parseFloat(stats.this_week).toFixed(2);
        const todayEarned = parseFloat(stats.today).toFixed(2);
        
        const invitedRes = await db.query(
            'SELECT COUNT(*) AS cnt FROM users WHERE referred_by = $1',
            [chatId]
        );

        const invitedCount = invitedRes.rows[0].cnt;

        return bot.editMessageText(
            `📈 *Earnings Report*\n\n` +
            `👥 Total Invited Users: *${invitedCount}*\n` +
            `💰 Total Earned (all time): *${grandTotal} ETB*\n` +
            `📅 This Month: *${monthEarned} ETB*\n` +
            `📅 This Week: *${weekEarned} ETB*\n` +
            `📅 Today's Earnings: *${todayEarned} ETB*\n\n` +
            `💳 Current Balance: *${parseFloat(agent.balance).toFixed(2)} ETB*`,
            {
                chat_id: chatId,
                message_id: msgId,
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [[
                        { text: '🔙 Back', callback_data: 'ag_back' }
                    ]]
                }
            }
        );
    } catch (err) {
        console.error('[AgentBot] ag_report error:', err);
    }
}

            // ── ℹ️ Help ──
            if (data === 'ag_help') {
                return bot.editMessageText(
                    `*Withdraw:* Min *${settings.min_withdrawal} ETB* (Sundays only)\n\n` +
                    `📞 Support: ${SUPPORT_USERNAME}`,
                    {
                        chat_id: chatId, message_id: msgId, parse_mode: 'Markdown',
                        reply_markup: { inline_keyboard: [[{ text: '🔙 Back', callback_data: 'ag_back' }]] }
                    }
                );
            }

            // ── 🔙 Back to Dashboard ──
            if (data === 'ag_back') {
                return sendDashboard(chatId, agentName, msgId);
            }

            // ── 💸 Withdraw ──
            if (data === 'ag_withdraw') {
                const balance = parseFloat(agent.balance);

                // SUNDAY CHECK (0 = Sunday)
                if (new Date().getDay() !== 0) {
                    return bot.editMessageText(
                        `🚫 *Withdrawal Restricted*\n\n` +
                        `Agent withdrawals are only available on *Sundays*.\n\n` +
                        `Today is not Sunday. Please come back then!`,
                        {
                            chat_id: chatId, message_id: msgId, parse_mode: 'Markdown',
                            reply_markup: { inline_keyboard: [[{ text: '🔙 Back', callback_data: 'ag_back' }]] }
                        }
                    );
                }

                if (balance < parseFloat(settings.min_withdrawal || 100)) {
                    return bot.editMessageText(
                        `❌ *Insufficient Balance*\n\n` +
                        `Minimum withdrawal is *${settings.min_withdrawal || 100} ETB*.\n` +
                        `Your balance: *${balance.toFixed(2)} ETB*`,
                        {
                            chat_id: chatId, message_id: msgId, parse_mode: 'Markdown',
                            reply_markup: { inline_keyboard: [[{ text: '🔙 Back', callback_data: 'ag_back' }]] }
                        }
                    );
                }

                const pendingCheck = await db.query("SELECT id FROM agent_withdrawals WHERE agent_id = $1 AND status = 'pending'", [chatId]);
                if (pendingCheck.rows.length > 0) {
                    return bot.editMessageText(
                        `⏳ *Withdrawal Already Pending*\n\n` +
                        `You already have a pending withdrawal request. Please wait for it to be processed before requesting another one.`,
                        {
                            chat_id: chatId, message_id: msgId, parse_mode: 'Markdown',
                            reply_markup: { inline_keyboard: [[{ text: '🔙 Back', callback_data: 'ag_back' }]] }
                        }
                    );
                }

                delete pendingWithdraw[chatId];
                pendingWithdraw[chatId] = { step: 'method' };

                return bot.editMessageText(
                    `💸 *Withdraw Agent Earnings*\n\n` +
                    `💰 Available: *${balance.toFixed(2)} ETB*\n\n` +
                    `Choose your withdrawal method:`,
                    {
                        chat_id: chatId, message_id: msgId, parse_mode: 'Markdown',
                        reply_markup: {
                            inline_keyboard: [
                                [
                                    { text: '📱 Telebirr', callback_data: 'agwd_telebirr' },
                                    { text: '💳 CBEBirr', callback_data: 'agwd_cbebirr' },
                                ],
                           /*   [
                                    { text: '🏦 CBE', callback_data: 'agwd_cbe' },
                                    { text: '🏦 Abyssinia', callback_data: 'agwd_abyssinia' },
                                ], */
                                [
                                    { text: '📜 Withdrawal History', callback_data: 'ag_wd_history' },
                                    { text: '🔙 Back', callback_data: 'ag_back' },
                                ],
                            ]
                        }
                    }
                );
            }

            // ── Withdrawal method selection ──
            if (data === 'agwd_abyssinia') {
                return bot.editMessageText(
                    '🏦 *Abyssinia (BOA)*\n\n_This method is coming soon! Please use Telebirr, CBEBirr, or CBE._',
                    {
                        chat_id: chatId, message_id: msgId, parse_mode: 'Markdown',
                        reply_markup: { inline_keyboard: [[{ text: '🔙 Back', callback_data: 'ag_withdraw' }]] }
                    }
                );
            }

            const wdMethodMap = { agwd_telebirr: 'telebirr', agwd_cbebirr: 'cbebirr', agwd_cbe: 'cbe' };
            if (wdMethodMap[data]) {
                const method = wdMethodMap[data];
                pendingWithdraw[chatId] = { step: 'account_name', method };

                return bot.editMessageText(
                    `💸 *Withdraw via ${method.toUpperCase()}*\n\n📝 Please type the *Account Holder Name*:`,
                    { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' }
                );
            }

            // ── Admin: Withdrawal completed ──
            if (data.startsWith('agwd_done_')) {
                if (String(fromId) !== String(ADMIN_CHAT_ID)) return;
                const wdId = data.replace('agwd_done_', '');
                try {
                    const wdRes = await db.query(
                        'UPDATE agent_withdrawals SET status = $1 WHERE id = $2 RETURNING agent_id, amount',
                        ['completed', wdId]
                    );
                    if (wdRes.rows.length === 0) {
                        return bot.editMessageText('⚠️ Withdrawal not found.',
                            { chat_id: chatId, message_id: msgId });
                    }
                    const { agent_id, amount } = wdRes.rows[0];

                    bot.sendMessage(agent_id,
                        `✅ *Withdrawal Completed!*\n\n` +
                        `Your withdrawal of *${parseFloat(amount).toFixed(2)} ETB* has been processed successfully! 🎉`,
                        { parse_mode: 'Markdown' }
                    ).catch(() => { });

                    return bot.editMessageText(
                        `✅ *Marked as Completed*\n\n` + query.message.text,
                        { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' }
                    );
                } catch (err) {
                    console.error('[AgentBot] agwd_done error:', err);
                }
            }

            // ── 📜 Withdrawal History ──
            if (data === 'ag_wd_history' || data.startsWith('ag_wd_history_p_')) {
                const page = data.startsWith('ag_wd_history_p_') ? parseInt(data.replace('ag_wd_history_p_', ''), 10) : 0;
                return showAgentWithdrawalHistory(chatId, msgId, page);
            }
        } catch (err) {
            console.error('[AgentBot] callback_query error:', err);
            try { bot.sendMessage(query.message.chat.id, '⚠️ We encountered an issue processing your request. Please try again.'); } catch (_) { }
        }
    });

    // ─── Text message handler (withdrawal state machine) ─────────────────────────
    bot.on('message', async (msg) => {
        const chatId = msg.chat.id;
        const settings = adminBotModule.getSettings();
        if (await checkMaintenance(chatId)) return;
        if (!msg.text || msg.text.startsWith('/')) return;

        const state = pendingWithdraw[chatId];
        if (!state) return;

        const input = msg.text.trim();

        // ── Step 1: Account Holder Name ──
        if (state.step === 'account_name') {
            state.accountName = input;
            state.step = 'account';
            const prompt = (state.method === 'telebirr' || state.method === 'cbebirr')
                ? '📱 Please type your *phone number*:'
                : '🏦 Please type your *account number*:';
            return bot.sendMessage(chatId,
                `✅ Name saved: *${state.accountName}*\n\n${prompt}`,
                { parse_mode: 'Markdown' }
            );
        }

        // ── Step 2: Account details ──
        if (state.step === 'account') {
            state.accountDetails = input;
            state.step = 'amount';
            return bot.sendMessage(chatId,
                `💰 Account details saved.\n\nPlease enter the *amount* you want to withdraw *(min ${parseFloat(settings.min_withdrawal || 100)} ETB)*:`,
                { parse_mode: 'Markdown' }
            );
        }

        // ── Step 2: Amount ──
        if (state.step === 'amount') {
            const amount = parseFloat(input);

            if (new Date().getDay() !== 0) {
                delete pendingWithdraw[chatId];
                return bot.sendMessage(chatId, '🚫 *Withdrawal Restricted*\n\nAgent withdrawals are only available on *Sundays*. Please try again on the upcoming Sunday!', { parse_mode: 'Markdown' });
            }

            if (isNaN(amount) || amount < parseFloat(settings.min_withdrawal || 100)) {
                return bot.sendMessage(chatId,
                    `❌ Minimum withdrawal is *${parseFloat(settings.min_withdrawal || 100)} ETB*. Please enter a valid amount:`,
                    { parse_mode: 'Markdown' }
                );
            }

            try {
                await db.query('BEGIN');
                const agentRes = await db.query(
                    'SELECT balance FROM agents WHERE chat_id = $1 FOR UPDATE', [chatId]
                );
                if (!agentRes.rows.length) {
                    await db.query('ROLLBACK');
                    delete pendingWithdraw[chatId];
                    return bot.sendMessage(chatId, '⚠️ Agent account not found.');
                }
                const currentBalance = parseFloat(agentRes.rows[0].balance);
                if (amount > currentBalance) {
                    await db.query('ROLLBACK');
                    return bot.sendMessage(chatId,
                        `❌ Insufficient balance.\nAvailable: *${currentBalance.toFixed(2)} ETB*.\nPlease enter a lower amount:`,
                        { parse_mode: 'Markdown' }
                    );
                }

                await db.query(
                    'UPDATE agents SET balance = balance - $1 WHERE chat_id = $2',
                    [amount, chatId]
                );
                const wdRes = await db.query(
                    `INSERT INTO agent_withdrawals (agent_id, amount, method, account_name, account_details, status)
                     VALUES ($1, $2, $3, $4, $5, 'pending') RETURNING id`,
                    [chatId, amount, state.method, state.accountName, state.accountDetails]
                );
                await db.query('COMMIT');

                const reqId = wdRes.rows[0].id;
                delete pendingWithdraw[chatId];

                // ── Notify admin if enabled ──
                if (settings.notify_withdrawals !== false) {
                    try {
                        const notifyRes = await db.query("SELECT chat_id FROM admins WHERE (permissions::jsonb ->> 'notif_wd') = 'true'");
                        const adminIds = notifyRes.rows.map(r => r.chat_id);
                        
                        if (adminIds.length > 0) {
                            const agentInfoRes = await db.query(
                                'SELECT first_name, username FROM agents WHERE chat_id = $1', [chatId]
                            );
                            const ai = agentInfoRes.rows[0] || {};
                            
                            for (const adminId of adminIds) {
                                const messenger = adminMessenger || bot;
                                messenger.sendMessage(adminId,
                                    `💸 *Agent Withdrawal Request #${reqId}*\n\n` +
                                    `👤 Agent: ${ai.first_name || ''} ${ai.username ? '@' + ai.username : ''}\n` +
                                    `🆔 ID: \`${chatId}\`\n` +
                                    `💰 Amount: *${amount.toFixed(2)} ETB*\n` +
                                    `💳 Method: *${state.method.toUpperCase()}*\n` +
                                    `📝 Name: *${state.accountName}*\n` +
                                    `📋 Account: \`${state.accountDetails}\``,
                                    {
                                        parse_mode: 'Markdown',
                                        reply_markup: {
                                            inline_keyboard: [[
                                                { text: '✅ Completed', callback_data: `agwd_done_${reqId}` },
                                                { text: '❌ Reject', callback_data: `agwd_rej_${reqId}` }
                                            ]]
                                        }
                                    }
                                ).catch(err => console.error('[AgentBot] Admin withdrawal notify error:', err));
                            }
                        }
                    } catch (err) {
                        console.error('Error fetching admins for agent wd notify:', err);
                    }
                }

                bot.sendMessage(chatId,
                    `✅ *Withdrawal Request Submitted!*\n\n` +
                    `🔖 Request ID: *#${reqId}*\n` +
                    `💰 Amount: *${amount.toFixed(2)} ETB*\n` +
                    `💳 Method: *${state.method.toUpperCase()}*\n` +
                    `📋 Account: \`${state.accountDetails}\`\n\n` +
                    `Your request is being processed. You'll be notified when it's completed.\n\n` +
                    `💬 Questions? Contact ${SUPPORT_USERNAME}`,
                    { parse_mode: 'Markdown' }
                );
            } catch (err) {
                await db.query('ROLLBACK').catch(() => { });
                console.error('[AgentBot] Withdrawal error:', err);
                bot.sendMessage(chatId, '⚠️ An error occurred. Please try again.');
                delete pendingWithdraw[chatId];
            }
        }
    });

    console.log('[AgentBot] Agent bot initialized (Webhook mode)');
    module.exports = {
        bot,
        processUpdate: (update) => bot.processUpdate(update)
    };
}
