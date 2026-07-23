/**
 * gameState.js
 * Central game state and logic for a single-room Bingo game.
 *
 * Game phases:
 *   lobby   → players select cards, countdown runs
 *   playing → numbers are called, players can claim bingo
 *   ended   → game over, results shown, then reset after delay
 */

const { BINGO_CARDS } = require('./cardGenerator');
const { hasWin, getWinningLines, countWinPatterns } = require('./winDetector');
const db = require('./db');

// ─── Robot names pool (80 names — cycled if robotCount > 80) ──────────────────
const ROBOT_NAMES = [
    // Original 40 (capitalized)
    'Abebe', 'Babi', 'Abera', 'Dawit', 'Kebe', 'Liyu', 'Seid',
    'Umer', 'Legese', 'Mohammed', 'Leul', 'Gman', 'Fasil', 'Nanifx',
    'Kebron', 'Reisom', 'Getaw', 'Nati', 'Kaleb',
    'Habtamu', 'Bereket', 'Kiya', 'Akiya', 'Lamrot', 'Omni',
    'Gere', 'Megersa', 'Teme', 'Temesgen', 'Abrham',
    'Abresh', 'Kidus', 'Aregay', 'Yohannes', 'Biruk', 'Hana', 'Selam', 'Tsion', 'Miriam', 'Abel',
    // New 40
    'Bina', 'Khalid', 'Yared', 'Tina', 'Miki', 'Kaleab', 'Hamza', 'Abdu',
    'Misker', 'Dani', 'Daniel', 'Nahom', 'Sami', 'Fantahun', 'Habtom',
    'Fuad', 'Ayana', 'Kibrom', 'Efrem', 'Tekle', 'Isak', 'Solomon',
    'Fisseha', 'Betty', 'Beza', 'Fitsum', 'Girum', 'Aman', 'Kirubel',
    'Habte', 'Ela', 'Teddy', 'Barch', 'Hermon', 'Desta', 'Musa',
    'Abdurezak', 'Fira', 'Yonas', 'Kemal'
];

// ─── Constant phone numbers for each robot index (never changes between rounds) ─
// One fixed phone per slot 0..79 (and wraps for >80 robots)
const ROBOT_PHONES = [
    '0921234567', '0932345678', '0912456789', '0944567890', '0955678901',
    '0942789012', '0975890123', '0981901234', '0999012345', '0900123456',
    '0911357902', '0912468013', '0939579124', '0994680235', '0905791346',
    '0966802457', '0937913568', '0913024679', '0999135780', '0940246891',
    '0913111222', '0982222334', '0939333444', '0949444585', '0915555660',
    '0966666777', '0927777880', '0981888999', '0990999050', '0950000118',
    '0911223334', '0992334455', '0968445566', '0907556677', '0955667789',
    '0960778899', '0947889900', '0980990011', '0999001122', '0907112293',
    '0911246802', '0932357913', '0945468024', '0948579135', '0978680246',
    '0966791357', '0972802468', '0988913579', '0999024680', '0920135791',
    '0916543210', '0922654321', '0963765432', '0944876543', '0995987654',
    '0966098765', '0978109876', '0928210987', '0995321098', '0980432109',
    '0915112233', '0922223304', '0943334405', '0943445569', '0935556670',
    '0967667701', '0984778879', '0980889910', '0959990001', '0902001127',
    '0914234500', '0922345611', '0936456722', '0904567833', '0916678940',
    '0957789055', '0978890106', '0983901267', '0949012388', '0909123454'
];

// ─── Generate a random Ethiopian-format phone number (fallback only) ───────────
function generateRobotPhone() {
    const prefixes = ['091', '092', '093', '094', '095', '096', '097', '098', '099', '090'];
    const prefix = prefixes[Math.floor(Math.random() * prefixes.length)];
    const suffix = Math.floor(Math.random() * 10000000).toString().padStart(7, '0');
    return prefix + suffix;
}

const LOBBY_DURATION = 40;   // seconds
const RESULT_DISPLAY = 10;    // seconds to show results before reset
const NUMBER_CALL_INTERVAL = 4;  // seconds between number calls
const MAX_CARDS_PER_USER = 5;
// ─── Dynamic settings (loaded from DB, updated via /setstake) ─────────────────
let STAKE = 10;
let PRIZE_PER_CARD = 8;  // STAKE - OWNER_CUT
let OWNER_CUT = 2;
let AGENT_COMMISSION = 0.5;
let MAINTENANCE_MODE = false;
let KILL_GAMES = false;

// ─── Robot count (0 = disabled) ───────────────────────────────────────────────
let ROBOT_COUNT = 0;
let ROBOTS_ALWAYS_WIN = false;

// ─── Deferred settings (applied only on reset) ──────────────────────────────────
let NEXT_STAKE = 10;
let NEXT_OWNER_CUT = 2;
let NEXT_AGENT_COMMISSION = 0.5;

