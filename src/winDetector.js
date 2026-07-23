/**
 * winDetector.js
 * Checks if a bingo card has a winning line given called numbers.
 * Winning patterns: any row, any column, either diagonal, or 4 corners.
 * Cross pattern is NOT a valid win.
 * The FREE cell (row 2, col 2) is always considered marked.
 */

const HEADERS = ['B', 'I', 'N', 'G', 'O'];

/**
 * Returns all flat number values on the card (null = FREE).
 * Builds a Set of which cells are "marked" based on calledNumbers + FREE.
 */
function buildMarkedSet(card, calledNumbers) {
    const called = new Set(calledNumbers);
    // Set of "cell keys" (row*5+col) that are marked
    const markedCells = new Set();
    for (let row = 0; row < 5; row++) {
        for (let col = 0; col < 5; col++) {
            const val = card.grid[row][col];
            if (val === null || called.has(val)) {
                markedCells.add(row * 5 + col);
            }
        }
    }
    return markedCells;
}

/**
 * Returns true if the card has a winning line.
 * Winning patterns: 5 rows, 5 columns, 2 diagonals, 4 corners = 13 total patterns.
 * Cross pattern is NOT included.
 */
function hasWin(card, calledNumbers) {
    const marked = buildMarkedSet(card, calledNumbers);

    // Check rows
    for (let row = 0; row < 5; row++) {
        if ([0, 1, 2, 3, 4].every(col => marked.has(row * 5 + col))) return true;
    }
    // Check cols
    for (let col = 0; col < 5; col++) {
        if ([0, 1, 2, 3, 4].every(row => marked.has(row * 5 + col))) return true;
    }
    // Check main diagonal (top-left to bottom-right)
    if ([0, 1, 2, 3, 4].every(i => marked.has(i * 5 + i))) return true;
    // Check anti-diagonal (top-right to bottom-left)
    if ([0, 1, 2, 3, 4].every(i => marked.has(i * 5 + (4 - i)))) return true;
    // Check 4 corners
    if ([0, 4, 20, 24].every(i => marked.has(i))) return true;

    return false;
}

/**
 * Returns winning line cell positions for display purposes.
 * Returns an array of arrays, where each inner array is a set of {row, col} pairs for a winning line.
 */
function getWinningLines(card, calledNumbers) {
    const marked = buildMarkedSet(card, calledNumbers);
    const lines = [];

    // rows
    for (let row = 0; row < 5; row++) {
        if ([0, 1, 2, 3, 4].every(col => marked.has(row * 5 + col))) {
            lines.push([0, 1, 2, 3, 4].map(col => ({ row, col })));
        }
    }
    // cols
    for (let col = 0; col < 5; col++) {
        if ([0, 1, 2, 3, 4].every(row => marked.has(row * 5 + col))) {
            lines.push([0, 1, 2, 3, 4].map(row => ({ row, col })));
        }
    }
    // main diagonal
    if ([0, 1, 2, 3, 4].every(i => marked.has(i * 5 + i))) {
        lines.push([0, 1, 2, 3, 4].map(i => ({ row: i, col: i })));
    }
    // anti diagonal
    if ([0, 1, 2, 3, 4].every(i => marked.has(i * 5 + (4 - i)))) {
        lines.push([0, 1, 2, 3, 4].map(i => ({ row: i, col: 4 - i })));
    }
    // 4 corners
    if ([0, 4, 20, 24].every(i => marked.has(i))) {
        lines.push([{ row: 0, col: 0 }, { row: 0, col: 4 }, { row: 4, col: 0 }, { row: 4, col: 4 }]);
    }
    // Cross pattern is NOT included

    return lines;
}

/**
 * Returns the count of unique winning patterns (rows, columns, diagonals, 4-corners).
 */
function countWinPatterns(card, calledNumbers) {
    return getWinningLines(card, calledNumbers).length;
}

module.exports = { hasWin, getWinningLines, countWinPatterns, buildMarkedSet, HEADERS };
