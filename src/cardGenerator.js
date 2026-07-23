/**
 * cardGenerator.js
 * Generates 400 constant 5x5 bingo cards.
 * Each card has columns: B(1-15), I(16-30), N(31-45), G(46-60), O(61-75)
 * Center cell (row 2, col 2) is FREE.
 * Cards are deterministic — same seed gives same card each time.
 */

// Simple seeded PRNG (mulberry32)
function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffleWithRng(arr, rng) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function generateCard(cardId) {
  const rng = mulberry32(cardId * 7919); // deterministic seed per card
  const colRanges = [
    { min: 1,  max: 15 },  // B
    { min: 16, max: 30 },  // I
    { min: 31, max: 45 },  // N
    { min: 46, max: 60 },  // G
    { min: 61, max: 75 },  // O
  ];

  // Build pool for each column and pick 5 unique numbers
  const columns = colRanges.map(({ min, max }) => {
    const pool = [];
    for (let n = min; n <= max; n++) pool.push(n);
    const shuffled = shuffleWithRng(pool, rng);
    return shuffled.slice(0, 5);
  });

  // card[row][col], row 2 col 2 = FREE (null)
  const grid = [];
  for (let row = 0; row < 5; row++) {
    const r = [];
    for (let col = 0; col < 5; col++) {
      if (row === 2 && col === 2) {
        r.push(null); // FREE
      } else {
        r.push(columns[col][row]);
      }
    }
    grid.push(r);
  }

  return { id: cardId, grid };
}

// Generate all 600 cards once
const BINGO_CARDS = [];
for (let i = 1; i <= 600; i++) {
  BINGO_CARDS.push(generateCard(i));
}

module.exports = { BINGO_CARDS, generateCard };