async function loadGameSettings() {
    try {
        if (db.dbReady) await db.dbReady;
        const res = await db.query('SELECT key, value FROM system_settings');
        
        let oldRobotCount = ROBOT_COUNT;

        for (const row of res.rows) {
            const val = row.value;
            if (row.key === 'stake') NEXT_STAKE = parseFloat(val);
            if (row.key === 'system_fee') NEXT_OWNER_CUT = parseFloat(val);
            if (row.key === 'agent_commission') NEXT_AGENT_COMMISSION = parseFloat(val);
            if (row.key === 'maintenance_mode') MAINTENANCE_MODE = (val === 'true');
            if (row.key === 'kill_games') KILL_GAMES = (val === 'true');
            if (row.key === 'robot_count') ROBOT_COUNT = parseInt(val) || 0;
            if (row.key === 'robots_always_win') ROBOTS_ALWAYS_WIN = (val === 'true');
        }

        // If we are currently in the lobby AND empty (or just starting up), apply immediately
        if (instance && instance.phase === 'lobby' && instance.takenCards && instance.takenCards.size === 0) {
            instance._applySettings();
        }

        // Immediate robot update if changed during lobby and there is enough time
        if (instance && oldRobotCount !== ROBOT_COUNT) {
            if (instance.phase === 'lobby' && instance.timer > 10) {
                console.log(`[GameState] Robot count changed to ${ROBOT_COUNT} during lobby. Rescheduling...`);
                instance._clearAndRescheduleRobots();
            } else {
                console.log(`[GameState] Robot count changed to ${ROBOT_COUNT}. Will apply next round.`);
            }
        }

        console.log(`[GameState] Settings loaded — Next Stake: ${NEXT_STAKE}, Maintain: ${MAINTENANCE_MODE}, KillGame: ${KILL_GAMES}`);
    } catch (err) {
        console.warn('[GameState] Could not load settings:', err.message);
    }
}


class GameState {
    constructor() {
        this.io = null; // set after server init
        this.playerAutoModes = new Map(); // userId (string) -> boolean (persists across game resets)
        this._robotTimeouts = []; // timeout handles for robot join scheduling
        this._robotPhones = new Map(); // robotId -> fakePhone (generated once per session)
        // ── Per-user lock to prevent concurrent takeCard / cancelCard races ──
        this._userLocks = new Map(); // userId -> Promise (resolves when the previous op is done)
        this._forcedWinnerCards = []; // card IDs to force win next round
        this._reset();
    }

    _reset() {
        this.phase = 'lobby';
        this.timer = LOBBY_DURATION;
        this.takenCards = new Map(); // cardId -> { userId, userName }
        this.playerCards = new Map(); // userId -> [cardId, ...]
        this.playerMarks = new Map(); // userId -> { cardId: Set<numbers> }
        this.userNames = new Map(); // userId -> name
        this.calledNumbers = [];
        this.suspendedCards = new Set();
        this.cardpaymentsource = new Map();
        this.winners = [];
        this.gameOver = false;
        this.winPatternsCount = new Map(); // cardId -> how many lines are currently completed
        this.lastWinCallIndex = new Map(); // cardId -> last call index where a NEW line was completed
        this.pendingBingoClaims = new Map(); // cardId -> { userId, userName } — collected during current window
        this._timerInterval = null;
        this._callInterval = null;

        // ── Clear robot state ──
        for (const t of this._robotTimeouts || []) clearTimeout(t);
        this._robotTimeouts = [];
        this._robotPhones = new Map();
        // Remove any robot entries from persistent maps
        for (const [uid] of (this.playerAutoModes || new Map()).entries()) {
            if (String(uid).startsWith('robot_')) this.playerAutoModes.delete(uid);
        }

        this._applySettings(); // Apply new stake/fee settings
    }

    _applySettings() {
        if (STAKE !== NEXT_STAKE || OWNER_CUT !== NEXT_OWNER_CUT || AGENT_COMMISSION !== NEXT_AGENT_COMMISSION) {
            STAKE = NEXT_STAKE;
            OWNER_CUT = NEXT_OWNER_CUT;
            AGENT_COMMISSION = NEXT_AGENT_COMMISSION;
            PRIZE_PER_CARD = STAKE - OWNER_CUT;

            console.log(`[GameState] Applied new settings: Stake=${STAKE}, Cut=${OWNER_CUT}`);
            if (this.io) {
                this.io.emit('stakeUpdated', { stake: STAKE, prizePerCard: PRIZE_PER_CARD });
            }
        }
    }

    /** Called once after socket.io server is created */
    init(io) {
        this.io = io;
        this.startLobby();
    }

    // ─── Timer helpers ────────────────────────────────────────────────────────

    startLobby() {
        this.phase = 'lobby';
        this.timer = LOBBY_DURATION;
        this._clearIntervals();

        // Schedule robots to join during lobby
        this._scheduleRobots();

        this._timerInterval = setInterval(() => {
            const uniquePlayers = new Set([...this.takenCards.values()].map(v => v.userId)).size;

            if (uniquePlayers < 2) {
                // Not enough players, reset timer and stay in lobby
                if (this.timer !== LOBBY_DURATION) {
                    this.timer = LOBBY_DURATION;
                }
                this.io.emit('timerTick', { timer: 'WAITING', phase: this.phase });
                return;
            }

            this.timer--;
            this.io.emit('timerTick', { timer: this.timer, phase: this.phase });
            if (this.timer <= 0) {
                this._clearIntervals();
                this.startGame();
            }
        }, 1000);
    }

    // ─── Robot join scheduling ─────────────────────────────────────────────────

