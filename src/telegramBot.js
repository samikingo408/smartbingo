/**
 * telegramBot.js
 * Telegram bot integration for Smart Bingo.
 * Handles registration, play, deposit, withdraw, transfer, agent, contact commands.
 */

require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');

const db = require('./db');

// verifyTelebirr removed — Telebirr now uses SMS webhook instead of scraper
const { verifyWithVerifyEt, pollVerifyEt, verifyCBEBirr, verifyCBE, verifyAbyssinia } = require('./utils/scraper');


const BOT_TOKEN = process.env.BOT_TOKEN;
const WEBAPP_URL = process.env.FRONTEND_URL || process.env.WEBAPP_URL || 'https://your-frontend-url.com';
const SUPPORT_USERNAME = '@Smartbingosupport';

// Payment account details
const ACCOUNTS = {
    telebirr: { number: '0940072277', name: 'Yonatan' },
    cbebirr: { number: '0940072277', name: 'Yonatan' },
    cbe: { number: '1000708792067', name: 'Yonatan' },
    abyssinia: { number: '251511349', name: 'Yonatan' },
};

if (!BOT_TOKEN) {
    console.warn('[TelegramBot] BOT_TOKEN not set in .env — bot disabled');
    module.exports = null;
} else {
    const botCommands = [
        { command: 'play', description: 'Start play' },
        { command: 'balance', description: 'balance' },
        { command: 'deposit', description: 'Deposit' },
        { command: 'withdraw', description: 'Withdraw' },
       /* { command: 'transfer', description: 'Transfer' },*/
        { command: 'agent', description: 'agent' },
       /* { command: 'invite', description: 'Invite & Earn' }, */
        { command: 'contact', description: 'Support' }
    ];

    const adminBot = require('./adminBot');

  // Safe wrapper — prevents crashes when adminBot loads partially due to circular dependency
    function getSettings() {
        if (!adminBot || typeof adminBot.getSettings !== 'function') return {};
        return adminBot.getSettings();
    }

    async function checkMaintenance(chatId) {
      if (!adminBot || typeof adminBot.getSettings !== 'function') return false;
        const settings = getSettings();
        if (settings.maintenance_mode === true || settings.maintenance_mode === 'true') {
            const isAdmin = await db.query('SELECT 1 FROM admins WHERE chat_id = $1', [chatId]);
            if (isAdmin.rows.length === 0) {
                bot.sendMessage(chatId, '🛠 *System Maintenance*\n\nSmart Bingo is currently undergoing maintenance. Deposits, withdrawals, and game entries are temporarily paused. Please try again later!', { parse_mode: 'Markdown' });
                return true;
            }
        }
        return false;
    }

    const isLocal = process.env.USE_POLLING === 'true' || WEBAPP_URL.includes('localhost') || !WEBAPP_URL.includes('http');
    // webHook:false — Express handles the webhook route in server.js
    const botOptions = { polling: isLocal, webHook: false };
    const bot = new TelegramBot(BOT_TOKEN, botOptions);

    // Patch sendMessage to log outgoing messages
    const originalSendMessage = bot.sendMessage.bind(bot);
    bot.sendMessage = async (...args) => {
        console.log(`[TelegramBot] Sending message to ${args[0]}: "${args[1].slice(0, 50)}..."`);
        return originalSendMessage(...args);
    };

    bot.setMyCommands(botCommands).catch(err => console.error('Failed to set bot commands:', err));

    bot.on('message', (msg) => {
        console.log(`[TelegramBot] Received message from ${msg.chat.id}: "${msg.text || '[not text]'}"`);
    });

    async function logSuspicious(chatId, type, details) {
        try {
            await db.query(
                `INSERT INTO suspicious_logs (chat_id, type, details) VALUES ($1, $2, $3)`,
                [chatId, type, details]
            );
            console.log(`[Security] Logged suspicious activity for ${chatId}: ${type}`);
        } catch (e) {
            console.error('[Security] Error logging suspicious activity:', e);
        }
    }

    // ─── In-memory state tracking ──────────────────────────────────────────────────────
    const pendingDeposit = {};
    const pendingWithdrawal = {};
    const pendingTransfer = {};
    const pendingReferral = {};  // { [chatId]: agentChatId } — set during /start with ref param


    // ─── Helper: requireRegistered ────────────────────────────────────────────────
    async function isRegistered(chatId) {
        const result = await db.query('SELECT chat_id FROM users WHERE chat_id = $1', [chatId]);
        return result.rows.length > 0;
    }

    // ─── Helper: sendPlayLink ────────────────────────────────────────────────────
    function sendPlayLink(chatId) {
        bot.sendMessage(chatId, 'Have fun with Smart Bingo.', {
            reply_markup: {
                inline_keyboard: [
                    [{ text: '🎲 Play', web_app: { url: WEBAPP_URL } }]
                ],
            },
        });
    }

    // ─── /start ──────────────────────────────────────────────────────────────────
    bot.onText(/\/start(?:\s+(\S+))?/, async (msg, match) => {
        const chatId = msg.chat.id;
        if (await checkMaintenance(chatId)) return;
        const param = match?.[1] || '';            // e.g. "ref_123456789"
        try {
            const alreadyRegistered = await isRegistered(chatId);

            // ── Handle referral deep link (only for NEW / unregistered users) ──
            if (param.startsWith('ref_') && !alreadyRegistered) {
                const agentChatId = param.slice(4);   // strip "ref_"
                if (agentChatId && chatId !== parseInt(agentChatId, 10)) {
                    try {
                        // Store for after phone-number registration
                        pendingReferral[chatId] = agentChatId;
                    } catch (refErr) {
                        console.error('[TelegramBot] Referral link error:', refErr);
                    }
                }
            }

            if (!alreadyRegistered) {
                bot.sendMessage(chatId, '📋 *Registration Process*\n\nPlease share your phone number to register automatically.\n\nUse the button below to share your phone number securely:', {
                    parse_mode: 'Markdown',
                    reply_markup: {
                        keyboard: [[{ text: '📱 Share Phone Number', request_contact: true }]],
                        resize_keyboard: true,
                        one_time_keyboard: true
                    },
                });
            } else {

              // If already registered, explicitly remove any stale custom keyboard
                bot.sendMessage(chatId, 'Welcome back!', {
                    reply_markup: { remove_keyboard: true }
                }).then(() => sendPlayLink(chatId));
            }
        } catch (err) {
            console.error('[TelegramBot] /start error:', err);
            bot.sendMessage(chatId, '⚠️ We encountered an issue while starting. Please try again later or contact support.', { parse_mode: 'Markdown' });
        }
    });

    // ─── Contact sharing (registration) ─────────────────────────────────────────────
    bot.on('contact', async (msg) => {
        const chatId = msg.chat.id;
        if (msg.contact?.phone_number) {
            try {
                const checkRes = await db.query('SELECT chat_id FROM users WHERE chat_id = $1', [chatId]);
                if (checkRes.rows.length === 0) {
                    await db.query(
                        'INSERT INTO users (chat_id, phone_number, first_name, last_name, username) VALUES ($1, $2, $3, $4, $5)',
                        [chatId, msg.contact.phone_number, msg.contact.first_name || '', msg.contact.last_name || '', msg.from.username || '']
                    );
                    // Give Universal Welcome Bonus (to bonus_balance) based on setting
                    const settings = adminBot.getSettings();
                    const welcomeBonus = settings.welcome_bonus !== undefined ? parseFloat(settings.welcome_bonus) : 20;

                    if (welcomeBonus > 0) {
                        await db.query(
                            'UPDATE users SET bonus_balance = bonus_balance + $1, received_welcome_bonus = TRUE WHERE chat_id = $2 AND received_welcome_bonus = FALSE',
                            [welcomeBonus, chatId]
                        );
                        bot.sendMessage(
    chatId,
    `🎁 *Welcome Bonus!* You received *${welcomeBonus} ETB* bonus for joining Smart Bingo!\n_Note: Bonus balance can only be used for playing._`,
    {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [
                [
                    {
                        text: '🎲 Play',
                        web_app: { url: WEBAPP_URL } // Opens your Smart Bingo web app
                    }
                ]
            ]
        }
    }
);
                    }

                    // Attach pending referral if any (for inviter bonus later)
                    if (pendingReferral[chatId]) {
                        const agentId = pendingReferral[chatId];
                        const inviterCheck = await db.query(
                            'SELECT chat_id FROM users WHERE chat_id = $1 UNION SELECT chat_id FROM agents WHERE chat_id = $1 AND is_approved = TRUE',
                            [agentId]
                        );
                        if (inviterCheck.rows.length > 0) {
                            await db.query(
                                'UPDATE users SET referred_by = $1 WHERE chat_id = $2',
                                [agentId, chatId]
                            );
                        }
                        delete pendingReferral[chatId];
                    }
                }
                bot.sendMessage(chatId, '✅ *Registration successful!*\n\nWelcome to Smart Bingo!', {
    parse_mode: 'Markdown',
    reply_markup: { remove_keyboard: true }
}).then(() => sendPlayLink(chatId));
            } catch (err) {
                console.error('[TelegramBot] contact error:', err);
                bot.sendMessage(chatId, '⚠️ There was a problem saving your registration. Please try again or contact support.', { parse_mode: 'Markdown' });
            }
        }
    });

    // ─── /play ───────────────────────────────────────────────────────────────────
    bot.onText(/\/play/, async (msg) => {
        const chatId = msg.chat.id;
        if (await checkMaintenance(chatId)) return;
        try {
            if (!(await isRegistered(chatId))) return bot.sendMessage(chatId, '⚠️ Please type /start to register first before playing.');
            sendPlayLink(chatId);
        } catch (err) {
            bot.sendMessage(chatId, '⚠️ There was an issue launching the game. Please try again.', { parse_mode: 'Markdown' });
        }
    });

    // ─── /balance ────────────────────────────────────────────────────────────────
    bot.onText(/\/balance/, async (msg) => {
        const chatId = msg.chat.id;
        if (await checkMaintenance(chatId)) return;
        try {
            const result = await db.query('SELECT balance, bonus_balance FROM users WHERE chat_id = $1', [chatId]);
            if (result.rows.length > 0) {
                const main = parseFloat(result.rows[0].balance);
                const bonus = parseFloat(result.rows[0].bonus_balance || 0);
                bot.sendMessage(chatId,
                    `🏦 *Your Balance*\n\n` +
                    `💰 Withdrawable: *${main.toFixed(2)} ETB*\n` +
                    `🎁 Bonus: *${bonus.toFixed(2)} ETB*\n\n` +
                    `Total Match Balance: *${(main + bonus).toFixed(2)} ETB*`,
                    { parse_mode: 'Markdown', 
            reply_markup: {
            inline_keyboard: [
                [
                    {
                        text: '🎲 Play',
                        web_app: { url: WEBAPP_URL } // Opens your Smart Bingo web app
                    }
                ]
            ]
        }
             });
            } else {
                bot.sendMessage(chatId, '⚠️ Please register first by typing /start.');
            }
        } catch (err) {
            console.error('[TelegramBot] /balance error:', err);
            bot.sendMessage(chatId, '⚠️ We couldn\'t retrieve your balance. Please try again in a moment.', { parse_mode: 'Markdown' });
        }
    });

    // ─── /deposit ────────────────────────────────────────────────────────────────
    bot.onText(/\/deposit/, async (msg) => {
        const chatId = msg.chat.id;
        if (await checkMaintenance(chatId)) return;

        const settings = adminBot.getSettings();
        if (settings.kill_deposits === true || settings.kill_deposits === 'true') {
            return bot.sendMessage(chatId, '🚫 *Deposits are temporarily disabled.* Please try again later.', { parse_mode: 'Markdown' });
        }

        try {
            if (!(await isRegistered(chatId))) return bot.sendMessage(chatId, '⚠️ Please type /start to register first.');
            // Clear any pending deposit state
            delete pendingDeposit[chatId];
            const keyboard = [];
            let row = [];
            if (settings.dep_telebirr_active !== false && settings.dep_telebirr_active !== 'false') row.push({ text: '📱 Telebirr', callback_data: 'dep_telebirr' });
            if (settings.dep_cbebirr_active !== false && settings.dep_cbebirr_active !== 'false') row.push({ text: '💳 CBEBirr', callback_data: 'dep_cbebirr' });
            if (row.length) { keyboard.push(row); row = []; }
            if (settings.dep_cbe_active !== false && settings.dep_cbe_active !== 'false') row.push({ text: '🏦 CBE', callback_data: 'dep_cbe' });
            if (settings.dep_abyssinia_active !== false && settings.dep_abyssinia_active !== 'false') row.push({ text: '🏦 Abyssinia (BOA)', callback_data: 'dep_abyssinia' });
            if (row.length) keyboard.push(row);

            if (keyboard.length === 0) {
                 return bot.sendMessage(chatId, '🚫 *No deposit methods are currently available.*', { parse_mode: 'Markdown' });
            }

            bot.sendMessage(chatId,
                '💳 *Deposit Funds*\n\nPlease choose your preferred payment method:',
                {
                    parse_mode: 'Markdown',
                    reply_markup: {
                        inline_keyboard: keyboard
                    }
                }
            );
        } catch (err) {
            console.error('[TelegramBot] /deposit error:', err);
            bot.sendMessage(chatId, '⚠️ Unable to process deposit request at this time. Please try again.', { parse_mode: 'Markdown' });
        }
    });

    // ─── Deposit method instruction messages ──────────────────────────────────────
    function depositInstructions(method) {
        const settings = adminBot.getSettings();
        let accNo = settings[`dep_${method}_acc_no`] || ACCOUNTS[method]?.number || 'Not set';
        const accName = settings[`dep_${method}_acc_name`] || ACCOUNTS[method]?.name || 'Not set';

        // Ensure Telebirr and CBEbirr account numbers start with 0
        if ((method === 'telebirr' || method === 'cbebirr') && accNo !== 'Not set') {
            accNo = accNo.toString();
            if (!accNo.startsWith('0')) accNo = '0' + accNo;
        }

        const methodNames = {
            telebirr: '📱 Telebirr',
            cbebirr: '💳 CBEBirr',
            cbe: '🏦 CBE',
            abyssinia: '🏦 BOA',
        };
        const label = methodNames[method] || method;

        const isBOA = method === 'abyssinia';
        const stepIcon = isBOA ? '🏛️' : '📱';
        const stepsLabel = isBOA ? 'BOA Deposit Steps' : `${label.replace(/[📱💳🏦]\s?/g, '')} Deposit Steps`;
        const supportText = isBOA ? `${SUPPORT_USERNAME} ያናግሩ` : `${SUPPORT_USERNAME} ያናግሩ`;
        const copyPasteText = isBOA ? 'ኮፒ በማረግ በዚህ ቻት ፔስት አድርጉ' : 'ሙሉ በሙሉ ኮፒ (copy) በማረግ በዚህ ቻት ፔስት (paste) አድርጉ';

        return (
            `🏦 *${label} Deposit*\n\n` +
            `*Account:* \`${accNo}\` — ${accName}\n\n` +
            `━━━━━━━━━━━━━━━\n` +
            `${stepIcon} *${stepsLabel}*\n\n` +
            `1️⃣ ከላይ ባለው የ ${label.replace(/[📱💳🏦]\s?/g, '')} አካውንት ገንዘቡን ያስገቡ።\n` +
            `2️⃣ ክፍያ ካደረጉ በኋላ የ ${label.replace(/[📱💳🏦]\s?/g, '')} የጹሁፍ መልክት (SMS) ይደርሳችኋል።\n` +
            `3️⃣ የደረሳችሁን SMS ${copyPasteText}።\n\n` +
            `💬 የክፍያ ችግር ካለ፣ ${supportText}።\n\n` +
            `━━━━━━━━━━━━━━━\n` +
            `📤 After sending payment, please paste the SMS confirmation below 👇`
        );
    }

    // ─── callback_query: deposit method button clicks ────────────────────────────

    function sendInvite(chatId) {
        const link = `https://t.me/${process.env.BINGO_BOT_USERNAME || '@Smartbingo12bot'}?start=ref_${chatId}`;
        const text = `🔗 *Your Invitation Link*\n\n` +
            `Share this link with your friends! When they register, they get *20 ETB* bonus!\n\n` +
            `Link: \`${link}\``;
        bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
    }

    // ─── callback_query: handle main menu invite button ──────────────────────────
    bot.on('callback_query', async (query) => {
        const chatId = query.message.chat.id;
        if (await checkMaintenance(chatId)) return bot.answerCallbackQuery(query.id);
        const data = query.data;
        bot.answerCallbackQuery(query.id);

        if (data === 'main_invite') {
            return sendInvite(chatId);
        }

        if (data.startsWith('wd_')) {
            const methodMap = { wd_telebirr: 'telebirr', wd_cbebirr: 'cbebirr', wd_cbe: 'cbe', wd_abyssinia: 'abyssinia' };
            const method = methodMap[data];
            if (!method) return;

            pendingWithdrawal[chatId] = { step: 'account_name', method };

            return bot.editMessageText(`💸 *Withdraw via ${method.toUpperCase()}*\n\n📝 Please enter the *Account Holder Name*:`, {
                chat_id: chatId, message_id: query.message.message_id, parse_mode: 'Markdown'
            });
        }

        const methodMap = { dep_telebirr: 'telebirr', dep_cbebirr: 'cbebirr', dep_cbe: 'cbe', dep_abyssinia: 'abyssinia' };
        const method = methodMap[data];
        if (!method) return;

        // Set pending deposit state so next text message is treated as SMS
        pendingDeposit[chatId] = { method };

        bot.editMessageText(depositInstructions(method), {
            chat_id: chatId,
            message_id: query.message.message_id,
            parse_mode: 'Markdown'
        });
    });

    // ─── SMS paste handler ────────────────────────────────────────────────────────
    // This intercepts any plain text message and checks if the user is in a pending deposit
    bot.on('message', async (msg) => {
        const chatId = msg.chat.id;
        if (await checkMaintenance(chatId)) return;

        // If user sends ANY command (/deposit, /play, /agent, etc.) while in a pending
        // state — cancel all pending flows silently so the command handler takes over.
        if (msg.text && msg.text.startsWith('/')) {
            if (pendingWithdrawal[chatId]) delete pendingWithdrawal[chatId];
            if (pendingDeposit[chatId])    delete pendingDeposit[chatId];
            if (pendingTransfer[chatId])   delete pendingTransfer[chatId];
            return; // Let the dedicated onText handler deal with the command
        }

        // Only handle plain text messages (not contact shares)
        if (!msg.text || msg.contact) return;

        const textInput = msg.text.trim();

        // ─── TRANSFER STATE MACHINE ────────────────────────────────────────────────────
        if (pendingTransfer[chatId]) {
            const state = pendingTransfer[chatId];

            if (state.step === 'phone') {
                // Search for user by phone number (matching last 9 digits to be safe with prefixes)
                const phoneQuery = '%' + textInput.replace(/\s+/g, '').slice(-9);
                try {
                    const tRes = await db.query('SELECT chat_id, first_name, last_name, username, phone_number FROM users WHERE phone_number LIKE $1', [phoneQuery]);

                    if (tRes.rows.length === 0) {
                        delete pendingTransfer[chatId];
                        return bot.sendMessage(chatId, `❌ User with phone number \`${textInput}\` is not registered. Transfer cancelled.`, { parse_mode: 'Markdown' });
                    }

                    const targetUser = tRes.rows[0];
                    if (targetUser.chat_id === chatId) {
                        delete pendingTransfer[chatId];
                        return bot.sendMessage(chatId, `❌ You cannot transfer to yourself. Transfer cancelled.`);
                    }

                    state.targetChatId = targetUser.chat_id;
                    state.targetName = `${targetUser.first_name} ${targetUser.last_name || ''}`.trim() || targetUser.username || targetUser.phone_number;
                    state.step = 'amount';

                    return bot.sendMessage(chatId,
                        `👤 Receiver: *${state.targetName}*\n\nPlease enter the *amount* you want to transfer (Minimum: 20 ETB):`,
                        { parse_mode: 'Markdown' });
                } catch (err) {
                    console.error('[TelegramBot] Transfer phone check error:', err);
                    delete pendingTransfer[chatId];
                    return bot.sendMessage(chatId, '⚠️ We encountered an error checking that phone number. Please try again.', { parse_mode: 'Markdown' });
                }
            }

            if (state.step === 'amount') {
                const amount = parseFloat(textInput);
                if (isNaN(amount) || amount < 20) {
                    return bot.sendMessage(chatId, '❌ Invalid amount. Minimum transfer is *20 ETB*. Please enter a valid number:', { parse_mode: 'Markdown' });
                }

                try {
                    await db.query('BEGIN');
                    const userRes = await db.query('SELECT balance FROM users WHERE chat_id = $1 FOR UPDATE', [chatId]);
                    const currentBalance = parseFloat(userRes.rows[0].balance);

                    if (amount > currentBalance) {
                        await db.query('ROLLBACK');
                        return bot.sendMessage(chatId, `❌ Insufficient withdrawable balance.\nOnly main balance can be transferred. Your withdrawable balance is *${currentBalance.toFixed(2)} ETB*.\nPlease enter a lower amount:`, { parse_mode: 'Markdown' });
                    }

                    // Deduct from sender
                    await db.query('UPDATE users SET balance = balance - $1 WHERE chat_id = $2', [amount, chatId]);
                    // Add to receiver
                    await db.query('UPDATE users SET balance = balance + $1 WHERE chat_id = $2', [amount, state.targetChatId]);

                    await db.query('COMMIT');

                    bot.sendMessage(chatId, `✅ You sent *${amount.toFixed(2)} ETB* to *${state.targetName}* successfully!`, { parse_mode: 'Markdown' });

                    // Notify receiver smoothly
                    bot.sendMessage(state.targetChatId, `💵 You received *${amount.toFixed(2)} ETB* from a user!`).catch(() => { });

                    delete pendingTransfer[chatId];
                } catch (err) {
                    await db.query('ROLLBACK');
                    console.error('[TelegramBot] Transfer transaction error:', err);
                    bot.sendMessage(chatId, '⚠️ Transfer failed due to an internal error. Please try again later.', { parse_mode: 'Markdown' });
                    delete pendingTransfer[chatId];
                }
                return;
            }
        }

        // ─── WITHDRAWAL STATE MACHINE ──────────────────────────────────────────────────
        if (pendingWithdrawal[chatId]) {
            const state = pendingWithdrawal[chatId];

            if (state.step === 'account_name') {
                state.accountName = textInput;
                state.step = 'account';
                const promptText = (state.method === 'telebirr' || state.method === 'cbebirr')
                    ? '📱 Please enter your *phone number*:'
                    : '🏦 Please enter your *account number*:';
                return bot.sendMessage(chatId, `✅ Name saved: *${state.accountName}*\n\n${promptText}`, { parse_mode: 'Markdown' });
            }

            if (state.step === 'account') {
                state.accountDetails = textInput;
                state.step = 'amount';
                return bot.sendMessage(chatId, `💰 Account saved.\n\nPlease enter the *amount* you want to withdraw:`, { parse_mode: 'Markdown' });
            }

            if (state.step === 'amount') {
                const amount = parseFloat(textInput);
                const settings = getSettings();
                if (isNaN(amount) || amount < parseFloat(settings.min_withdrawal || 100)) {
                    // Cancel the withdrawal session so the user is not stuck
                    delete pendingWithdrawal[chatId];
                    return bot.sendMessage(chatId,
                        `❌ *Withdrawal Cancelled.*\n\n` +
                        `Minimum withdrawal is *${settings.min_withdrawal || 100} ETB*.\n\n` +
                        `Please type /withdraw again to start a new request.`,
                        { parse_mode: 'Markdown' }
                    );
                }
                if (amount > parseFloat(settings.max_withdrawal || 5000)) {
                    return bot.sendMessage(chatId, `❌ Maximum withdrawal per request is *${settings.max_withdrawal || 5000} ETB*.`, { parse_mode: 'Markdown' });
                }

                try {
                    // Start DB Transaction
                    await db.query('BEGIN');

                    const userRes = await db.query('SELECT balance FROM users WHERE chat_id = $1 FOR UPDATE', [chatId]);
                    const currentBalance = parseFloat(userRes.rows[0].balance);

                    if (amount > currentBalance) {
                        await db.query('ROLLBACK');
                        return bot.sendMessage(chatId,
                            `⚠️ *Insufficient Withdrawable Balance*\n\n` +
                            `Your main (withdrawable) balance is *${currentBalance.toFixed(2)} ETB*.\n` +
                            `Bonus balance ($${(await db.query('SELECT bonus_balance FROM users WHERE chat_id = $1', [chatId])).rows[0].bonus_balance} ETB) cannot be withdrawn.\n\n` +
                            `Please enter a lower amount:`,
                            { parse_mode: 'Markdown' }
                        );
                    }

                    // Deduct from balance, add to locked_balance
                    await db.query(`
                        UPDATE users 
                        SET balance = balance - $1, locked_balance = locked_balance + $1 
                        WHERE chat_id = $2
                    `, [amount, chatId]);

                    // Insert withdrawal request
                    const wdRes = await db.query(`
                        INSERT INTO withdrawals (chat_id, amount, method, account_name, account_details, status) 
                        VALUES ($1, $2, $3, $4, $5, 'pending') RETURNING id
                    `, [chatId, amount, state.method, state.accountName, state.accountDetails]);

                    await db.query('COMMIT');

                    const reqId = wdRes.rows[0].id;

                    bot.sendMessage(chatId, `✅ *Withdrawal request approved!*\n\nPlease wait a few minutes while we process your request.`, { parse_mode: 'Markdown' });
                    delete pendingWithdrawal[chatId];

                    // Notify Admin bots if enabled
                    const settings = getSettings();
                    if (settings.notify_withdrawals !== false && adminBot && adminBot.bot) {
                        try {
                            const notifyRes = await db.query("SELECT chat_id FROM admins WHERE (permissions::jsonb ->> 'notif_wd') = 'true'");
                            const adminIds = notifyRes.rows.map(r => r.chat_id);

                            for (const adminId of adminIds) {
                                adminBot.bot.sendMessage(
                                    adminId,
                                    `💸 *New Withdrawal Request #${reqId}*\n\n` +
                                    `👤 User: \`${chatId}\`\n` +
                                    `💰 Amount: *${amount.toFixed(2)} ETB*\n` +
                                    `💳 Method: *${state.method.toUpperCase()}*\n` +
                                    `📝 Name: *${state.accountName}*\n` +
                                    `📋 Account: \`${state.accountDetails}\``,
                                    {
                                        parse_mode: 'Markdown',
                                        reply_markup: {
                                            inline_keyboard: [[
                                                { 
                                                    text: '✅ Completed', 
                                                    callback_data: `adm_wd_done_${reqId}` 
                                                },
                                                {
                                                    text: '❌ Reject',
                                                    callback_data: `adm_wd_rej_${reqId}`
                                                }
                                            ]]
                                        }
                                    }
                                ).catch(err => console.error('[TelegramBot] Admin notification error:', err));
                            }
                        } catch (err) {
                            console.error('Error fetching admins for wd notify:', err);
                        }
                    }

                } catch (err) {
                    await db.query('ROLLBACK');
                    console.error('[TelegramBot] Withdrawal transaction error:', err);
                    bot.sendMessage(chatId, '⚠️ Withdrawal request failed due to an internal error. Please try again later.', { parse_mode: 'Markdown' });
                    delete pendingWithdrawal[chatId];
                }
                return;
            }
        }

    // ─── Helper: detect bank type from raw SMS text ──────────────────────────────
    function detectBankFromSMS(text) {
        const t = text.toLowerCase();
        // Telebirr: sent by ethio telecom, has telebirr or ethiotelecom reference
        if (/telebirr|ethio telecom|transactioninfo\.ethiotelecom\.et/.test(t)) return 'telebirr';
        // CBEBirr: sent by CBE Pay, URL contains cbepay1.cbe.com.et
        if (/cbepay1\.cbe\.com\.et|cbebirr|cbe birr/.test(t)) return 'cbebirr';
        // CBE: commercial bank of ethiopia, apps.cbe.com.et OR new mbreciept.cbe.com.et URL
        if (/apps\.cbe\.com\.et|mbreciept\.cbe\.com\.et|commercial bank of ethiopia|banking with cbe/i.test(text)) return 'cbe';
        // Bank of Abyssinia
        if (/bankofabyssinia|abyssinia|cs\.bankofabyssinia/.test(t)) return 'abyssinia';
        // Telebirr by message pattern: "You have transferred ETB ... to ... transaction number is"
        if (/you have transferred etb.*transaction number is/i.test(text)) return 'telebirr';
        return null;
    }

      // ─── DEPOSIT STATE MACHINE ─────────────────────────────────────────────────────

// Auto-detect or check if in pending deposit
let depositMethod = null;
if (pendingDeposit[chatId]) {
    depositMethod = pendingDeposit[chatId].method;
} else {
    // Try to auto-detect bank SMS even without prior /deposit click
    const detected = detectBankFromSMS(textInput);
    if (detected) {
        const settings = getSettings();
        const methodEnabled = settings[`dep_${detected}_active`];
        // Check if detected method is enabled
        if (methodEnabled !== false && methodEnabled !== 'false') {
            depositMethod = detected;
            pendingDeposit[chatId] = { method: detected };
        }
    }
}

if (!depositMethod) return;

const { method } = pendingDeposit[chatId];
const smsText = textInput;

try {
    let txId = null;
    let receiptUrl = null;

    if (method === 'telebirr') {

        const txMatch =
            smsText.match(/transaction\s+(?:number|id|no\.?)\s+(?:is\s+)?([A-Z0-9]{6,20})/i) ||
            smsText.match(/\/receipt\/([A-Z0-9]+)/i) ||
            smsText.match(/^\s*([A-Z0-9]{6,20})\s*$/i);

        txId = txMatch ? txMatch[1].toUpperCase() : null;

        if (!txId) {
            delete pendingDeposit[chatId];
            return bot.sendMessage(chatId,
                '❌ *Deposit Failed*\n\n' +
                'No Transaction ID found.\n\n' +
                '📝 You can either:\n' +
                '• Paste the *full Telebirr SMS* you received, or\n' +
                '• Type just your *Transaction ID* (e.g. DCI8X222CM)',
                { parse_mode: 'Markdown' }
            );
        }

        console.log(`[Deposit:Telebirr] TX ID: ${txId}`);

        const dupCheck = await db.query('SELECT id FROM deposits WHERE tx_id = $1', [txId]);
        if (dupCheck.rows.length > 0) {
            await logSuspicious(chatId, 'Duplicate TXID', `Reuse attempt: ${txId}`);
            delete pendingDeposit[chatId];
            return bot.sendMessage(chatId,
                '❌ *Deposit Failed*\n\nThis Transaction ID has already been credited.\n\n' +
                `💬 Need help? Contact ${SUPPORT_USERNAME}`,
                { parse_mode: 'Markdown' }
            );
        }

        // Build receipt URL and verify via HTML scraper (inherits all CBEBirr rules)
        receiptUrl = `https://transactioninfo.ethiotelecom.et/receipt/${txId}`;
        console.log(`[Deposit:Telebirr] Receipt URL: ${receiptUrl}`);

        const verifyingMsgTB = await bot.sendMessage(chatId,
            `🔍 *Verifying your Telebirr payment...*\nPlease wait a moment.`,
            { parse_mode: 'Markdown' }
        );

        const depSettingsTB = adminBot.getSettings();
        const tbAccNo = depSettingsTB.dep_telebirr_acc_no || ACCOUNTS['telebirr'].number;
        const tbAccName = depSettingsTB.dep_telebirr_acc_name || ACCOUNTS['telebirr'].name;
        let tbResult = await verifyWithVerifyEt(txId, 'telebirr', null, tbAccNo, tbAccName);
        if (tbResult && !tbResult.ok && tbResult.failureType === 'queued' && tbResult.statusUrl) {
            tbResult = await pollVerifyEt(tbResult.statusUrl, 25000);
        }

        bot.deleteMessage(chatId, verifyingMsgTB.message_id).catch(() => {});

        if (!tbResult || !tbResult.ok) {
            await logSuspicious(chatId, 'Failed Telebirr Verification', `TXID ${txId}. Error: ${tbResult?.error}`);
            delete pendingDeposit[chatId];
            return bot.sendMessage(chatId,
                '❌ *Deposit Verification Failed*\n\n' +
                `${tbResult?.error || 'Could not verify the transaction.'}\n\n` +
                `📝 Please ensure you paid to: \`${tbAccNo}\`\n\n` +
                `💬 Need help? Contact ${SUPPORT_USERNAME}`,
                { parse_mode: 'Markdown' }
            );
        }

        // ── 48-hour age check (same as CBEBirr) ──
        if (tbResult.txDate) {
            const tbDiffHours = (Date.now() - tbResult.txDate) / (1000 * 60 * 60);
            if (tbDiffHours > 48) {
                delete pendingDeposit[chatId];
                return bot.sendMessage(chatId,
                    '❌ *Deposit Rejected*\n\nThis transaction is too old.\nTransactions must be submitted within *48 hours* of transfer.\n\n' +
                    `Transaction Date: *${tbResult.txDate.toLocaleString()}*`,
                    { parse_mode: 'Markdown' }
                );
            }
        }

        const amount = tbResult.amount;


        try {
            await db.query(
                'INSERT INTO deposits (chat_id, tx_id, amount, method) VALUES ($1, $2, $3, $4)',
                [chatId, txId, amount, 'telebirr']
            );
        } catch (err) {
            if (err.code === '23505') {
                delete pendingDeposit[chatId];
                return bot.sendMessage(chatId,
                    '❌ *Deposit Rejected*\n\nThis transaction ID has already been used.',
                    { parse_mode: 'Markdown' }
                );
            }
            throw err;
        }

        // Credit base amount
        await db.query('UPDATE users SET balance = balance + $1 WHERE chat_id = $2', [amount, chatId]);

        // Apply deposit bonus if configured
        const depSettings = adminBot.getSettings();
        const depBonusPct = parseFloat(depSettings.deposit_bonus_pct || 0);
        let bonusCredit = 0;
        if (depBonusPct > 0) {
            bonusCredit = Math.floor((amount * depBonusPct / 100) * 100) / 100;
            await db.query('UPDATE users SET balance = balance + $1 WHERE chat_id = $2', [bonusCredit, chatId]);
        }

        const balRes = await db.query('SELECT balance FROM users WHERE chat_id = $1', [chatId]);
        const newBalance = parseFloat(balRes.rows[0].balance).toFixed(2);
        delete pendingDeposit[chatId];

        return bot.sendMessage(chatId,
            `✅ *Deposit Successful!*\n\n` +
            `💰 Amount Credited: *${(amount + bonusCredit).toFixed(2)} ETB*\n` +
            `🔖 Transaction ID: \`${txId}\`\n` +
            `💳 Method: TELEBIRR\n\n` +
            `📊 New Balance: *${newBalance} ETB*\n\n` +
            `Thank you! Use /play to start. 🎱`,
            { parse_mode: 'Markdown', 
            reply_markup: {
            inline_keyboard: [
                [
                    {
                        text: '🎲 Play',
                        web_app: { url: WEBAPP_URL } // Opens your Smart Bingo web app
                    }
                ]
            ]
        }
            }
        );
    }

    const urlPatterns = {
        cbebirr: /(https?:\/\/cbepay1\.cbe\.com\.et\/aureceipt\?[^\s"']+)/i,
        cbe: /(https?:\/\/(?:apps\.cbe\.com\.et(?::\d+)?|mbreciept\.cbe\.com\.et)\/[^\s"']+)/i,
        abyssinia: /(https?:\/\/cs\.bankofabyssinia\.com\/slip\/\?trx=[A-Z0-9]+)/i,
    };

    const txIdPatterns = [
        /(?:txn?\s*id)[:\s]+([A-Z0-9]{6,20})/i,
        /(?:transaction\s*(?:number|id|no\.?))\s*(?:is\s+|[:\s]+)([A-Z0-9]{6,20})/i,
        /[?&]TID=([A-Z0-9]+)/i,
        /[?&](?:id|trx)=([A-Z0-9]+)/i,
        /\/receipt\/([A-Z0-9]+)/i,
        /\b([A-Z0-9]{8,20})\b/,
    ];

    const buildUrl = {
        cbebirr: (id) => {
            const depSettingsCbebirr = adminBot.getSettings();
            const number = depSettingsCbebirr.dep_cbebirr_acc_no || ACCOUNTS.cbebirr.number;
            const ph = number.startsWith('0') ? '251' + number.slice(1) : number;
            return `https://cbepay1.cbe.com.et/aureceipt?TID=${id}&PH=${ph}`;
        },
        cbe: (id) => `https://apps.cbe.com.et:100/?id=${id}`,
        abyssinia: (id) => `https://cs.bankofabyssinia.com/slip/?trx=${id}`,
    };

    const urlMatch = smsText.match(urlPatterns[method]);
    receiptUrl = urlMatch ? urlMatch[1] : null;

    if (receiptUrl) {
        // Try standard id= or TID= or trx= params first
        const idFromUrl = receiptUrl.match(/[?&](TID|id|trx)=([A-Z0-9]+)/i);
        if (idFromUrl) {
            txId = idFromUrl[2].toUpperCase();
        } else {
            // CBE new format: https://mbreciept.cbe.com.et/v2-XXXX — the path is the receipt ID
            const pathMatch = receiptUrl.match(/\/([A-Za-z0-9_\-]{8,})\s*$/);
            // DO NOT uppercase v2- IDs because they are case-sensitive!
            if (pathMatch) txId = pathMatch[1];
        }
        console.log(`[Deposit:${method}] URL found. TX ID: ${txId}`);
    } else {
        for (const pattern of txIdPatterns) {
            const match = smsText.match(pattern);
            if (match && match[1]) { txId = match[1].toUpperCase(); break; }
        }
        if (txId && buildUrl[method]) {
            receiptUrl = buildUrl[method](txId);
            console.log(`[Deposit:${method}] Built URL from TX ID ${txId}: ${receiptUrl}`);
        }
    }

    if (!receiptUrl) {
        await logSuspicious(chatId, 'Malformed Deposit', `No URL/TXID in SMS: ${smsText.slice(0, 100)}...`);
        delete pendingDeposit[chatId];
        return bot.sendMessage(chatId,
            '❌ *Deposit Verification Failed*\n\n' +
            'We could not find a receipt link or transaction ID in your message.\n\n' +
            '📝 Please paste the *full SMS message* from your bank.\n\n' +
            `💬 Need help? Contact ${SUPPORT_USERNAME}`,
            { parse_mode: 'Markdown' }
        );
    }

    if (txId) {
        const dupCheck = await db.query('SELECT id FROM deposits WHERE tx_id = $1', [txId]);
        if (dupCheck.rows.length > 0) {
            await logSuspicious(chatId, 'Duplicate TXID', `Attempted reuse: ${txId}`);
            delete pendingDeposit[chatId];
            return bot.sendMessage(chatId,
                '❌ *Deposit Verification Failed*\n\n' +
                'This transaction has already been verified and credited.\n\n' +
                `💬 Need help? Contact ${SUPPORT_USERNAME}`,
                { parse_mode: 'Markdown' }
            );
        }
    }

    const verifyingMsg = await bot.sendMessage(
        chatId,
        `🔍 *Verifying your payment...*\nPlease wait a moment.`,
        { parse_mode: 'Markdown' }
    );

    const depSettingsMethod = adminBot.getSettings();
    const accNo = depSettingsMethod[`dep_${method}_acc_no`] || ACCOUNTS[method]?.number || '';
    const accName = depSettingsMethod[`dep_${method}_acc_name`] || ACCOUNTS[method]?.name || '';
    let verifyResult;

    if (method === 'cbe') {
        // ─── CBE: Parse directly from SMS text ───────────────────────────────────────
        // The receipt URL (mbreciept.cbe.com.et) is a JS SPA with no API.
        // All data needed is in the SMS. The receipt URL is the unique dedup key.
        const cbeResult = await verifyCBE(receiptUrl, smsText, accNo, accName);
        if (!cbeResult.ok) {
            bot.deleteMessage(chatId, verifyingMsg.message_id).catch(() => {});
            delete pendingDeposit[chatId];
            await logSuspicious(chatId, 'Failed CBE Verification', `Error: ${cbeResult.error}`);
            return bot.sendMessage(chatId,
                '❌ *Deposit Verification Failed*\n\n' +
                `${cbeResult.error}\n\n` +
                `📝 Please paste the *full SMS* from CBE including the https://mbreciept.cbe.com.et/... link.\n\n` +
                `💬 Need help? Contact ${SUPPORT_USERNAME}`,
                { parse_mode: 'Markdown' }
            );
        }
        // Use the receipt URL path as the unique dedup key (e.g. "v2-hfHCxFSfzOwu7QRumzrZ")
        const cbeReceiptUrl = cbeResult.receiptUrl || receiptUrl;
        const cbeUniqueTxId = cbeReceiptUrl
            ? (cbeReceiptUrl.match(/\/([A-Za-z0-9_\-]{8,})\s*$/) || [])[1] || cbeReceiptUrl
            : txId;
        if (!cbeUniqueTxId) {
            bot.deleteMessage(chatId, verifyingMsg.message_id).catch(() => {});
            delete pendingDeposit[chatId];
            return bot.sendMessage(chatId,
                '❌ *Deposit Verification Failed*\n\n' +
                'No CBE receipt URL found in your SMS. Please paste the *full SMS message* including the mbreciept link.\n\n' +
                `💬 Need help? Contact ${SUPPORT_USERNAME}`,
                { parse_mode: 'Markdown' }
            );
        }
        // Dedup check on the CBE receipt URL path
        const cbeDupCheck = await db.query('SELECT id FROM deposits WHERE tx_id = $1', [cbeUniqueTxId]);
        if (cbeDupCheck.rows.length > 0) {
            await logSuspicious(chatId, 'Duplicate CBE Receipt', `Reuse: ${cbeUniqueTxId}`);
            bot.deleteMessage(chatId, verifyingMsg.message_id).catch(() => {});
            delete pendingDeposit[chatId];
            return bot.sendMessage(chatId,
                '❌ *Deposit Verification Failed*\n\nThis CBE receipt has already been used.\n\n' +
                `💬 Need help? Contact ${SUPPORT_USERNAME}`,
                { parse_mode: 'Markdown' }
            );
        }
        // Save and credit
        try {
            await db.query(
                'INSERT INTO deposits (chat_id, tx_id, amount, method) VALUES ($1, $2, $3, $4)',
                [chatId, cbeUniqueTxId, cbeResult.amount, 'cbe']
            );
        } catch (err) {
            if (err.code === '23505') {
                bot.deleteMessage(chatId, verifyingMsg.message_id).catch(() => {});
                delete pendingDeposit[chatId];
                return bot.sendMessage(chatId, '❌ *Deposit Rejected*\n\nThis CBE receipt has already been used.', { parse_mode: 'Markdown' });
            }
            throw err;
        }
        await db.query('UPDATE users SET balance = balance + $1 WHERE chat_id = $2', [cbeResult.amount, chatId]);
        const cbeDepSettings = adminBot.getSettings();
        const cbeBonusPct = parseFloat(cbeDepSettings.deposit_bonus_pct || 0);
        let cbeBonusCredit = 0;
        if (cbeBonusPct > 0) {
            cbeBonusCredit = Math.floor((cbeResult.amount * cbeBonusPct / 100) * 100) / 100;
            await db.query('UPDATE users SET balance = balance + $1 WHERE chat_id = $2', [cbeBonusCredit, chatId]);
        }
        const cbeBalRes = await db.query('SELECT balance FROM users WHERE chat_id = $1', [chatId]);
        const cbeNewBalance = parseFloat(cbeBalRes.rows[0].balance).toFixed(2);
        bot.deleteMessage(chatId, verifyingMsg.message_id).catch(() => {});
        delete pendingDeposit[chatId];
        return bot.sendMessage(chatId,
            `✅ *Deposit Successful!*\n\n` +
            `💰 Amount Credited: *${(cbeResult.amount + cbeBonusCredit).toFixed(2)} ETB*\n` +
            `🏦 Method: CBE\n\n` +
            `📊 New Balance: *${cbeNewBalance} ETB*\n\n` +
            `Thank you! Use /play to start. 🎱`,
            { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🎲 Play', web_app: { url: WEBAPP_URL } }]] } }
        );

    } else if (method === 'cbebirr') {
        // ─── CBEBirr: Parse the PDF receipt directly ──────────────────────────────────
        if (!receiptUrl) {
            bot.deleteMessage(chatId, verifyingMsg.message_id).catch(() => {});
            delete pendingDeposit[chatId];
            return bot.sendMessage(chatId,
                '❌ *Deposit Verification Failed*\n\n' +
                'No CBEBirr receipt URL found. Please paste the full SMS including the cbepay1.cbe.com.et link.\n\n' +
                `💬 Need help? Contact ${SUPPORT_USERNAME}`,
                { parse_mode: 'Markdown' }
            );
        }
        const cbebirrResult = await verifyCBEBirr(receiptUrl, accNo, accName);
        if (!cbebirrResult.ok) {
            bot.deleteMessage(chatId, verifyingMsg.message_id).catch(() => {});
            delete pendingDeposit[chatId];
            await logSuspicious(chatId, 'Failed CBEBirr Verification', `URL: ${receiptUrl}. Error: ${cbebirrResult.error}`);
            return bot.sendMessage(chatId,
                '❌ *Deposit Verification Failed*\n\n' +
                `${cbebirrResult.error}\n\n` +
                `📝 Please ensure you paid to: \`${accNo}\`\n\n` +
                `💬 Need help? Contact ${SUPPORT_USERNAME}`,
                { parse_mode: 'Markdown' }
            );
        }
        // 48-hour check
        if (cbebirrResult.txDate) {
            const cbebirrDiff = (Date.now() - cbebirrResult.txDate) / (1000 * 60 * 60);
            if (cbebirrDiff > 48) {
                bot.deleteMessage(chatId, verifyingMsg.message_id).catch(() => {});
                delete pendingDeposit[chatId];
                return bot.sendMessage(chatId,
                    '❌ *Deposit Rejected*\n\nThis transaction is too old. Transactions must be submitted within *48 hours*.\n\n' +
                    `Transaction Date: *${cbebirrResult.txDate.toLocaleString()}*`,
                    { parse_mode: 'Markdown' }
                );
            }
        }
        // Save and credit using txId (TID from URL)
        try {
            await db.query(
                'INSERT INTO deposits (chat_id, tx_id, amount, method) VALUES ($1, $2, $3, $4)',
                [chatId, txId, cbebirrResult.amount, 'cbebirr']
            );
        } catch (err) {
            if (err.code === '23505') {
                bot.deleteMessage(chatId, verifyingMsg.message_id).catch(() => {});
                delete pendingDeposit[chatId];
                return bot.sendMessage(chatId, '❌ *Deposit Rejected*\n\nThis transaction ID has already been used.', { parse_mode: 'Markdown' });
            }
            throw err;
        }
        await db.query('UPDATE users SET balance = balance + $1 WHERE chat_id = $2', [cbebirrResult.amount, chatId]);
        const cbebirrDepSettings = adminBot.getSettings();
        const cbebirrBonusPct = parseFloat(cbebirrDepSettings.deposit_bonus_pct || 0);
        let cbebirrBonusCredit = 0;
        if (cbebirrBonusPct > 0) {
            cbebirrBonusCredit = Math.floor((cbebirrResult.amount * cbebirrBonusPct / 100) * 100) / 100;
            await db.query('UPDATE users SET balance = balance + $1 WHERE chat_id = $2', [cbebirrBonusCredit, chatId]);
        }
        const cbebirrBalRes = await db.query('SELECT balance FROM users WHERE chat_id = $1', [chatId]);
        const cbebirrNewBalance = parseFloat(cbebirrBalRes.rows[0].balance).toFixed(2);
        bot.deleteMessage(chatId, verifyingMsg.message_id).catch(() => {});
        delete pendingDeposit[chatId];
        return bot.sendMessage(chatId,
            `✅ *Deposit Successful!*\n\n` +
            `💰 Amount Credited: *${(cbebirrResult.amount + cbebirrBonusCredit).toFixed(2)} ETB*\n` +
            `🔖 Transaction ID: \`${txId}\`\n` +
            `🏦 Method: CBEBirr\n\n` +
            `📊 New Balance: *${cbebirrNewBalance} ETB*\n\n` +
            `Thank you! Use /play to start. 🎱`,
            { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🎲 Play', web_app: { url: WEBAPP_URL } }]] } }
        );

    } else if (method === 'abyssinia') {
        // ─── Abyssinia: Parse the JSON API directly ───────────────────────────────────
        if (!receiptUrl) {
            bot.deleteMessage(chatId, verifyingMsg.message_id).catch(() => {});
            delete pendingDeposit[chatId];
            return bot.sendMessage(chatId,
                '❌ *Deposit Verification Failed*\n\n' +
                'No Abyssinia receipt URL found. Please paste the full SMS including the cs.bankofabyssinia.com link.\n\n' +
                `💬 Need help? Contact ${SUPPORT_USERNAME}`,
                { parse_mode: 'Markdown' }
            );
        }
        const abyssiniaResult = await verifyAbyssinia(receiptUrl, accNo, accName);
        if (!abyssiniaResult.ok) {
            bot.deleteMessage(chatId, verifyingMsg.message_id).catch(() => {});
            delete pendingDeposit[chatId];
            await logSuspicious(chatId, 'Failed Abyssinia Verification', `URL: ${receiptUrl}. Error: ${abyssiniaResult.error}`);
            return bot.sendMessage(chatId,
                '❌ *Deposit Verification Failed*\n\n' +
                `${abyssiniaResult.error}\n\n` +
                `📝 Please ensure you paid to: \`${accNo}\`\n\n` +
                `💬 Need help? Contact ${SUPPORT_USERNAME}`,
                { parse_mode: 'Markdown' }
            );
        }
        // 48-hour check
        if (abyssiniaResult.txDate) {
            const abyssiniaDiff = (Date.now() - abyssiniaResult.txDate) / (1000 * 60 * 60);
            if (abyssiniaDiff > 48) {
                bot.deleteMessage(chatId, verifyingMsg.message_id).catch(() => {});
                delete pendingDeposit[chatId];
                return bot.sendMessage(chatId,
                    '❌ *Deposit Rejected*\n\nThis transaction is too old. Transactions must be submitted within *48 hours*.\n\n' +
                    `Transaction Date: *${abyssiniaResult.txDate.toLocaleString()}*`,
                    { parse_mode: 'Markdown' }
                );
            }
        }
        // Save and credit using txId (TID from URL)
        try {
            await db.query(
                'INSERT INTO deposits (chat_id, tx_id, amount, method) VALUES ($1, $2, $3, $4)',
                [chatId, txId, abyssiniaResult.amount, 'abyssinia']
            );
        } catch (err) {
            if (err.code === '23505') {
                bot.deleteMessage(chatId, verifyingMsg.message_id).catch(() => {});
                delete pendingDeposit[chatId];
                return bot.sendMessage(chatId, '❌ *Deposit Rejected*\n\nThis transaction ID has already been used.', { parse_mode: 'Markdown' });
            }
            throw err;
        }
        await db.query('UPDATE users SET balance = balance + $1 WHERE chat_id = $2', [abyssiniaResult.amount, chatId]);
        const abyssiniaDepSettings = adminBot.getSettings();
        const abyssiniaBonusPct = parseFloat(abyssiniaDepSettings.deposit_bonus_pct || 0);
        let abyssiniaBonusCredit = 0;
        if (abyssiniaBonusPct > 0) {
            abyssiniaBonusCredit = Math.floor((abyssiniaResult.amount * abyssiniaBonusPct / 100) * 100) / 100;
            await db.query('UPDATE users SET balance = balance + $1 WHERE chat_id = $2', [abyssiniaBonusCredit, chatId]);
        }
        const abyssiniaBalRes = await db.query('SELECT balance FROM users WHERE chat_id = $1', [chatId]);
        const abyssiniaNewBalance = parseFloat(abyssiniaBalRes.rows[0].balance).toFixed(2);
        bot.deleteMessage(chatId, verifyingMsg.message_id).catch(() => {});
        delete pendingDeposit[chatId];
        return bot.sendMessage(chatId,
            `✅ *Deposit Successful!*\n\n` +
            `💰 Amount Credited: *${(abyssiniaResult.amount + abyssiniaBonusCredit).toFixed(2)} ETB*\n` +
            `🔖 Transaction ID: \`${txId}\`\n` +
            `🏦 Method: Abyssinia\n\n` +
            `📊 New Balance: *${abyssiniaNewBalance} ETB*\n\n` +
            `Thank you! Use /play to start. 🎱`,
            { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🎲 Play', web_app: { url: WEBAPP_URL } }]] } }
        );

    } else {
        // ─── Telebirr (and any other method): use verify.et ─────────────────────────
        verifyResult = await verifyWithVerifyEt(txId, method, null, accNo, accName);
        if (verifyResult && !verifyResult.ok && verifyResult.failureType === 'queued' && verifyResult.statusUrl) {
            verifyResult = await pollVerifyEt(verifyResult.statusUrl, 25000);
        }
    }

            if (!verifyResult || !verifyResult.ok) {
                bot.deleteMessage(chatId, verifyingMsg.message_id).catch(() => { });
                delete pendingDeposit[chatId];
                await logSuspicious(chatId, 'Failed Verification', `TXID ${txId} via ${method}. Error: ${verifyResult?.error}`);
                return bot.sendMessage(chatId,
                    '❌ *Deposit Verification Failed*\n\n' +
                    `The transaction \`${txId}\` could not be verified.\n\n` +
                    `📝 Please ensure you have paid to the correct account: \`${accNo}\`\n\n` +
                    `💬 If you are sure this is correct, contact ${SUPPORT_USERNAME}`,
                    { parse_mode: 'Markdown' }
                );
            }

            const { amount, txDate } = verifyResult;

            // ── Step 4: Validate Transaction Age (Max 72 Hours) ──
            if (!txDate) {
                bot.deleteMessage(chatId, verifyingMsg.message_id).catch(() => { });
                delete pendingDeposit[chatId];
                return bot.sendMessage(chatId,
                    '❌ *Deposit Verification Failed*\n\n' +
                    `Could not verify the exact transaction date from the receipt. For security, this transaction cannot be processed automatically.\n\n` +
                    `💬 Please contact ${SUPPORT_USERNAME}`,
                    { parse_mode: 'Markdown' }
                );
            }

            const now = new Date();
            const diffMs = now - txDate;
            const diffHours = diffMs / (1000 * 60 * 60);

            if (diffHours > 48) {
                bot.deleteMessage(chatId, verifyingMsg.message_id).catch(() => { });
                delete pendingDeposit[chatId];
                return bot.sendMessage(chatId,
                    '❌ *Deposit Rejected*\n\n' +
                    'This transaction is too old. Transactions must be submitted within *48 hours* of transfer.\n\n' +
                    `Transaction Date: *${txDate.toLocaleString()}*`,
                    { parse_mode: 'Markdown' }
                );
            }

            // ── Step 5: All checks passed — credit balance and save to DB ──
            try {
                await db.query(
                    'INSERT INTO deposits (chat_id, tx_id, amount, method) VALUES ($1, $2, $3, $4)',
                    [chatId, txId, amount, method]
                );
            } catch (err) {
                if (err.code === '23505') { // Unique violation
                    bot.deleteMessage(chatId, verifyingMsg.message_id).catch(() => { });
                    delete pendingDeposit[chatId];

                    const msgText = `🚨 *FRAUD ALERT: Duplicate Transaction*\n\nUser: \`${chatId}\`\nTX ID: \`${txId}\`\nAmount: *${amount} ETB*\n\nThis user attempted to reuse a transaction ID!`;
                    if (ADMIN_CHAT_ID) adminBot.bot.sendMessage(ADMIN_CHAT_ID, msgText, { parse_mode: 'Markdown' }).catch(() => { });

                    return bot.sendMessage(chatId,
                        '❌ *Deposit Rejected*\n\n' +
                        'This transaction ID has already been used.',
                        { parse_mode: 'Markdown' }
                    );
                }
                throw err;
            }

            // Credit base deposit amount
            await db.query(
                'UPDATE users SET balance = balance + $1 WHERE chat_id = $2',
                [amount, chatId]
            );

            // Apply deposit bonus if configured
            const depSettings2 = adminBot.getSettings();
            const depBonusPct2 = parseFloat(depSettings2.deposit_bonus_pct || 0);
            let bonusCredit2 = 0;
            if (depBonusPct2 > 0) {
                bonusCredit2 = Math.floor((amount * depBonusPct2 / 100) * 100) / 100;
                await db.query(
                    'UPDATE users SET balance = balance + $1 WHERE chat_id = $2',
                    [bonusCredit2, chatId]
                );
            }

            const balRes = await db.query('SELECT balance FROM users WHERE chat_id = $1', [chatId]);
            const newBalance = parseFloat(balRes.rows[0].balance).toFixed(2);

            bot.deleteMessage(chatId, verifyingMsg.message_id).catch(() => { });
            delete pendingDeposit[chatId];

            bot.sendMessage(chatId,
                `✅ *Deposit Successful!*\n\n` +
                `💰 Amount Credited: *${(amount + bonusCredit2).toFixed(2)} ETB*\n` +
                `🔖 Transaction ID: \`${txId}\`\n` +
                `💳 Method: ${method.toUpperCase()}\n\n` +
                `📊 New Balance: *${newBalance} ETB*\n\n` +
                `Thank you! You can now play. click play to start. 🎱`,
                {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [
                [
                    {
                        text: '🎲 Play',
                        web_app: { url: WEBAPP_URL } // Opens your Smart Bingo web app
                    }
                ]
            ]
        }
    }
);
  
} catch (err) {
            console.error('[TelegramBot] SMS verification error:', err);
            bot.sendMessage(chatId, '⚠️ We encountered an internal error during verification. Please try again or contact support.', { parse_mode: 'Markdown' });
        }
    });

    // ─── /withdraw ───────────────────────────────────────────────────────────────
    bot.onText(/\/withdraw/, async (msg) => {
        const chatId = msg.chat.id;
        if (await checkMaintenance(chatId)) return;

        const settings = getSettings();
        if (settings.kill_withdrawals === true || settings.kill_withdrawals === 'true') {
            return bot.sendMessage(chatId, '🚫 *Withdrawals are temporarily disabled.* Please try again later.', { parse_mode: 'Markdown' });
        }

        try {
            if (!(await isRegistered(chatId))) return bot.sendMessage(chatId, '⚠️ Please type /start to register first.');

            // Clear any pending state
            delete pendingDeposit[chatId];
            delete pendingWithdrawal[chatId];
            delete pendingTransfer[chatId];

            const res = await db.query('SELECT balance FROM users WHERE chat_id = $1', [chatId]);
            const balance = res.rows.length > 0 ? parseFloat(res.rows[0].balance) : 0;

            const minWd = parseFloat(settings.min_withdrawal || 200);

            if (balance < minWd) {
          
                return bot.sendMessage(chatId,
                    `❌ *Insufficient balance to withdraw.*\n\n` +
                    `Minimum withdraw amount is *${minWd} ETB*\n` +
                    `Your current balance is *${balance.toFixed(2)} ETB*`,
                    { parse_mode: 'Markdown' }
                );
            }

            const pendingCheck = await db.query("SELECT id FROM withdrawals WHERE chat_id = $1 AND status = 'pending'", [chatId]);
            if (pendingCheck.rows.length > 0) {
                return bot.sendMessage(chatId,
                    `⏳ *Withdrawal Already Pending*\n\n` +
                    `You already have a pending withdrawal request. Please wait for it to be processed before requesting another one.`,
                    { parse_mode: 'Markdown' }
                );
            }

            const keyboard = [];
            let row = [];
            if (settings.wd_telebirr_active !== false && settings.wd_telebirr_active !== 'false') row.push({ text: '📱 Telebirr', callback_data: 'wd_telebirr' });
            if (settings.wd_cbebirr_active !== false && settings.wd_cbebirr_active !== 'false') row.push({ text: '💳 CBEBirr', callback_data: 'wd_cbebirr' });
            if (row.length) { keyboard.push(row); row = []; }
            if (settings.wd_cbe_active !== false && settings.wd_cbe_active !== 'false') row.push({ text: '🏦 CBE', callback_data: 'wd_cbe' });
            if (settings.wd_abyssinia_active !== false && settings.wd_abyssinia_active !== 'false') row.push({ text: '🏦 Abyssinia (BOA)', callback_data: 'wd_abyssinia' });
            if (row.length) keyboard.push(row);

            if (keyboard.length === 0) {
                 return bot.sendMessage(chatId, '🚫 *No withdrawal methods are currently available.*', { parse_mode: 'Markdown' });
            }

            // Balance is >= 100, show method selection
            bot.sendMessage(chatId,
                `💸 *Withdraw Funds*\n\n` +
                `💰 Current Balance: *${balance.toFixed(2)} ETB*\n\n` +
                `Please choose your preferred withdrawal method:`,
                {
                    parse_mode: 'Markdown',
                    reply_markup: {
                        inline_keyboard: keyboard
                    }
                }
            );
        } catch (err) {
            console.error('[TelegramBot] /withdraw error:', err);
            bot.sendMessage(chatId, '⚠️ There was an issue processing your withdrawal request. Please try again.', { parse_mode: 'Markdown' });
        }
    });

    // ─── /transfer ───────────────────────────────────────────────────────────────
    bot.onText(/\/transfer/, async (msg) => {
        const chatId = msg.chat.id;
        if (await checkMaintenance(chatId)) return;
        try {
            if (!(await isRegistered(chatId))) return bot.sendMessage(chatId, '⚠️ Please type /start to register first.');

            // Clear any pending state
            delete pendingDeposit[chatId];
            delete pendingWithdrawal[chatId];
            delete pendingTransfer[chatId];

            const res = await db.query('SELECT balance FROM users WHERE chat_id = $1', [chatId]);
            const balance = res.rows.length > 0 ? parseFloat(res.rows[0].balance) : 0;

            if (balance < 20) {
                return bot.sendMessage(chatId,
                    `❌ *Insufficient balance to transfer.*\n\n` +
                    `Minimum transfer amount is *20 ETB*\n` +
                    `Your current balance is *${balance.toFixed(2)} ETB*`,
                    { parse_mode: 'Markdown' }
                );
            }

            pendingTransfer[chatId] = { step: 'phone' };
            bot.sendMessage(chatId, `🔄 *Transfer Funds*\n\nPlease enter the receiver's *phone number*:`, { parse_mode: 'Markdown' });
        } catch (err) {
            console.error('[TelegramBot] /transfer error:', err);
            bot.sendMessage(chatId, 'An error occurred. Please try again.');
        }
    });

    // ─── /agent ────────────────────────────────────────────────────────────────
    bot.onText(/\/agent/, async (msg) => {
        const chatId = msg.chat.id;
        if (await checkMaintenance(chatId)) return;
        const AGENT_BOT_USERNAME = 'Max_agent1_bot'; // hardcoded
        bot.sendMessage(msg.chat.id,
            `👉 Agent ለመሆን/Register here as an agent:\n@${AGENT_BOT_USERNAME}`,
            { parse_mode: 'Markdown' }
        );
    });

    // ─── /contact ────────────────────────────────────────────────────────────────
    bot.onText(/\/contact/, (msg) => {
        bot.sendMessage(msg.chat.id,
            `🎧 *Customer Support*\n\nFor any questions or support, please contact: ${SUPPORT_USERNAME}`,
            { parse_mode: 'Markdown' }
        );
    });

    // ─── /invite ────────────────────────────────────────────────────────────────
    bot.onText(/\/invite/, async (msg) => {
        const chatId = msg.chat.id;
        if (await checkMaintenance(chatId)) return;
        sendInvite(chatId);
    });

    console.log('[TelegramBot] Main bot initialized (Webhook mode)');
    module.exports = {
        bot,
        processUpdate: (update) => bot.processUpdate(update)
    };
}
