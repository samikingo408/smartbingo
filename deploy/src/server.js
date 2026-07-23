/**
 * server.js
 * Express + Socket.IO server for the Bingo Telegram Mini App.
 */

console.log('[Trace] server.js started');
require('dotenv').config();
console.log('[Trace] dotenv loaded');

// ── Global safety net: prevent network errors from killing the process ──
process.on('unhandledRejection', (reason) => {
    console.error('[Server] Unhandled Rejection (kept alive):', reason?.message || reason);
});
process.on('uncaughtException', (err) => {
    console.error('================ FATAL STARTUP ERROR ================');
    console.error(err.stack || err.message || err);
    console.error('=====================================================');
    // We exit explicitly after a small delay so logs are flushed
    setTimeout(() => process.exit(1), 1000);
});
console.log('[Trace] Exception handlers registered');

const dns = require('dns');

// --- GLOBAL DNS PATCH FOR HF + TELEGRAM + ETHIO BANKS + PROXY ---
if (dns.setServers) {
    dns.setServers(['8.8.8.8', '1.1.1.1']); // global resolvers
}

const originalLookup = dns.lookup;
dns.lookup = (hostname, options, callback) => {
    if (typeof options === 'function') {
        callback = options;
        options = {};
    }
    const isAll = options && options.all;

    // Domains that need forced global DNS
    const overrideHosts = [
        'api.telegram.org',
        'transactioninfo.ethiotelecom.et'
    ];

    if (overrideHosts.includes(hostname)) {
        return dns.resolve4(hostname, (err, addresses) => {
            if (err || !addresses || addresses.length === 0) {
                return originalLookup(hostname, options, callback);
            }
            if (isAll) {
                return callback(null, addresses.map(a => ({ address: a, family: 4 })));
            }
            return callback(null, addresses[0], 4);
        });
    }

    return originalLookup(hostname, options, callback);
};

// --- SIMPLE TEST ---
const testHosts = [
    'api.telegram.org',
    'transactioninfo.ethiotelecom.et',
    'example.com'
];

testHosts.forEach(host => {
    dns.lookup(host, (err, address, family) => {
        if (err) console.log(`[DNS] ${host} FAILED:`, err.message);
        else console.log(`[DNS] ${host} resolved to ${address} (IPv${family})`);
    });
});
// ---------------------------------

console.log('[Trace] Importing express and others...');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
console.log('[Trace] Importing gameState...');
const path = require('path');
const gameState = require('./gameState');
console.log('[Trace] Importing cardGenerator...');
const { BINGO_CARDS } = require('./cardGenerator');

// Initialize the Telegram bot alongside the server
console.log('[Trace] Importing telegramBot...');
const telegramBot = require('./telegramBot');

// Initialize the Agent Bot
console.log('[Trace] Importing agentBot...');
const agentBot = require('./agentBot');

// Initialize the Admin Bot
console.log('[Trace] Importing adminBot...');
const adminBot = require('./adminBot');
console.log('[Trace] All bots imported successfully');

const PORT = process.env.PORT || 7860;
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';
// Webhook base URL — MUST be the backend's public URL (ngrok/deploy URL), NOT the frontend
// BACKEND_URL is the ngrok URL tunneled to this server (port 3001)
const WEBHOOK_BASE = process.env.BACKEND_URL || process.env.WEBAPP_URL;

const app = express();
const server = http.createServer(app);
const isProd = process.env.NODE_ENV === 'production';

const io = new Server(server, {
    cors: {
        origin: isProd ? FRONTEND_URL : '*',
        methods: ['GET', 'POST'],
    },
});