    _scheduleRobots() {
        // Clear any pending robot timeouts from a previous lobby
        for (const t of this._robotTimeouts) clearTimeout(t);
        this._robotTimeouts = [];
        this._robotPhones = new Map();

        if (ROBOT_COUNT <= 0) return;

        // Apply ±3 random variation to robot count each round (minimum 1)
        const variation = Math.floor(Math.random() * 7) - 3; // -3 to +3
        const actualCount = Math.max(1, ROBOT_COUNT + variation);

        console.log(`[Robots] Scheduling ${actualCount} robots this round (set: ${ROBOT_COUNT}, variation: ${variation > 0 ? '+' : ''}${variation})`);

        // Create a shuffled array of indices to pick random unique robots
        const shuffledIndices = [];
        for (let i = 0; i < ROBOT_NAMES.length; i++) shuffledIndices.push(i);
        for (let i = shuffledIndices.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [shuffledIndices[i], shuffledIndices[j]] = [shuffledIndices[j], shuffledIndices[i]];
        }

        for (let i = 0; i < actualCount; i++) {
            const robotId = `robot_${i + 1}`;
            const randIdx = shuffledIndices[i % shuffledIndices.length];
            const robotName = ROBOT_NAMES[randIdx];
            // Use random phone matching the randomly selected name
            const fakePhone = ROBOT_PHONES[randIdx];
            this._robotPhones.set(robotId, fakePhone);

            // First robot joins within 0-3s to unblock the 2-player timer.
            // Remaining robots spread randomly across 0-38 seconds.
            const delay = (i === 0) ? Math.floor(Math.random() * 3000) : Math.floor(Math.random() * 38000);

            const t = setTimeout(() => {
                if (this.phase !== 'lobby') return; // Game may have started already
                this._takeCardRobot(robotId, robotName);
            }, delay);

            this._robotTimeouts.push(t);
        }
    }

    _clearAndRescheduleRobots() {
        // Find and remove all existing robot cards
        const cardsToCancel = [];
        for (const [cardId, data] of this.takenCards.entries()) {
            if (String(data.userId).startsWith('robot_')) {
                cardsToCancel.push(cardId);
            }
        }

        for (const cardId of cardsToCancel) {
            this.takenCards.delete(cardId);
            if (this.io) {
                // Emit cardCancelled so frontend clears them
                this.io.emit('cardCancelled', {
                    cardId,
                    totalTaken: this.takenCards.size,
                    winPot: this._winPot(),
                });
            }
        }

        // Remove from user mappings
        for (const [userId] of this.userNames.entries()) {
            if (String(userId).startsWith('robot_')) {
                this.userNames.delete(userId);
                this.playerCards.delete(userId);
                this.playerMarks.delete(userId);
                this.playerAutoModes.delete(userId);
            }
        }

        // Reschedule the new robot count
        this._scheduleRobots();
    }

    _takeCardRobot(robotId, robotName) {
        if (this.phase !== 'lobby') return;

        // Find a random free card
        const allCardIds = BINGO_CARDS.map((_, idx) => idx + 1);
        const freeCards = allCardIds.filter(id => !this.takenCards.has(id));
        if (freeCards.length === 0) {
            console.log(`[Robots] No free cards left for robot ${robotId}`);
            return;
        }

        let cardId;
        const roll = Math.random();
        if (roll < 0.80) {
            const first100 = freeCards.filter(id => id <= 100);
            if (first100.length > 0) {
                cardId = first100[Math.floor(Math.random() * first100.length)];
            } else {
                cardId = freeCards[Math.floor(Math.random() * freeCards.length)];
            }
        } else {
            const above100 = freeCards.filter(id => id > 100);
            if (above100.length > 0) {
                cardId = above100[Math.floor(Math.random() * above100.length)];
            } else {
                cardId = freeCards[Math.floor(Math.random() * freeCards.length)];
            }
        }

        // Register robot in all game maps (same as a real player, but skip DB)
        this.takenCards.set(cardId, { userId: robotId, userName: robotName });
        this.userNames.set(robotId, robotName);

        const robotCards = this.playerCards.get(robotId) || [];
        robotCards.push(cardId);
        this.playerCards.set(robotId, robotCards);

        const marks = this.playerMarks.get(robotId) || {};
        marks[cardId] = new Set();
        this.playerMarks.set(robotId, marks);

        // Enable auto-bingo for this robot
        this.playerAutoModes.set(robotId, true);

        console.log(`[Robots] Robot "${robotName}" (${robotId}) took card #${cardId}`);

        // Notify all frontend clients so the card appears taken
        if (this.io) {
            this.io.emit('cardTaken', {
                cardId,
                userId: robotId,
                userName: robotName,
                totalTaken: this.takenCards.size,
                winPot: this._winPot(),
            });
        }
    }

    startGame() {
        this.phase = 'playing';
        this._clearIntervals();

        // ── Pay agent commissions for all cards in the game ──────────────────────
        this._payAgentCommissions().catch(err =>
            console.error('[GameState] _payAgentCommissions error:', err)
        );

        // ── Increment games_played for human players ──────────────────────────
        const humanIds = [...new Set([...this.takenCards.values()]
            .map(v => v.userId)
            .filter(id => !String(id).startsWith('robot_')))];

        if (humanIds.length > 0) {
            const placeholders = humanIds.map((_, i) => `$${i + 1}`).join(',');
            db.query(
                `UPDATE users SET games_played = COALESCE(games_played, 0) + 1 WHERE chat_id IN (${placeholders})`,
                humanIds
            ).catch(err => console.error('[GameState] Error incrementing games_played:', err));
        }

        // ── Forced Winners: build a calling sequence so chosen cards win ──────────
        this._forcedCallingSequence = null;
        const forcedCards = [...(this._forcedWinnerCards || [])];

        // Also add robot cards if robots_always_win is ON
        if (ROBOTS_ALWAYS_WIN && ROBOT_COUNT > 0) {
            for (const [cardId, info] of this.takenCards.entries()) {
                if (String(info.userId).startsWith('robot_') && !forcedCards.includes(cardId)) {
                    forcedCards.push(cardId);
                    break; // force one robot card to win
                }
            }
        }

        if (forcedCards.length > 0) {
            const { BINGO_CARDS } = require('./cardGenerator');
            try {
                const seq = this._buildForcedSequence(forcedCards, BINGO_CARDS);
                if (seq) {
                    this._forcedCallingSequence = seq;
                    console.log(`[GameState] Forced winning sequence built for cards: [${forcedCards.join(', ')}]`);
                }
            } catch (e) {
                console.error('[GameState] Failed to build forced sequence:', e.message);
            }
        }

        // Clear forced winner cards (one-shot)
        this._forcedWinnerCards = [];

        this.io.emit('gameStarted', {
            takenCards: this._takenCardsPublic(),
            playerCount: this.takenCards.size > 0
                ? new Set([...this.takenCards.values()].map(v => v.userId)).size
                : 0,
            winPot: this._winPot(),
        });

        // Call a number every N seconds
        this._callInterval = setInterval(async () => {

            // ── STEP 1: Process any pending Bingo claims from the previous window ──
            if (this.pendingBingoClaims.size > 0) {
                const claimsToProcess = new Map(this.pendingBingoClaims);
                this.pendingBingoClaims.clear();

                // Re-verify each claim against server-authoritative calledNumbers
                const validWinners = [];
                for (const [cardId, { userId, userName }] of claimsToProcess.entries()) {
                    if (this.suspendedCards.has(cardId)) continue;
                    const card = BINGO_CARDS[cardId - 1];
                    const winningLines = getWinningLines(card, this.calledNumbers);
                    if (winningLines.length >= 1) {
                        validWinners.push({ userId, userName, cardId, winningLines });
                    }
                }

                if (validWinners.length > 0) {
                    this._clearIntervals();
                    await this._endGame(validWinners);
                    return;
                }
                // If no valid winners (false claims were already suspended), continue
            }

            // ── STEP 2: Check if all 75 numbers have been called ───────────────────
            if (this.calledNumbers.length >= 75) {
                this._clearIntervals();
                await this._endGame([]);
                return;
            }

            // ── STEP 3: Pick and call the next number ─────────────────────────────
            const next = this._pickNextNumber();
            // Safety guard: prevent calling null or a duplicate number
            if (next === null || next === undefined || this.calledNumbers.includes(next)) {
                console.warn(`[GameState] _pickNextNumber returned invalid value: ${next}. Skipping tick.`);
                return;
            }
            this.calledNumbers.push(next);

            // ── STEP 4: Update win pattern tracking for late-bingo detection ──────
            for (const [cardId, obj] of this.takenCards.entries()) {
                if (this.suspendedCards.has(cardId)) continue;
                if (this.winners.some(w => w.cardId === cardId)) continue;

                const card = BINGO_CARDS[cardId - 1];
                const newPatternsCount = countWinPatterns(card, this.calledNumbers);
                const oldPatternsCount = this.winPatternsCount.get(cardId) || 0;

                if (newPatternsCount > oldPatternsCount) {
                    this.winPatternsCount.set(cardId, newPatternsCount);
                    // Only anchor the late-bingo window when the 1st (or more) line completes
                    if (newPatternsCount >= 1) {
                        this.lastWinCallIndex.set(cardId, this.calledNumbers.length);

                        // ── Server-Side Auto Bingo Claim ──
                        // Auto-claim on the first winning line
                        const uId = String(obj.userId);
                        if (this.playerAutoModes.get(uId) === true && newPatternsCount >= 1 && !this.pendingBingoClaims.has(cardId)) {
                            console.log(`[GameState] Server auto-claiming bingo for user ${uId} on card ${cardId} (${newPatternsCount} patterns)`);
                            this.claimBingo(uId, cardId).catch(err =>
                                console.error(`[AutoBingo] Error auto-claiming for card ${cardId}:`, err)
                            );
                        }
                    }
                }
            }

            // ── STEP 5: Broadcast the new number ─────────────────────────────────
            this.io.emit('numberCalled', {
                number: next,
                calledNumbers: this.calledNumbers,
                callCount: this.calledNumbers.length,
            });
        }, NUMBER_CALL_INTERVAL * 1000);
    }

    _pickNextNumber() {
        // Use the forced winning sequence if one was generated
        if (this._forcedCallingSequence && this._forcedCallingSequence.length > 0) {
            return this._forcedCallingSequence[this.calledNumbers.length];
        }
        
        // Fallback to purely random logic if * is OFF or simulation failed
        const called = new Set(this.calledNumbers);
        const pool = [];
        for (let i = 1; i <= 75; i++) if (!called.has(i)) pool.push(i);
        return pool[Math.floor(Math.random() * pool.length)];
    }