app.use(cors({
    origin: isProd ? FRONTEND_URL : '*',
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.text({ type: ['text/plain', 'text/html', 'text/*'] }));

// ─── Telegram Webhook Routes ──────────────────────────────────────────────────
// Moved up and made more robust
const handleWebhook = (botModule, req, res) => {
    if (botModule && botModule.processUpdate) {
        botModule.processUpdate(req.body);
    } else {
        console.error(`[Webhook] Bot module not ready for ${req.url}`);
    }
    res.sendStatus(200);
};

app.post(['/webhook/bingo', '/webhook/bingo/'], (req, res) => handleWebhook(telegramBot, req, res));
app.post(['/webhook/agent', '/webhook/agent/'], (req, res) => handleWebhook(agentBot, req, res));
app.post(['/webhook/admin', '/webhook/admin/'], (req, res) => handleWebhook(adminBot, req, res));

// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────

// Serve frontend static files from the 'public' folder
const frontendDistPath = path.resolve(__dirname, '../public');
const fs = require('fs');
if (fs.existsSync(frontendDistPath)) {
    app.use(express.static(frontendDistPath));
    // Fallback for React Router
    app.get('*', (req, res, next) => {
        if (req.url.startsWith('/webhook') || req.url.startsWith('/api') || req.url.startsWith('/health') || req.url.startsWith('/cards')) {
            return next();
        }
        const indexPath = path.join(frontendDistPath, 'index.html');
        if (fs.existsSync(indexPath)) {
            res.sendFile(indexPath);
        } else {
            next();
        }
    });
    console.log('[Server] Serving frontend from:', frontendDistPath);
} else {
    console.warn('[Server] WARNING: public/ folder not found at', frontendDistPath, '— frontend not served');
    app.get('/', (_, res) => res.send('<h1>✅ Smart Bingo Backend Running</h1><p>Frontend not deployed yet.</p>'));
}

// Health check
app.get('/health', (_, res) => res.json({ ok: true, phase: gameState.phase }));
app.get('/ping', (_, res) => res.send('pong'));

// Serve all 400 cards (for frontend pre-render)
app.get('/cards', (_, res) => res.json(BINGO_CARDS));

// ─── Socket.IO ────────────────────────────────────────────────────────────────

io.on('connection', (socket) => {
    console.log(`[connect] ${socket.id}`);

    // ── join: player registers with Telegram identity ──────────────────────────
    socket.on('join', async ({ userId, userName }) => {
        if (!userId) return;
        socket.userId = String(userId);
        socket.userName = userName || `Player_${userId}`;
        await gameState.getOrCreatePlayer(socket.userId, socket.userName);

        // Send full current state to this client
        const fullState = await gameState.getFullState(socket.userId);
        socket.emit('gameState', fullState);
    });

    // ── takeCard ───────────────────────────────────────────────────────────────
    socket.on('takeCard', async ({ cardId }, callback) => {
        if (!socket.userId) return callback?.({ ok: false, error: 'Not joined' });
        const result = await gameState.takeCard(socket.userId, cardId);
        callback?.(result);
        if (result.ok) {
            io.emit('cardTaken', {
                cardId,
                userName: socket.userName,
                totalTaken: result.totalTaken,
                winPot: result.winPot,
            });
        }
    });

    // ── cancelCard ─────────────────────────────────────────────────────────────
    socket.on('cancelCard', async ({ cardId }, callback) => {
        if (!socket.userId) return callback?.({ ok: false, error: 'Not joined' });
        const result = await gameState.cancelCard(socket.userId, cardId);
        callback?.(result);
        if (result.ok) {
            io.emit('cardReleased', {
                cardId,
                totalTaken: result.totalTaken,
                winPot: result.winPot,
            });
        }
    });

    // ── markNumber (player manually marks a called number) ─────────────────────
    socket.on('markNumber', ({ cardId, number }) => {
        if (!socket.userId) return;
        gameState.markNumber(socket.userId, cardId, number);
        // Emit back only to this player
        socket.emit('markUpdated', { cardId, number });
    });

    // ── claimBingo ─────────────────────────────────────────────────────────────
    socket.on('claimBingo', async ({ cardId }, callback) => {
        if (!socket.userId) return callback?.({ ok: false, error: 'Not joined' });
        const result = await gameState.claimBingo(socket.userId, cardId);
        callback?.(result);
        if (result.suspended) {
            // Notify everyone the card is suspended
            io.emit('cardSuspended', { cardId, userName: socket.userName });
        }
        // game over event is emitted inside gameState via io.emit('gameOver', ...)
    });

    // ── setAutoMode ────────────────────────────────────────────────────────────
    socket.on('setAutoMode', ({ enabled }) => {
        if (!socket.userId) return;
        gameState.setAutoMode(socket.userId, enabled);
    });

    // ── disconnect ─────────────────────────────────────────────────────────────
    socket.on('disconnect', () => {
        console.log(`[disconnect] ${socket.id}`);
    });
});

// ─── Start ────────────────────────────────────────────────────────────────────
const https = require('https');

server.listen(PORT, '0.0.0.0', async () => {
    console.log(`Bingo server running on http://0.0.0.0:${PORT}`);
    gameState.init(io);
    console.log('Game state initialized — lobby started');

    if (WEBHOOK_BASE) {
        console.log(`[Webhook] Registering webhooks with base URL: ${WEBHOOK_BASE}`);
        try {
            await telegramBot.bot.setWebHook(`${WEBHOOK_BASE}/webhook/bingo`);
            await agentBot.bot.setWebHook(`${WEBHOOK_BASE}/webhook/agent`);
            await adminBot.bot.setWebHook(`${WEBHOOK_BASE}/webhook/admin`);
            console.log('[Webhook] All webhooks registered successfully');
        } catch (err) {
            console.error('[Webhook] Registration failed:', err.message);
        }
    } else {
        console.warn('[Webhook] WEBHOOK_BASE not set — webhooks NOT registered. Bots will not receive messages.');
    }
});

// Keep Render backend awake — ping itself every 60 seconds (1 minute)
const selfUrl = process.env.BACKEND_URL || process.env.WEBAPP_URL;
if (selfUrl && selfUrl.startsWith('http')) {
    setInterval(() => {
        console.log(`[Keep-Awake] Pinging self (${selfUrl}/ping)...`);
        https.get(`${selfUrl}/ping`, (res) => {
            console.log(`[Keep-Awake] Self-ping response status: ${res.statusCode}`);
        }).on('error', (err) => {
            console.warn('[Keep-Awake] Self-ping failed:', err.message);
        });
    }, 60 * 1000);
} else {
    console.log('[Keep-Awake] Self-ping disabled (neither BACKEND_URL nor WEBAPP_URL is set).');
}