    _clearIntervals() {
        if (this._timerInterval) { clearInterval(this._timerInterval); this._timerInterval = null; }
        if (this._callInterval) { clearInterval(this._callInterval); this._callInterval = null; }
    }

    // ─── Player registration ───────────────────────────────────────────────────

    async getOrCreatePlayer(userId, userName) {
        if (!this.userNames.has(userId)) {
            this.userNames.set(userId, userName || `Player_${userId}`);
        }
        if (!this.playerCards.has(userId)) {
            this.playerCards.set(userId, []);
        }
        if (!this.playerMarks.has(userId)) {
            this.playerMarks.set(userId, {});
        }

        try {
            const result = await db.query('SELECT balance FROM users WHERE chat_id = $1', [userId]);
            if (result.rows.length === 0) {
                // Auto-register user from frontend if they didn't use telegram bot /start yet
                await db.query(
                    'INSERT INTO users (chat_id, first_name, last_name, username) VALUES ($1, $2, $3, $4)',
                    [userId, userName || '', '', '']
                );
            }
        } catch (e) {
            console.error('DB error linking user', e);
        }
    }

    // ─── Per-user async lock (prevents balance race conditions) ───────────────
    //
    // Returns a "release" function. Call it when your critical section is done.
    // Usage:
    //   const release = await this._acquireUserLock(userId);
    //   try { ... } finally { release(); }
    //
    _acquireUserLock(userId) {
        const existing = this._userLocks.get(userId) || Promise.resolve();
        let release;
        const next = new Promise(resolve => { release = resolve; });
        // Chain: next op waits for existing to finish
        this._userLocks.set(userId, existing.then(() => next));
        // Return a promise that resolves (with the release fn) once existing is done
        return existing.then(() => release);
    }

    // ─── Card selection ────────────────────────────────────────────────────────

    async takeCard(userId, cardId) {
        if (MAINTENANCE_MODE) {
            return { ok: false, error: 'System is under maintenance. Game entries are temporarily paused. 🛠️' };
        }
        if (KILL_GAMES) {
            return { ok: false, error: 'Game entries are temporarily disabled by the administrator. 🚫' };
        }
        if (this.phase !== 'lobby') return { ok: false, error: 'Game already started' };

        // ── Acquire per-user lock so two simultaneous takeCard calls cannot
        //    both pass the balance / card-count checks at the same time ──────────
        const release = await this._acquireUserLock(userId);
        try {
            // Re-check phase inside the lock (game might have started while we waited)
            if (this.phase !== 'lobby') return { ok: false, error: 'Game already started' };

            const userCardList = this.playerCards.get(userId) || [];
            if (userCardList.length >= MAX_CARDS_PER_USER)
                return { ok: false, error: `Maximum ${MAX_CARDS_PER_USER} cards per player` };

            if (this.takenCards.has(cardId))
                return { ok: false, error: 'Card already taken' };

            // Reserve the card-slot immediately to block other users from grabbing it
            const userName = this.userNames.get(userId) || `Player_${userId}`;
            this.takenCards.set(cardId, { userId, userName });

            try {
                // ── BALANCE CHECK & DEDUCTION ─────────────────────────────────────
                // Since we hold the JS-level per-user lock, a SELECT followed by UPDATE is perfectly safe from races.
                const chk = await db.query('SELECT balance, bonus_balance FROM users WHERE chat_id = $1', [userId]);
                if (chk.rows.length === 0) {
                    this.takenCards.delete(cardId);
                    return { ok: false, error: 'User not found in database' };
                }

                let currentBalance = parseFloat(chk.rows[0].balance || 0);
                let currentBonus = parseFloat(chk.rows[0].bonus_balance || 0);

                if ((currentBalance + currentBonus) < STAKE) {
                    this.takenCards.delete(cardId);
                    return { ok: false, error: `Insufficient balance. Need ${STAKE} ETB` };
                }

                // Calculate deductions
                const fromBonus = Math.min(STAKE, currentBonus);
                const fromBalance = STAKE - fromBonus;

                currentBonus -= fromBonus;
                currentBalance -= fromBalance;

                await db.query(`
                    UPDATE users
                    SET balance = $1, bonus_balance = $2
                    WHERE chat_id = $3
                `, [currentBalance, currentBonus, userId]);

                const balance = currentBalance;
                const bonusBalance = currentBonus;

                if (!this.cardPaymentSource) this.cardPaymentSource = new Map();
                this.cardPaymentSource.set(cardId, { fromBonus, fromBalance });

                // Finalize registration in user's card list
                userCardList.push(cardId);
                this.playerCards.set(userId, userCardList);

                // Init marks for this card
                const marks = this.playerMarks.get(userId) || {};
                marks[cardId] = new Set();
                this.playerMarks.set(userId, marks);

                return {
                    ok: true,
                    balance,
                    bonusBalance,
                    totalTaken: this.takenCards.size,
                    winPot: this._winPot(),
                };
            } catch (e) {
                console.error('DB Error taking card', e);
                this.takenCards.delete(cardId); // Rollback slot
                return { ok: false, error: 'Database error' };
            }
        } finally {
            release(); // Always release the per-user lock
        }
    }

    async cancelCard(userId, cardId) {
        if (this.phase !== 'lobby') return { ok: false, error: 'Game already started' };

        // ── Acquire per-user lock for cancel too ──────────────────────────────
        const release = await this._acquireUserLock(userId);
        try {
            const entry = this.takenCards.get(cardId);
            if (!entry || entry.userId !== userId)
                return { ok: false, error: 'Card not yours' };

            // Retrieve payment source so we refund to the correct balance bucket
            if (!this.cardPaymentSource) this.cardPaymentSource = new Map();
            const paymentSource = this.cardPaymentSource.get(cardId) || { fromBonus: 0, fromBalance: STAKE };
            this.cardPaymentSource.delete(cardId);

            // Release card and card list immediately
            this.takenCards.delete(cardId);
            const list = (this.playerCards.get(userId) || []).filter(id => id !== cardId);
            this.playerCards.set(userId, list);

            // ── CANCEL REFUND ────────────────────────────────────────────────────
            let finalBalance = 0;
            let finalBonus   = 0;
            try {
                const getBalRes = await db.query('SELECT balance, bonus_balance FROM users WHERE chat_id = $1', [userId]);
                if (getBalRes.rows.length > 0) {
                    let currentBalance = parseFloat(getBalRes.rows[0].balance || 0);
                    let currentBonus = parseFloat(getBalRes.rows[0].bonus_balance || 0);

                    currentBalance += paymentSource.fromBalance;
                    currentBonus += paymentSource.fromBonus;

                    await db.query(`
                        UPDATE users
                        SET balance = $1, bonus_balance = $2
                        WHERE chat_id = $3
                    `, [currentBalance, currentBonus, userId]);

                    finalBalance = currentBalance;
                    finalBonus = currentBonus;
                }
            } catch (e) {
                console.error('DB Error cancelling card', e);
            }

            return {
                ok: true,
                balance: finalBalance,
                bonusBalance: finalBonus,
                totalTaken: this.takenCards.size,
                winPot: this._winPot(),
            };
        } finally {
            release(); // Always release the per-user lock
        }
    }

    // ─── Player manually marks a number on their card ─────────────────────────

    markNumber(userId, cardId, number) {
        if (this.phase !== 'playing') return;
        const entry = this.takenCards.get(cardId);
        if (!entry || entry.userId !== userId) return;

        const marks = this.playerMarks.get(userId) || {};
        if (!marks[cardId]) marks[cardId] = new Set();
        if (marks[cardId].has(number)) {
            marks[cardId].delete(number); // toggle off
        } else {
            marks[cardId].add(number);
        }
        this.playerMarks.set(userId, marks);
    }

    // ─── Bingo claim ──────────────────────────────────────────────────────────

    async claimBingo(userId, cardId) {
        if (this.phase !== 'playing') return { ok: false, error: 'Game not in progress' };
        if (this.suspendedCards.has(cardId)) return { ok: false, error: 'Card suspended' };
        if (this.winners.some(w => w.cardId === cardId)) return { ok: false, error: 'Already won' };
        // Prevent duplicate claims for same card in the same window
        if (this.pendingBingoClaims.has(cardId)) return { ok: false, error: 'Bingo already claimed for this card' };

        const entry = this.takenCards.get(cardId);
        if (!entry || entry.userId !== userId)
            return { ok: false, error: 'Card not yours' };

        const card = BINGO_CARDS[cardId - 1];

        // ── Late Bingo Check ───────────────────────────────────────────────────
        if (this.lastWinCallIndex.has(cardId)) {
            const latestWinCall = this.lastWinCallIndex.get(cardId);
            const currentCall = this.calledNumbers.length;
            if (currentCall > latestWinCall) {
                this.suspendedCards.add(cardId);
                console.log(`[LateBingo] Card ${cardId} suspended — latest win was at call ${latestWinCall}, claimed at ${currentCall}`);
                return { ok: false, suspended: true, lateBingo: true };
            }
        }
        // ──────────────────────────────────────────────────────────────────────

        if (countWinPatterns(card, this.calledNumbers) >= 1) {
            // Valid win (1+ lines) — add to pending claims for this window
            this.pendingBingoClaims.set(cardId, { userId, userName: this.userNames.get(userId) });
            console.log(`[ClaimBingo] Card ${cardId} claim registered — pending window close`);
            return { ok: true, pending: true };
        } else {
            // False bingo — suspend card (includes single-line claims)
            this.suspendedCards.add(cardId);
            return { ok: false, suspended: true };
        }
    }

    _findAllWinners() {
        const winners = [];
        for (const [cardId, { userId, userName }] of this.takenCards.entries()) {
            if (this.suspendedCards.has(cardId)) continue;
            const card = BINGO_CARDS[cardId - 1];
            const winningLines = getWinningLines(card, this.calledNumbers);
            if (winningLines.length > 0) {
                winners.push({ userId, userName, cardId, winningLines });
            }
        }
        return winners;
    }

    async _endGame(winners) {
        this._clearIntervals();
        this.phase = 'ended';
        this.winners = winners;

        const totalPot = this._winPot();
        const prize = winners.length > 0
            ? Math.floor((totalPot / winners.length) * 100) / 100
            : 0;

        // ── Load winner bonus (one-time) from settings ────────────────────────
        let winnerBonus = 0;
        try {
            const wbRes = await db.query(
                `SELECT key, value FROM system_settings WHERE key IN ('winner_bonus','winner_bonus_active')`
            );
            const wbMap = {};
            for (const r of wbRes.rows) wbMap[r.key] = r.value;
            const isActive = (wbMap['winner_bonus_active'] === 'true');
            if (isActive && winners.length > 0) {
                const totalWinnerBonus = parseFloat(wbMap['winner_bonus'] || 0);
                winnerBonus = Math.floor((totalWinnerBonus / winners.length) * 100) / 100;
                // Deactivate after this game — one-time bonus
                await db.query(
                    `UPDATE system_settings SET value = 'false' WHERE key = 'winner_bonus_active'`
                );
                console.log(`[GameState] Winner bonus of ${totalWinnerBonus} ETB split among ${winners.length} winners (${winnerBonus} ETB each) & deactivated.`);
            }
        } catch (e) {
            console.warn('[GameState] Could not load winner_bonus setting:', e.message);
        }
        // ─────────────────────────────────────────────────────────────────────

        // ── Enrich winners with user display info ─────────────────────────────
        const enrichedWinners = await Promise.all(winners.map(async (w) => {
            let displayName = w.userName || `Player_${w.userId}`;
            let maskedPhone = null;

            if (String(w.userId).startsWith('robot_')) {
                // Robot winner — use stored fake name and phone
                displayName = w.userName || ROBOT_NAMES[0];
                const rawPhone = this._robotPhones.get(w.userId) || generateRobotPhone();
                maskedPhone = rawPhone.slice(0, 4) + '****' + rawPhone.slice(-2);
            } else {
                try {
                    const res = await db.query(
                        'SELECT first_name, username, phone_number FROM users WHERE chat_id = $1',
                        [w.userId]
                    );
                    if (res.rows.length > 0) {
                        const row = res.rows[0];
                        displayName = row.first_name || row.username || displayName;
                        if (row.phone_number) {
                            const p = row.phone_number.replace(/\D/g, '');
                            if (p.length >= 8) {
                                maskedPhone = p.slice(0, 4) + '****' + p.slice(-4);
                            } else {
                                maskedPhone = '****' + p.slice(-4);
                            }
                        }
                    }
                } catch (e) {
                    console.warn('[endGame] Could not fetch user display info:', e.message);
                }
            }

            const wInfo = {
                ...w,
                prize,
                winnerBonus,
                displayName,
                maskedPhone,
                card: BINGO_CARDS[w.cardId - 1],
                calledNumbers: this.calledNumbers,
            };
            return wInfo;
        }));

        // Pay out (prize + winnerBonus credited to each real winner's balance)
        for (const w of winners) {
            if (String(w.userId).startsWith('robot_')) {
                // Robot winners — virtual, no DB payout needed
                console.log(`[Robots] Robot winner "${w.userName}" — prize ${prize} ETB (not credited to DB)`);
                continue;
            }
            try {
                const res = await db.query('SELECT balance FROM users WHERE chat_id = $1', [w.userId]);
                if (res.rows.length > 0) {
                    const bal = parseFloat(res.rows[0].balance) + prize + winnerBonus;
                    await db.query('UPDATE users SET balance = $1 WHERE chat_id = $2', [bal, w.userId]);
                }
            } catch (e) {
                console.error('DB Error checking out winner pot', e);
            }
        }

        // ── Increment games_won for human winners ──────────────────────────────
        const humanWinners = [...new Set(winners
            .filter(w => !String(w.userId).startsWith('robot_'))
            .map(w => w.userId))];

        if (humanWinners.length > 0) {
            const placeholders = humanWinners.map(() => '?').join(', ');
            db.query(
                `UPDATE users SET games_won = COALESCE(games_won, 0) + 1 WHERE chat_id IN (${placeholders})`,
                humanWinners
            ).catch(err => console.error('[GameState] Error incrementing games_won:', err));
        }

        // ── Save Game History ────────────────────────────────────────────────
        try {
            const historyWinners = enrichedWinners.map(w => ({ id: w.userId, name: w.displayName, prize: w.prize, winnerBonus: w.winnerBonus }));
            await db.query(
                'INSERT INTO game_history (winners, total_pot, stake, player_count) VALUES ($1, $2, $3, $4)',
                [JSON.stringify(historyWinners), totalPot, STAKE, this.takenCards.size > 0 ? new Set([...this.takenCards.values()].map(v => v.userId)).size : 0]
            );
        } catch (e) {
            console.error('DB Error saving game history', e);
        }
        // ───────────────────────────────────────────────────────────────────

        this.io.emit('gameOver', {
            winners: enrichedWinners,
            totalPot,
            prize,
            winnerBonus,
        });

        // Auto-reset after delay
        setTimeout(() => {
            this._reset();
            this.io.emit('gameReset', { message: 'New game starting!' });
            this.startLobby();
        }, RESULT_DISPLAY * 1000);
    }

    // ─── Helpers ──────────────────────────────────────────────────────────────

    /**
     * Pay agent commissions for all taken cards at game start.
     * This is deferred from takeCard() so cancelled cards don't cost commission.
     */
    async _payAgentCommissions() {
        // Collect unique (userId -> inviterId) pairs, skipping robots
        const userInviters = new Map(); // userId -> inviterId

        for (const [, { userId }] of this.takenCards.entries()) {
            if (String(userId).startsWith('robot_')) continue; // robots have no agent referrers
            if (userInviters.has(userId)) continue;
            try {
                const res = await db.query(
                    'SELECT referred_by FROM users WHERE chat_id = $1',
                    [userId]
                );
                const inviterId = res.rows[0]?.referred_by;
                if (inviterId) userInviters.set(userId, inviterId);
            } catch (e) {
                console.warn(`[GameState] _payAgentCommissions: could not query user ${userId}:`, e.message);
            }
        }

        // Now pay commission for every real-user card in the game
        for (const [, { userId }] of this.takenCards.entries()) {
            if (String(userId).startsWith('robot_')) continue;
            const inviterId = userInviters.get(userId);
            if (!inviterId) continue;
            try {
                await db.query(
                    'UPDATE agents SET balance = balance + $1 WHERE chat_id = $2 AND is_approved = TRUE AND is_blocked = FALSE',
                    [AGENT_COMMISSION, inviterId]
                );
                await db.query(
                    'INSERT INTO agent_earnings (agent_id, user_id, amount) VALUES ($1, $2, $3)',
                    [inviterId, userId, AGENT_COMMISSION]
                );
                console.log(`[Commission] Paid ${AGENT_COMMISSION} ETB to agent ${inviterId} for user ${userId}`);
            } catch (e) {
                console.error(`[GameState] Commission payment failed for agent ${inviterId}:`, e.message);
            }
        }
    }

    _winPot() {
        return this.takenCards.size * PRIZE_PER_CARD;
    }

    _takenCardsPublic() {
        const obj = {};
        for (const [cardId, info] of this.takenCards.entries()) {
            obj[cardId] = { userName: info.userName };
        }
        return obj;
    }

    async getFullState(userId) {
        let balance = 0;
        let bonusBalance = 0;
        try {
            const res = await db.query('SELECT balance, bonus_balance FROM users WHERE chat_id = $1', [userId]);
            if (res.rows.length > 0) {
                balance = parseFloat(res.rows[0].balance);
                bonusBalance = parseFloat(res.rows[0].bonus_balance || 0);
            }
        } catch (e) {
            console.error('DB Error getting full state balance', e);
        }

        return {
            phase: this.phase,
            timer: this.timer,
            totalTaken: this.takenCards.size,
            takenCards: this._takenCardsPublic(),
            calledNumbers: this.calledNumbers,
            winPot: this._winPot(),
            balance: balance,
            bonusBalance: bonusBalance,
            maintenanceMode: MAINTENANCE_MODE,
            stake: STAKE,
            myCards: this.playerCards.get(userId) || [],
            suspendedCards: [...this.suspendedCards],
            winners: this.winners,
            cards: BINGO_CARDS,
            playerCount: new Set([...this.takenCards.values()].map(v => v.userId)).size,
            myMarks: (() => {
                const marks = this.playerMarks.get(userId) || {};
                const serialized = {};
                for (const cardId in marks) {
                    serialized[cardId] = Array.from(marks[cardId]);
                }
                return serialized;
            })(),
        };
    }
    setAutoMode(userId, enabled) {
        if (!userId) return;
        const uId = String(userId);
        this.playerAutoModes.set(uId, !!enabled);
        console.log(`[GameState] Auto bingo preference updated for user ${uId}: ${!!enabled}`);
    }

    /** Set specific card IDs to be forced winners next round (one-shot) */
    setForcedWinners(cardIds) {
        this._forcedWinnerCards = Array.isArray(cardIds) ? [...cardIds] : [];
        console.log(`[GameState] Forced winners queued for next round: cards [${this._forcedWinnerCards.join(', ')}]`);
    }

    /** Get current forced winner card IDs */
    getForcedWinners() {
        return this._forcedWinnerCards || [];
    }

    _buildForcedSequence(forcedCards, cards) {
        const targetCardIds = new Set(forcedCards);
        const { countWinPatterns } = require('./winDetector');
        
        let validSequence = null;
        for (let attempt = 0; attempt < 2000; attempt++) {
            // Shuffle 1-75
            let pool = Array.from({length: 75}, (_, i) => i + 1);
            for (let i = pool.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [pool[i], pool[j]] = [pool[j], pool[i]];
            }
            
            let winnerFound = false;
            let winningCardId = null;
            const calledSim = [];
            
            for (const num of pool) {
                calledSim.push(num);
                // Check all taken cards in the simulation
                for (const [cardId, obj] of this.takenCards.entries()) {
                    const winCount = countWinPatterns(cards[cardId - 1], calledSim);
                    if (winCount >= 1) {
                        winnerFound = true;
                        winningCardId = cardId;
                        break;
                    }
                }
                if (winnerFound) break;
            }
            
            // Accept if a forced card wins and it looks somewhat natural (takes at least 15 calls)
            if (winnerFound && targetCardIds.has(winningCardId) && calledSim.length >= 15) {
                validSequence = pool;
                break;
            }
        }
        return validSequence;
    }
}

const instance = new GameState();
module.exports = instance;
module.exports.reloadSettings = loadGameSettings;

/**
 * Set the robot count (called from adminBot when admin changes setting)
 * @param {number} count
 */
module.exports.setRobotCount = function (count) {
    ROBOT_COUNT = Math.max(0, parseInt(count) || 0);
    console.log(`[Robots] Robot count updated to ${ROBOT_COUNT}`);
};

/**
 * Get current robot count
 */
module.exports.getRobotCount = function () {
    return ROBOT_COUNT;
};



// Load settings AFTER instance is exported
setTimeout(loadGameSettings, 0);
