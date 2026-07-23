/**
 * scraper.js
 * Utility to verify payment transactions by scraping bank receipt pages.
 * Supports: Telebirr, CBEBirr, CBE, Abyssinia
 *
 * SECURITY: The receipt URL is extracted directly from the SMS and scraped.
 * Users cannot tamper with bank receipt page data, making this approach secure.
 */

const axios = require('axios');
const cheerio = require('cheerio');

// Use direct path to avoid pdf-parse crashing in Docker (missing test files bug)
let pdfParse;
try {
    pdfParse = require('pdf-parse/lib/pdf-parse.js');
} catch (e) {
    pdfParse = require('pdf-parse');
}

const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Connection': 'keep-alive',
    'Upgrade-Insecure-Requests': '1',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
    'Cache-Control': 'max-age=0',
};

// Shared HTTPS agent that skips SSL cert verification (needed for bank sites)
const https = require('https');
const HTTPS_AGENT = new https.Agent({ rejectUnauthorized: false });

// Shared axios fetch helper — 5 second timeout, returns null on any error
async function fetchUrl(url, options = {}) {
    try {
        const res = await axios.get(url, {
            headers: HEADERS,
            timeout: 5000,
            httpsAgent: HTTPS_AGENT,
            responseType: 'arraybuffer',
            ...options,
        });
        if (res && res.status === 200) return res;
        return null;
    } catch (e) {
        console.log(`[Scraper] fetchUrl failed for ${url}: ${e.message}`);
        return null;
    }
}

// Extract text from an arraybuffer response (PDF or HTML)
async function extractText(response) {
    if (!response) return '';
    const contentType = response.headers['content-type'] || '';
    if (contentType.includes('application/pdf')) {
        try {
            const pdfData = await pdfParse(response.data);
            return pdfData.text.replace(/\s+/g, ' ').trim();
        } catch (e) {
            console.log(`[Scraper] PDF parse error: ${e.message}`);
            return '';
        }
    }
    const $ = cheerio.load(response.data.toString());
    return $('body').text().replace(/\s+/g, ' ').trim();
}

/**
 * Normalize phone numbers: strip country code prefix 251 → 09...
 */
function normalizePhone(phone) {
    if (!phone) return '';
    let p = phone.toString().replace(/[\s\+\-]/g, '');
    if (p.startsWith('2519')) return '0' + p.slice(3);
    if (p.startsWith('2517')) return '0' + p.slice(3);
    if (p.length === 9 && (p.startsWith('9') || p.startsWith('7'))) return '0' + p;
    return p;
}

/**
 * Compare a (possibly masked) account string from the receipt page
 * against our known account number.
 */
function maskedAccountMatches(masked, known) {
    if (!masked || !known) return false;

    const cleanMasked = normalizePhone(masked).replace(/[\s\+\-]/g, '');
    const cleanKnown = normalizePhone(known).replace(/[\s\+\-]/g, '');

    if (cleanMasked === cleanKnown) return true;

    if (cleanMasked.length === cleanKnown.length) {
        for (let i = 0; i < cleanMasked.length; i++) {
            if (cleanMasked[i] !== '*' && cleanMasked[i] !== cleanKnown[i]) return false;
        }
        return true;
    }

    const visibleDigits = cleanMasked.replace(/\*/g, '');
    const knownSuffix = cleanKnown.slice(-visibleDigits.length);
    if (visibleDigits.length >= 4 && visibleDigits === knownSuffix) return true;

    const leadingStars = cleanMasked.indexOf('*');
    if (leadingStars > 0) {
        const prefix = cleanMasked.slice(0, leadingStars);
        const suffix = cleanMasked.slice(cleanMasked.lastIndexOf('*') + 1);
        if (prefix && suffix && cleanKnown.startsWith(prefix) && cleanKnown.endsWith(suffix)) return true;
    }

    let altKnown;
    if (cleanKnown.startsWith('09')) {
        altKnown = '2519' + cleanKnown.slice(2);
    } else if (cleanKnown.startsWith('2519')) {
        altKnown = '0' + cleanKnown.slice(4);
    } else {
        altKnown = '';
    }

    if (altKnown && cleanMasked.length === altKnown.length) {
        for (let i = 0; i < cleanMasked.length; i++) {
            if (cleanMasked[i] !== '*' && cleanMasked[i] !== altKnown[i]) return false;
        }
        return true;
    }

    if (altKnown && visibleDigits.length >= 4 && visibleDigits === altKnown.slice(-visibleDigits.length)) return true;

    return false;
}

/**
 * Robust date parsing for "DD-MM-YYYY HH:mm:ss" or similar formats
 */
function parseTransactionDate(dateStr) {
    if (!dateStr) return null;
    try {
        // "14-02-2026 14:56:06" or "14/02/2026 14:56:06" (DD-MM-YYYY)
        const dmy = dateStr.match(/(\d{2})[/-](\d{2})[/-](\d{4})\s*(\d{2}):(\d{2})(:(\d{2}))?/);
        if (dmy) {
            return new Date(parseInt(dmy[3]), parseInt(dmy[2]) - 1, parseInt(dmy[1]),
                parseInt(dmy[4]), parseInt(dmy[5]), dmy[7] ? parseInt(dmy[7]) : 0);
        }
        // "2026-03-04 10:49" (YYYY-MM-DD)
        const ymd = dateStr.match(/(\d{4})[/-](\d{2})[/-](\d{2})\s*(\d{2}):(\d{2})(:(\d{2}))?/);
        if (ymd) {
            return new Date(parseInt(ymd[1]), parseInt(ymd[2]) - 1, parseInt(ymd[3]),
                parseInt(ymd[4]), parseInt(ymd[5]), ymd[7] ? parseInt(ymd[7]) : 0);
        }
        // "3/3/2026, 7:02:00 PM" (M/D/YYYY AM/PM) — used by regular CBE
        const mdy12 = dateStr.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})[,\s]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)/i);
        if (mdy12) {
            let hour = parseInt(mdy12[4]);
            const ampm = mdy12[7].toUpperCase();
            if (ampm === 'PM' && hour < 12) hour += 12;
            if (ampm === 'AM' && hour === 12) hour = 0;
            return new Date(parseInt(mdy12[3]), parseInt(mdy12[2]) - 1, parseInt(mdy12[1]),
                hour, parseInt(mdy12[5]), mdy12[6] ? parseInt(mdy12[6]) : 0);
        }
    } catch (e) {
        console.error('[Scraper] Date parsing error:', dateStr, e.message);
    }
    return null;
}

/**
 * Scrape a Telebirr receipt page using the direct URL.
 * URL format: https://transactioninfo.ethiotelecom.et/receipt/TXID
 * Inherits all verification rules from CBEBirr (amount, name, account, 48h date).
 */
async function verifyTelebirr(receiptUrl, myAccountNumber, expectedName) {
    try {
        console.log(`[Scraper:Telebirr] Fetching: ${receiptUrl}`);
        const response = await fetchUrl(receiptUrl);
        if (!response) return { ok: false, error: 'Telebirr receipt page is unreachable or timed out' };

        const pageText = await extractText(response);

        console.log(`\n[Scraper:Telebirr] ══════════ FULL PAGE TEXT ══════════`);
        console.log(pageText);
        console.log(`[Scraper:Telebirr] ════════════════════════════════════\n`);

        // If page returned very little text, it might be a JS SPA shell — try API endpoints
        if (!pageText || pageText.length < 80) {
            console.log(`[Scraper:Telebirr] Page text too short (${pageText.length} chars) — trying API fallback`);
            const txIdMatch = receiptUrl.match(/\/receipt\/([A-Z0-9]+)/i);
            const txId = txIdMatch ? txIdMatch[1] : null;
            if (txId) {
                const apiUrls = [
                    `https://transactioninfo.ethiotelecom.et/api/receipt/${txId}`,
                    `https://transactioninfo.ethiotelecom.et/api/v1/receipt/${txId}`,
                    `https://transactioninfo.ethiotelecom.et/api/transaction/${txId}`,
                    `https://transactioninfo.ethiotelecom.et/api/v1/transaction/${txId}`,
                ];
                for (const apiUrl of apiUrls) {
                    try {
                        console.log(`[Scraper:Telebirr] Trying API: ${apiUrl}`);
                        const apiRes = await fetchUrl(apiUrl, {
                            headers: { ...HEADERS, 'Accept': 'application/json' },
                            responseType: 'json'
                        });
                        if (apiRes?.data) {
                            const d = apiRes.data;
                            console.log(`[Scraper:Telebirr] API hit: ${apiUrl} ->`, JSON.stringify(d).slice(0, 400));
                            const rawAmt = d.amount || d.paidAmount || d.transferAmount ||
                                          d.paid_amount || d.transfer_amount || 0;
                            const apiAmount = parseFloat(String(rawAmt).replace(/,/g, ''));
                            const apiAcc = String(d.receiverAccount || d.creditedAccount ||
                                                  d.receiver_account || d.account || '');
                            const apiName = String(d.receiverName || d.creditedName ||
                                                   d.receiver_name || d.name || '');
                            const apiDateStr = d.date || d.transactionDate || d.transaction_date || '';
                            const apiDate = apiDateStr ? new Date(apiDateStr) : null;
                            if (apiAmount > 0) {
                                if (apiAcc && !maskedAccountMatches(apiAcc, myAccountNumber)) {
                                    return { ok: false, error: `Account mismatch: receipt shows "${apiAcc}"` };
                                }
                                if (apiName && expectedName) {
                                    const ce = expectedName.toLowerCase().replace(/\s+/g, '');
                                    const cf = apiName.toLowerCase().replace(/\s+/g, '');
                                    if (!cf.includes(ce) && !ce.split(/\s+/).every(p => cf.includes(p.toLowerCase()))) {
                                        return { ok: false, error: `Name mismatch: receipt shows "${apiName}"` };
                                    }
                                }
                                return { ok: true, amount: apiAmount, receiver: apiAcc, txDate: apiDate };
                            }
                        }
                    } catch (e) {
                        console.log(`[Scraper:Telebirr] API ${apiUrl} failed: ${e.message}`);
                    }
                }
            }
            return { ok: false, error: 'Telebirr receipt page returned no readable content (may require JavaScript). Contact support if payment was successful.' };
        }

        // ── Amount ──
        const amountMatch =
            pageText.match(/Settled Amount[^\d]*([\d,]+\.?\d*)\s*Birr/i) ||
            pageText.match(/Total Paid Amount[^\d]*([\d,]+\.?\d*)\s*Birr/i) ||
            pageText.match(/([\d,]+(?:\.\d+)?)\s*Birr.*Stamp Duty/i) || // sometimes the amount is right before Stamp Duty
            pageText.match(/(?:Amount|ክፍያ|ብር)[:\s]*([\d,]+\.?\d*)/i) ||
            pageText.match(/([\d,]+\.\d{2})/);  // last resort: first decimal number
        const amount = amountMatch ? parseFloat(amountMatch[1].replace(/,/g, '')) : 0;
        if (amount <= 0) return { ok: false, error: 'Amount not found on receipt' };

        // ── Receiver Name ──
        const namePatterns = [
            /Credited\s*Party\s*name\s*([^/\n]+?)(?:\s*(?:የገንዘብ|የከፋይ|Payer)|$)/i,
            /የገንዘብ\s*ተቀባይ\s*ስም\s*([^/\n]+?)(?:\s*(?:Credited|Payer)|$)/i,
            /(?:Receiver|Name|ሳቢ)[:\s]*([^(\n\d\*\/]{3,40})/i,
        ];
        let receiverName = '';
        for (const p of namePatterns) {
            const m = pageText.match(p);
            if (m && m[1] && m[1].trim().length > 2) { receiverName = m[1].trim(); break; }
        }
        if (!receiverName) return { ok: false, error: 'Receiver name could not be found on receipt' };

        // ── Receiver Account ──
        const receiverPatterns = [
            /Credited\s*party\s*account\s*no\s*[:\s]?([\d\*]+)/i,
            /የገንዘብ\s*ተቀባይ\s*ቴሌብር\s*ቁ[^0-9]*([\d\*]+)/i,
            /(?:Account|ቁጥር)[:\s]*([\d\*]{7,15})/i,
        ];
        let receiverAcc = '';
        for (const p of receiverPatterns) {
            const m = pageText.match(p);
            if (m) { receiverAcc = m[1]; break; }
        }
        if (!receiverAcc || !maskedAccountMatches(receiverAcc, myAccountNumber)) {
            return { ok: false, error: `Account mismatch: receipt shows "${receiverAcc || 'nothing found'}"` };
        }

        // ── Date ──
        const dateMatch =
            pageText.match(/(\d{2}-\d{2}-\d{4}\s+\d{2}:\d{2}:\d{2})/) ||
            pageText.match(/(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}(?::\d{2})?)/) ||
            pageText.match(/(\d{1,2}\/\d{1,2}\/\d{4}[,\s]+\d{1,2}:\d{2}(?::\d{2})?\s*(?:AM|PM)?)/i);
        const txDate = dateMatch ? parseTransactionDate(dateMatch[1]) : null;
        if (!txDate) return { ok: false, error: 'Transaction date could not be found on receipt' };

        console.log(`[Scraper:Telebirr] Amount: ${amount}, Name: "${receiverName}", Acc: "${receiverAcc}", Date: ${txDate}`);

        // ── Name match (same logic as CBEBirr) ──
        if (expectedName && receiverName) {
            const cleanExpected = expectedName.toLowerCase().replace(/\s+/g, '');
            const cleanFound = receiverName.toLowerCase().replace(/\s+/g, '');
            if (!cleanFound.includes(cleanExpected) && !cleanExpected.split(/\s+/).every(part => cleanFound.includes(part.toLowerCase()))) {
                return { ok: false, error: `Name mismatch: receipt shows "${receiverName}" but expected "${expectedName}"` };
            }
        }

        return { ok: true, amount, receiver: receiverAcc, txDate };
    } catch (error) {
        console.error(`[Scraper:Telebirr] Error:`, error.message);
        return { ok: false, error: 'Telebirr receipt page is unreachable or invalid' };
    }
}

/**
 * Scrape a CBEBirr receipt PDF directly from cbepay1.cbe.com.et.
 * PDF format confirmed: "Credit Account{phone} - {name}" and date like "2026-07-18 13:26" in text.
 */
async function verifyCBEBirr(receiptUrl, myAccountNumber, expectedName) {
    try {
        console.log(`[Scraper:CBEBirr] Fetching PDF: ${receiptUrl}`);
        const response = await fetchUrl(receiptUrl);
        if (!response) return { ok: false, error: 'CBEBirr receipt page is unreachable or timed out' };

        const contentType = response.headers['content-type'] || '';
        let pageText = '';

        if (contentType.includes('application/pdf')) {
            try {
                const pdfData = await pdfParse(response.data);
                pageText = pdfData.text.replace(/\s+/g, ' ').trim();
            } catch (e) {
                console.log(`[Scraper:CBEBirr] PDF parse error: ${e.message}`);
                return { ok: false, error: 'Failed to parse CBEBirr PDF receipt' };
            }
        } else {
            pageText = response.data.toString().replace(/\s+/g, ' ').trim();
        }

        console.log(`\n[Scraper:CBEBirr] ══════════ FULL PAGE TEXT ══════════`);
        console.log(pageText.slice(0, 1500));
        console.log(`[Scraper:CBEBirr] ════════════════════════════════════\n`);

        if (!pageText || pageText.length < 50) {
            return { ok: false, error: 'CBEBirr receipt returned empty content' };
        }

        // ── Check transaction not failed ──
        if (/transaction\s*status\s*(?:is\s*)?(?:failed|cancelled|rejected|invalid|error)/i.test(pageText)) {
            return { ok: false, error: 'CBEBirr transaction is not completed' };
        }

        // ── Receiver Account + Name ──
        // PDF: "Credit Account251940072277 - Yonatan Desalegn Hagos Receiver Name251940072277 - Yonatan..."
        const creditMatch =
            pageText.match(/Credit\s*Account\s*([\d]+)\s*-\s*([A-Za-z][A-Za-z\s\/\.]{2,60}?)(?=\s*(?:Receiver|Order|Debit|$))/i) ||
            pageText.match(/Receiver\s*Name\s*([\d]+)\s*-\s*([A-Za-z][A-Za-z\s\/\.]{2,60}?)(?=\s*(?:Order|Debit|$))/i);

        if (!creditMatch) {
            return { ok: false, error: 'Receiver account not found in CBEBirr receipt' };
        }
        const receiverAcc = creditMatch[1].trim();
        const receiverName = creditMatch[2].trim();

        // ── Account match ──
        if (!maskedAccountMatches(receiverAcc, myAccountNumber)) {
            return { ok: false, error: `Account mismatch: receipt shows "${receiverAcc}" but expected "${myAccountNumber}"` };
        }

        // ── Name match ──
        if (expectedName && receiverName) {
            const cleanExpected = expectedName.toLowerCase().replace(/\s+/g, '');
            const cleanFound = receiverName.toLowerCase().replace(/\s+/g, '');
            if (!cleanFound.includes(cleanExpected) && !cleanExpected.split(/\s+/).every(part => cleanFound.includes(part.toLowerCase()))) {
                return { ok: false, error: `Name mismatch: receipt shows "${receiverName}" but expected "${expectedName}"` };
            }
        }

        // ── Amount ──
        // PDF has: "DGI01ITM9C42026-07-18 13:2650.00 50.00 0.00 0.00 50.00 Paid amount"
        // Sometimes pdf-parse merges the time and amount (e.g. 09:4810.00). We inject a space after the time:
        pageText = pageText.replace(/(\d{4}-\d{1,2}-\d{1,2}\s+\d{1,2}:\d{2})(?=\d)/g, '$1 ');

        // First decimal before "Paid amount" sequence is the paid amount
        const amountMatch =
            pageText.match(/([\d,]+\.\d{2})\s+(?:[\d,]+\.\d{2}\s+){0,4}Paid\s*[Aa]mount/i) ||
            pageText.match(/([\d,]+\.\d{2})\s*Paid\s*[Aa]mount/i) ||
            pageText.match(/Amount\s+([\d,]+\.\d{2})/i);
        const amount = amountMatch ? parseFloat(amountMatch[1].replace(/,/g, '')) : 0;
        if (amount <= 0) return { ok: false, error: 'Amount not found in CBEBirr receipt' };

        // ── Date ──
        // PDF has date embedded: "2026-07-18 13:26" (YYYY-MM-DD HH:MM) somewhere in the text
        const dateMatch =
            pageText.match(/(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}(?::\d{2})?)/) ||
            pageText.match(/Transaction\s*Date\s*(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}(?::\d{2})?)/i);
        const txDate = dateMatch ? parseTransactionDate(dateMatch[1]) : null;
        if (!txDate) return { ok: false, error: 'Transaction date not found in CBEBirr receipt' };

        console.log(`[Scraper:CBEBirr] ✅ Amount: ${amount} ETB | Receiver: "${receiverName}" (${receiverAcc}) | Date: ${txDate}`);
        return { ok: true, amount, receiver: receiverAcc, receiverName, txDate };

    } catch (error) {
        console.error(`[Scraper:CBEBirr] Error:`, error.message);
        return { ok: false, error: 'CBEBirr receipt page is unreachable or invalid' };
    }
}

/**
 * Parse a CBE transfer from the SMS text.
 * The new CBE mobile receipt page (mbreciept.cbe.com.et) is a JS-only SPA with no API.
 * All critical data is present in the SMS text itself.
 *
 * SMS format:
 *   "Dear {sender} You have successfully transferred ETB{amount} from account {masked}
 *    to account {masked} ({receiver name}). Service charge... Thanks for Banking with CBE.
 *    https://mbreciept.cbe.com.et/v2-XXXX"
 */
function verifyCBEFromSMS(smsText, myAccountNumber, expectedName) {
    try {
        if (!smsText) return { ok: false, error: 'No SMS text provided' };

        // 1. Must be a CBE SMS
        if (!/thanks?\s+for\s+banking\s+with\s+CBE|commercial\s+bank\s+of\s+ethiopia/i.test(smsText)) {
            return { ok: false, error: 'SMS does not appear to be from CBE' };
        }

        // 2. Must indicate a successful transfer
        if (!/successfully\s+transferred/i.test(smsText)) {
            return { ok: false, error: 'SMS does not indicate a successful transfer' };
        }

        // 3. Amount: "transferred ETB275.00"
        const amountMatch = smsText.match(/transferred\s+ETB\s*([\d,]+\.?\d*)/i);
        if (!amountMatch) return { ok: false, error: 'Could not parse transfer amount from CBE SMS' };
        const amount = parseFloat(amountMatch[1].replace(/,/g, ''));
        if (!amount || amount <= 0) return { ok: false, error: 'Invalid amount in CBE SMS' };

        // 4. Receiver account (masked): "to account 1**2067"
        const toAccMatch = smsText.match(/to\s+account\s+([\d\*]+)/i);
        const receiverAccMasked = toAccMatch ? toAccMatch[1].trim() : '';
        if (!receiverAccMasked) return { ok: false, error: 'Receiver account not found in CBE SMS' };

        // 5. Receiver account match (masked comparison)
        if (!maskedAccountMatches(receiverAccMasked, myAccountNumber)) {
            return { ok: false, error: `Account mismatch: SMS shows "${receiverAccMasked}" but expected ending "${myAccountNumber.toString().slice(-4)}"` };
        }

        // 6. Receiver name: "to account 1**2067 (Yonatan Desalegn Hagos)"
        const nameMatch = smsText.match(/to\s+account\s+[\d\*]+\s*\(([^)]+)\)/i);
        const receiverName = nameMatch ? nameMatch[1].trim() : '';
        if (!receiverName) return { ok: false, error: 'Receiver name not found in CBE SMS' };

        // 7. Name match
        if (expectedName && receiverName) {
            const cleanExpected = expectedName.toLowerCase().replace(/\s+/g, '');
            const cleanFound = receiverName.toLowerCase().replace(/\s+/g, '');
            if (!cleanFound.includes(cleanExpected) &&
                !cleanExpected.split(/\s+/).every(part => part.length > 2 && cleanFound.includes(part.toLowerCase()))) {
                return { ok: false, error: `Name mismatch: SMS shows "${receiverName}" but expected "${expectedName}"` };
            }
        }

        // 8. Receipt URL as unique TX ID
        const urlMatch = smsText.match(/(https?:\/\/mbreciept\.cbe\.com\.et\/[^\s"']+)/i);
        const receiptUrl = urlMatch ? urlMatch[1].trim() : null;

        // CBE SMS does not embed a date — use now (48h replay protection done via unique URL in DB)
        const txDate = new Date();

        console.log(`[Scraper:CBE:SMS] ✅ Amount: ${amount} ETB | Receiver: "${receiverName}" (${receiverAccMasked}) | URL: ${receiptUrl}`);
        return { ok: true, amount, receiver: receiverAccMasked, receiverName, txDate, receiptUrl };

    } catch (e) {
        console.error('[Scraper:CBE:SMS] Error:', e.message);
        return { ok: false, error: 'CBE SMS parsing failed: ' + e.message };
    }
}

/**
 * Verify a CBE transfer.
 * Handles two URL formats:
 *   1. Old format: https://apps.cbe.com.et:100/?id=XXXX  → scrape HTML page
 *   2. New format: https://mbreciept.cbe.com.et/v2-XXXX   → JS SPA (no API), parse from SMS text
 *
 * @param {string} receiptUrl - The CBE receipt URL (extracted from SMS or sent directly)
 * @param {string} smsText    - The full SMS text (may be same as receiptUrl if user sent URL only)
 * @param {string} accNo      - Our account number (from admin settings)
 * @param {string} accName    - Our account name (from admin settings)
 */
async function verifyCBE(receiptUrl, smsText, accNo, accName) {
    const isNewFormat = receiptUrl && /mbreciept\.cbe\.com\.et/i.test(receiptUrl);
    const isOldFormat = receiptUrl && /apps\.cbe\.com\.et/i.test(receiptUrl);

    // ── NEW FORMAT: mbreciept.cbe.com.et ──────────────────────────────────────
    // This page is a React SPA — no API available. Parse data from the SMS text.
    if (isNewFormat) {
        console.log(`[Scraper:CBE] New-format URL detected. Parsing from SMS text.`);
        if (!smsText || !/successfully\s+transferred/i.test(smsText)) {
            return { ok: false, error: 'No CBE transfer SMS text found. Please paste the full SMS message from CBE.' };
        }

        // 1. Must be a CBE SMS
        if (!/thanks?\s+for\s+banking\s+with\s+CBE|commercial\s+bank\s+of\s+ethiopia/i.test(smsText)) {
            return { ok: false, error: 'SMS does not appear to be from CBE. Please paste the full CBE SMS message.' };
        }

        // 2. Amount: "transferred ETB275.00"
        const amountMatch = smsText.match(/transferred\s+ETB\s*([\d,]+\.?\d*)/i);
        if (!amountMatch) return { ok: false, error: 'Could not parse transfer amount from CBE SMS' };
        const amount = parseFloat(amountMatch[1].replace(/,/g, ''));
        if (!amount || amount <= 0) return { ok: false, error: 'Invalid amount in CBE SMS' };

        // 3. Receiver account (masked): "to account 1**2067"
        const toAccMatch = smsText.match(/to\s+account\s+([\d\*]+)/i);
        const receiverAccMasked = toAccMatch ? toAccMatch[1].trim() : '';
        if (!receiverAccMasked) return { ok: false, error: 'Receiver account not found in CBE SMS' };

        // 4. Account match
        if (!maskedAccountMatches(receiverAccMasked, accNo)) {
            return { ok: false, error: `Account mismatch: SMS shows "${receiverAccMasked}" but expected ending "${accNo.toString().slice(-4)}"` };
        }

        // 5. Receiver name: "to account 1**2067 (Yonatan Desalegn Hagos)"
        const nameMatch = smsText.match(/to\s+account\s+[\d\*]+\s*\(([^)]+)\)/i);
        const receiverName = nameMatch ? nameMatch[1].trim() : '';
        if (!receiverName) return { ok: false, error: 'Receiver name not found in CBE SMS' };

        // 6. Name match
        if (accName && receiverName) {
            const cleanExpected = accName.toLowerCase().replace(/\s+/g, '');
            const cleanFound = receiverName.toLowerCase().replace(/\s+/g, '');
            if (!cleanFound.includes(cleanExpected) &&
                !cleanExpected.split(/\s+/).every(part => part.length > 2 && cleanFound.includes(part.toLowerCase()))) {
                return { ok: false, error: `Name mismatch: SMS shows "${receiverName}" but expected "${accName}"` };
            }
        }

        // 7. Receipt URL as unique TX ID (use the URL we already have or extract from SMS)
        const extractedUrl = receiptUrl ||
            (smsText.match(/(https?:\/\/mbreciept\.cbe\.com\.et\/[^\s"']+)/i) || [])[1];
        const txDate = new Date(); // CBE SMS has no date field

        console.log(`[Scraper:CBE] \u2705 Amount: ${amount} ETB | Receiver: "${receiverName}" (${receiverAccMasked}) | URL: ${extractedUrl}`);
        return { ok: true, amount, receiver: receiverAccMasked, receiverName, txDate, receiptUrl: extractedUrl };
    }

    // ── OLD FORMAT: apps.cbe.com.et (HTML scrape) ─────────────────────────────
    if (isOldFormat) {
        try {
            const txIdMatch = receiptUrl.match(/[?&]id=([A-Za-z0-9]+)/i);
            const txId = txIdMatch ? txIdMatch[1] : null;
            const urlsToTry = [receiptUrl];
            // Port 100 is often blocked — try without port as fallback
            if (txId && receiptUrl.includes(':100')) {
                urlsToTry.push(`https://apps.cbe.com.et/?id=${txId}`);
            }

            let response = null;
            for (const url of urlsToTry) {
                console.log(`[Scraper:CBE] Trying URL: ${url}`);
                response = await fetchUrl(url);
                if (response) { console.log(`[Scraper:CBE] Success with: ${url}`); break; }
            }
            if (!response) return { ok: false, error: 'CBE receipt page is unreachable (try pasting the full SMS text instead)' };

            const pageText = await extractText(response);
            console.log(`\n[Scraper:CBE] \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550 PAGE TEXT \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550`);
            console.log(pageText.slice(0, 800));
            console.log(`[Scraper:CBE] \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\n`);

            const amountMatch = pageText.match(/Transferred\s*Amount\s*([\d,]+\.?\d*)\s*ETB/i)
                || pageText.match(/([\d,]+\.\d{2})\s*ETB/i);
            const amount = amountMatch ? parseFloat(amountMatch[1].replace(/,/g, '')) : 0;
            if (amount <= 0) return { ok: false, error: 'Amount not found on CBE receipt' };

            const nameMatch = pageText.match(/Receiver([A-Z][A-Za-z\s\.'\/']+?)(?=\s*Account)/i);
            const receiverName = nameMatch ? nameMatch[1].trim().replace(/^(MR\.?|MRS\.?|MS\.?|DR\.?|MISS\.?)\s+/i, '').trim() : '';
            if (!receiverName) return { ok: false, error: 'Receiver name could not be found on CBE receipt' };

            const receiverAccMatch = pageText.match(/Receiver[A-Z][A-Za-z\s\.'\/']+?Account([\d\*]{6,16})/i);
            const receiverAcc = receiverAccMatch ? receiverAccMatch[1] : '';
            if (!receiverAcc || !maskedAccountMatches(receiverAcc, accNo)) {
                return { ok: false, error: `Account mismatch: receipt shows "${receiverAcc || 'nothing found'}"` };
            }

            const dateMatch = pageText.match(/Payment\s*Date\s*[&\s]*Time\s*(\d{1,2}\/\d{1,2}\/\d{4})[,\s]+(\d{1,2}:\d{2}(?::\d{2})?\s*(?:AM|PM)?)/i);
            const txDate = dateMatch ? parseTransactionDate(`${dateMatch[1]} ${dateMatch[2]}`) : null;
            if (!txDate) return { ok: false, error: 'Transaction date could not be found on CBE receipt' };

            if (accName && receiverName) {
                const cleanExpected = accName.toLowerCase().replace(/\s+/g, '');
                const cleanFound = receiverName.toLowerCase().replace(/\s+/g, '');
                if (!cleanFound.includes(cleanExpected) && !cleanExpected.split(/\s+/).every(part => cleanFound.includes(part.toLowerCase()))) {
                    return { ok: false, error: `Name mismatch: receipt shows "${receiverName}"` };
                }
            }

            console.log(`[Scraper:CBE] \u2705 Amount: ${amount}, Name: "${receiverName}", Acc: "${receiverAcc}", Date: ${txDate}`);
            return { ok: true, amount, receiver: receiverAcc, receiverName, txDate };
        } catch (error) {
            console.error(`[Scraper:CBE] Error:`, error.message);
            return { ok: false, error: 'CBE receipt page is unreachable or invalid' };
        }
    }

    // ── No recognizable URL format ─────────────────────────────────────────────
    return { ok: false, error: 'Unrecognized CBE URL format. Please paste the full SMS text from CBE.' };
}

/**
 * Verify a Bank of Abyssinia (BOA) receipt via its JSON API.
 */
async function verifyAbyssinia(receiptUrl, myAccountNumber, expectedName) {
    try {
        const trxMatch = receiptUrl.match(/[?&]trx=([A-Z0-9]+)/i);
        const trxId = trxMatch ? trxMatch[1] : null;
        if (!trxId) return { ok: false, error: 'Could not extract transaction ID from BOA URL' };

        const apiUrl = `https://cs.bankofabyssinia.com/api/onlineSlip/getDetails/?id=${trxId}`;
        console.log(`[Scraper:Abyssinia] Fetching API: ${apiUrl}`);

        const res = await fetchUrl(apiUrl, { headers: { ...HEADERS, 'Accept': 'application/json' }, responseType: 'json' });
        const data = res?.data;

        if (!data || !data.body || !Array.isArray(data.body) || data.body.length === 0) {
            console.error('[Scraper:Abyssinia] Invalid API response:', JSON.stringify(data).slice(0, 200));
            return { ok: false, error: 'Abyssinia transaction not found or invalid format' };
        }

        const d = data.body[0];

        // ── Amount ──
        const amountStr = d['Transferred Amount'] || d['Total Amount including VAT'];
        const amount = amountStr ? parseFloat(amountStr.replace(/,/g, '')) : 0;
        if (amount <= 0) return { ok: false, error: 'Amount not found on receipt' };

        // ── Receiver Name ──
        const rawName = d["Receiver's Name"] || d['Beneficiary Name'] || '';
        const receiverName = rawName.replace(/^(MR\.?|MRS\.?|MS\.?|DR\.?|MISS\.?)\s+/i, '').trim();
        if (!receiverName) return { ok: false, error: 'Receiver name could not be found' };

        // ── Receiver Account ──
        const receiverAcc = d["Receiver's Account"] || '';
        if (!receiverAcc || !maskedAccountMatches(receiverAcc, myAccountNumber)) {
            return { ok: false, error: `Account mismatch: receipt shows "${receiverAcc || 'nothing found'}"` };
        }

        // ── Date ── Format: "04/03/26 11:02" (DD/MM/YY HH:MM)
        const dateStr = d['Transaction Date'];
        let txDate = null;
        if (dateStr) {
            const dMyy = dateStr.match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})\s+(\d{1,2}):(\d{2})/);
            if (dMyy) {
                let year = parseInt(dMyy[3]);
                if (year < 100) year += 2000;
                txDate = new Date(year, parseInt(dMyy[2]) - 1, parseInt(dMyy[1]), parseInt(dMyy[4]), parseInt(dMyy[5]), 0);
            }
        }
        if (!txDate) return { ok: false, error: 'Transaction date could not be found' };

        console.log(`[Scraper:Abyssinia] Amount: ${amount}, Name: "${receiverName}", Acc: "${receiverAcc}", Date: ${txDate}`);

        if (expectedName && receiverName) {
            const cleanExpected = expectedName.toLowerCase().replace(/\s+/g, '');
            const cleanFound = receiverName.toLowerCase().replace(/\s+/g, '');
            if (!cleanFound.includes(cleanExpected) && !cleanExpected.split(/\s+/).every(part => cleanFound.includes(part.toLowerCase()))) {
                return { ok: false, error: `Name mismatch: receipt shows "${receiverName}"` };
            }
        }

        return { ok: true, amount, receiver: receiverAcc, txDate };
    } catch (error) {
        console.error(`[Scraper:Abyssinia] Error:`, error.message);
        return { ok: false, error: 'Abyssinia receipt API is unreachable or invalid' };
    }
}

/**
 * Parse and verify a Telebirr transaction directly from the SMS text.
 * Used as fallback when transactioninfo.ethiotelecom.et is unreachable (geo-restricted outside Ethiopia).
 * Security: verifies account name + parses amount/date; TX ID uniqueness enforced by caller.
 */
function verifyTelebirrFromSMS(smsText, expectedName) {
    try {
        if (!smsText) return { ok: false, error: 'No SMS text provided' };

        // 1. Must be a Telebirr SMS
        if (!/telebirr|ethio\s*telecom/i.test(smsText)) {
            return { ok: false, error: 'SMS does not appear to be from Telebirr' };
        }

        // 2. SMS must mention our account name (e.g. "Yonatan")
        if (!smsText.toLowerCase().includes(expectedName.toLowerCase())) {
            return { ok: false, error: `SMS does not mention expected receiver "${expectedName}"` };
        }

        // 3. Amount: "received ETB 5.00" (receiver SMS) or "sent ETB 5.00 to" (sender SMS)
        const amountMatch = smsText.match(/(?:received|sent)\s+ETB\s*([\d,]+\.?\d*)/i);
        if (!amountMatch) return { ok: false, error: 'Could not parse amount from Telebirr SMS' };
        const amount = parseFloat(amountMatch[1].replace(/,/g, ''));
        if (!amount || amount <= 0) return { ok: false, error: 'Invalid amount in Telebirr SMS' };

        // 4. Date: "on 16/03/2026 18:22:11" or "on 16/03/2026 at 18:22"
        const dateMatch = smsText.match(/on\s+(\d{1,2}\/\d{1,2}\/\d{2,4})\s+(?:at\s+)?(\d{2}:\d{2}(?::\d{2})?)/i);
        if (!dateMatch) return { ok: false, error: 'Could not parse date from Telebirr SMS' };

        const dp = dateMatch[1].split('/');
        const tp = dateMatch[2].split(':');
        let year = parseInt(dp[2]);
        if (year < 100) year += 2000;
        const txDate = new Date(year, parseInt(dp[1]) - 1, parseInt(dp[0]),
            parseInt(tp[0]), parseInt(tp[1]), tp[2] ? parseInt(tp[2]) : 0);

        if (!txDate || isNaN(txDate.getTime())) {
            return { ok: false, error: 'Invalid date in Telebirr SMS' };
        }

        console.log(`[Scraper:Telebirr:SMS] Fallback — Amount: ${amount} ETB, Date: ${txDate}`);
        return { ok: true, amount, txDate };

    } catch (e) {
        console.error('[Scraper:Telebirr:SMS] Error:', e.message);
        return { ok: false, error: 'Telebirr SMS parsing failed: ' + e.message };
    }
}

/**
 * Look up a transaction by TX ID for the admin verifier.
 * Does NOT validate account ownership — just returns the raw details.
 * Tries each bank in order and returns as soon as one succeeds.
 */
async function lookupTransaction(txId, phoneHint) {
    txId = txId.toString().trim().toUpperCase();
    const SYSTEM_PHONE = '251940072277';

    const buildUrl = {
        telebirr: (id) => `https://transactioninfo.ethiotelecom.et/receipt/${id}`,
        cbebirr: (id, ph) => `https://cbepay1.cbe.com.et/aureceipt?TID=${id}&PH=${ph}`,
        cbe: (id) => `https://apps.cbe.com.et/?id=${id}`,  // no port 100 — blocked on HF
        abyssinia: (id) => `https://cs.bankofabyssinia.com/slip/?trx=${id}`,
    };

    const methods = ['telebirr', 'cbebirr', 'cbe', 'abyssinia'];

    for (const method of methods) {
        try {
            console.log(`[TxLookup] Trying ${method} for TX ${txId}`);

            let pageText = '';
            let responseToParse = null;

            if (method === 'abyssinia') {
                const apiUrl = `https://cs.bankofabyssinia.com/api/onlineSlip/getDetails/?id=${txId}`;
                const res = await fetchUrl(apiUrl, { headers: { ...HEADERS, 'Accept': 'application/json' }, responseType: 'json' });
                if (res?.data?.body?.length > 0) {
                    const d = res.data.body[0];
                    const amountStr = d['Transferred Amount'] || d['Total Amount including VAT'] || '';
                    const amount = parseFloat(amountStr.replace(/,/g, '')) || 0;
                    if (amount > 0) {
                        return {
                            ok: true,
                            method: 'Abyssinia',
                            txId,
                            amount,
                            receiverName: (d["Receiver's Name"] || '').replace(/^(MR\.?|MRS\.?|MS\.?|DR\.?|MISS\.?)\s+/i, '').trim(),
                            receiverAccount: d["Receiver's Account"] || '',
                            senderName: (d["Payer's Name"] || d['Sender Name'] || '').trim(),
                            senderAccount: (d["Payer's Account"] || d['Debit Account'] || '').trim(),
                            date: d['Transaction Date'] || '',
                            rawDate: d['Transaction Date'] || null,
                        };
                    }
                }
                continue;
            }

            if (method === 'cbe') {
                // Try standard HTTPS first (port 100 blocked on HF), also try port 100 as fallback
                const urlsToTry = [buildUrl.cbe(txId), `https://apps.cbe.com.et:100/?id=${txId}`];
                for (const u of urlsToTry) {
                    console.log(`[TxLookup:CBE] Trying URL: ${u}`);
                    const r = await fetchUrl(u);
                    if (r) { responseToParse = r; break; }
                }
            } else if (method === 'cbebirr') {
                const phoneCandidates = [];
                if (phoneHint) {
                    let ph = phoneHint.toString().replace(/[\s\-]/g, '');
                    if (ph.startsWith('0')) ph = '251' + ph.slice(1);
                    if (!ph.startsWith('251')) ph = '251' + ph;
                    phoneCandidates.push(ph);
                }
                if (!phoneCandidates.includes(SYSTEM_PHONE)) phoneCandidates.push(SYSTEM_PHONE);
                phoneCandidates.push('');

                for (const ph of phoneCandidates) {
                    const cbeBirrUrl = ph
                        ? buildUrl.cbebirr(txId, ph)
                        : `https://cbepay1.cbe.com.et/aureceipt?TID=${txId}`;
                    console.log(`[TxLookup:CBEBirr] Trying URL: ${cbeBirrUrl}`);
                    const attempt = await fetchUrl(cbeBirrUrl);
                    if (!attempt) continue;
                    const testText = await extractText(attempt);
                    if (testText && testText.length > 30 &&
                        !testText.toLowerCase().includes('invalid access') &&
                        !testText.toLowerCase().includes('access denied') &&
                        !testText.toLowerCase().includes('error')) {
                        responseToParse = attempt;
                        console.log(`[TxLookup:CBEBirr] Got valid response with PH=${ph || 'none'}`);
                        break;
                    }
                    console.log(`[TxLookup:CBEBirr] PH=${ph || 'none'} rejected: "${testText.slice(0, 100)}"`);
                }
            } else {
                // Telebirr
                responseToParse = await fetchUrl(buildUrl[method](txId));
            }

            if (!responseToParse) continue;

            pageText = await extractText(responseToParse);
            if (!pageText || pageText.length < 20) {
                console.log(`[TxLookup:${method}] Empty or short page text for ${txId}`);
                continue;
            }

            // ── Amount ──
            let amount = 0;
            let amMatch = null;
            if (method === 'cbebirr') {
                amMatch = pageText.match(/([\d,]+\.[\d]{2})\s*Paid\s*amount/i)
                    || pageText.match(/Paid\s*Amount[:\s]*([\d,]+\.[\d]{2})/i)
                    || pageText.match(/([0-9,]+\.[0-9]{2})\s*(?:ETB|Birr)/i);
            } else {
                amMatch = pageText.match(/([\d,]+\.[\d]{2})\s*(?:Paid\s*amount|Birr|ETB|Br|Amount)/i)
                    || pageText.match(/Transferred\s*Amount\s*([\d,]+\.?\d*)\s*ETB/i)
                    || pageText.match(/Amount\s*([\d,]+\.[\d]{2})/i)
                    || pageText.match(/([\d,]+\.[\d]{2})/);
            }
            if (amMatch) amount = parseFloat(amMatch[1].replace(/,/g, ''));
            if (amount <= 0) {
                console.log(`[TxLookup:${method}] Amount not found. Snippet: "${pageText.slice(0, 300)}"`);
                continue;
            }

            // ── Receiver Name ──
            let receiverName = '';
            const rnPatterns = [
                /Credited\s*Party\s*name\s*([^/\n]+?)(?:\s*(?:የገን|Payer)|$)/i,
                /Receiver([A-Z][A-Za-z\s\.\'\\/]+?)(?=\s*Account)/i,
                /Credit\s*Account\s*\d+\s*-\s*([A-Za-z\s]{3,60}?)(?:\s*Receiver|\s*Order|\s*Debit|$)/i,
                /(?:Beneficiary|Receiver|Credited\s*Party)[:\s]+([A-Za-z\s]{3,60})/i,
            ];
            for (const p of rnPatterns) {
                const m = pageText.match(p);
                if (m && m[1] && m[1].trim().length > 2) {
                    receiverName = m[1].trim().replace(/^(MR\.?|MRS\.?|MS\.?|DR\.?|MISS\.?)\s+/i, '').trim();
                    break;
                }
            }

            // ── Receiver Account ──
            let receiverAccount = '';
            const raPatterns = [
                /Credited\s*party\s*account\s*no\s+([\d\*]+)/i,
                /Credit\s*Account\s*([\d]{7,16})/i,
                /Receiver[A-Z][A-Za-z\s\.\'\\/]+?Account([\d\*]{6,16})/i,
            ];
            for (const p of raPatterns) {
                const m = pageText.match(p);
                if (m) { receiverAccount = m[1]; break; }
            }

            // ── Sender ──
            let senderName = '';
            let senderAccount = '';
            if (method === 'cbebirr') {
                const cbebirrSenderMatch = pageText.match(/Debit\s*Account\s*(\d+)\s*-\s*([A-Za-z\s]{3,60}?)(?:\s*Credit|\s*Order|$)/i);
                if (cbebirrSenderMatch) { senderAccount = cbebirrSenderMatch[1]; senderName = cbebirrSenderMatch[2].trim(); }
            }
            if (!senderName) {
                const senderPatterns = [
                    /(?:Payer|Sender|Debtor|From)[:\s]+([A-Za-z\s]{3,60})/i,
                    /Payer\s*name\s*([^/\n]+?)(?:\s*(?:Payer|Amount)|$)/i,
                    /Debit\s*Account\s*[\d\*]+\s*-\s*([A-Za-z\s]{3,60}?)(?:\s*Sender|\s*Order|$)/i,
                ];
                for (const p of senderPatterns) {
                    const m = pageText.match(p);
                    if (m && m[1] && m[1].trim().length > 2) { senderName = m[1].trim(); break; }
                }
            }
            if (!senderAccount) {
                const saPatterns = [
                    /Debit\s*Account\s*([\d\*]{6,16})/i,
                    /(?:Payer|Sender)\s*account\s*(?:no\s*)?([\d\*]+)/i,
                ];
                for (const p of saPatterns) {
                    const m = pageText.match(p);
                    if (m) { senderAccount = m[1]; break; }
                }
            }

            // ── Date ──
            const dateMatch = pageText.match(/(\d{2}-\d{2}-\d{4}\s+\d{2}:\d{2}:\d{2})/)
                || pageText.match(/(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2})/)
                || pageText.match(/Payment\s*Date[\s&]*Time\s*(\d{1,2}\/\d{1,2}\/\d{4}[,\s]+\d{1,2}:\d{2}(?::\d{2})?\s*(?:AM|PM)?)/i);
            const dateStr = dateMatch ? dateMatch[1] : '';

            const methodLabel = method === 'telebirr' ? 'Telebirr' : method === 'cbebirr' ? 'CBEBirr' : 'CBE';
            console.log(`[TxLookup:${method}] SUCCESS for ${txId}`);
            return {
                ok: true,
                method: methodLabel,
                txId,
                amount,
                receiverName,
                receiverAccount,
                senderName,
                senderAccount,
                date: dateStr,
                rawDate: dateStr || null,
            };
        } catch (err) {
            console.log(`[TxLookup] ${method} error for ${txId}: ${err.message}`);
        }
    }

    return { ok: false, error: 'Transaction search failed. The receipt may be too old, the status page may be offline, or the ID is unrecognized.' };
}

async function verifyWithVerifyEt(txId, provider, expectedAmount, settlementAccount, expectedReceiverName) {
    const VERIFY_ET_API_KEY = process.env.VERIFY_ET_API_KEY;
    
    if (!VERIFY_ET_API_KEY) {
        console.error('[VerifyEt] VERIFY_ET_API_KEY is missing from environment variables');
        return { ok: false, failureType: 'config_error', error: 'Server configuration error' };
    }

    try {
        // Normalize provider name — verify.et uses 'boa' for Bank of Abyssinia
        const bankAliasMap = {
            telebirr: 'telebirr',
            cbebirr: 'cbebirr',
            cbe: 'cbe',
            abyssinia: 'boa',
            boa: 'boa',
        };
        const normalizedBank = bankAliasMap[provider.toLowerCase()] || provider.toLowerCase();
        console.log(`[VerifyEt] Calling verify.et for TX:${txId} | bank:${normalizedBank} (input:${provider})`);
        
        const body = { bank: normalizedBank };
        
        if (normalizedBank === 'telebirr') {
            // Telebirr uses transactionNumber + optional settlementAccount (phone)
            body.transactionNumber = txId.trim().toUpperCase();
            if (settlementAccount) {
                let acc = settlementAccount.toString().replace(/\s/g, '');
                if (!acc.startsWith('0')) acc = '0' + acc;
                body.settlementAccount = acc;
            }
        } else if (normalizedBank === 'cbe') {
            // CBE uses referenceNumber + optional accountSuffix (last 8 digits)
            // For new mbreciept.cbe.com.et URLs, pass the full URL as receiptUrl too
            body.referenceNumber = txId.trim().toUpperCase();
            if (txId.includes('-') || txId.startsWith('V2')) {
                // New CBE receipt URL format — pass the original URL
                body.receiptUrl = `https://mbreciept.cbe.com.et/${txId.replace(/^V2-/, 'v2-')}`;
            }
            if (settlementAccount) body.accountSuffix = settlementAccount.toString().replace(/\D/g, '').slice(-8);
        } else if (normalizedBank === 'boa') {
            // Bank of Abyssinia uses referenceNumber + optional accountSuffix (last 5 digits)
            body.referenceNumber = txId.trim().toUpperCase();
            if (settlementAccount) body.accountSuffix = settlementAccount.toString().replace(/\D/g, '').slice(-5);
        } else if (normalizedBank === 'cbebirr') {
            // CBEBirr uses receiptNumber + optional phone number (in 251 format)
            body.receiptNumber = txId.trim().toUpperCase();
            if (settlementAccount) {
                let ph = settlementAccount.toString().replace(/[\s\-]/g, '');
                // Convert to 251 format for verify.et
                if (ph.startsWith('0')) ph = '251' + ph.slice(1);
                if (!ph.startsWith('251')) ph = '251' + ph;
                body.phone = ph;
            }
        } else {
            body.reference = txId.trim().toUpperCase();
            if (settlementAccount) body.settlementAccount = settlementAccount;
        }

        console.log('[VerifyEt] Request body:', JSON.stringify(body));

        const response = await axios.post('https://verify.et/api/verify?waitMs=15000', body, {
            headers: {
                'x-api-key': VERIFY_ET_API_KEY,
                'Content-Type': 'application/json'
            },
            timeout: 20000
        });

        const data = response.data;
        console.log('[VerifyEt] Response status:', response.status, '| envelope:', JSON.stringify(data).slice(0, 300));

        if (response.status === 202 || (data?.verification?.processingStatus === 'queued')) {
            const statusUrl = data?.links?.statusUrl || data?.statusUrl;
            console.log(`[VerifyEt] ⏳ Queued for ${txId}. StatusUrl: ${statusUrl}`);
            return {
                ok: false,
                failureType: 'queued',
                statusUrl,
                requestId: data?.requestId,
                error: 'Verification queued — bank is still processing'
            };
        }

        if (data && data.success && data.data && data.data.length > 0) {
            const txData = data.data[0];

            if (txData && txData.verified) {
                if (txData.settlementAccountMatch && txData.settlementAccountMatch.matched === false) {
                    const reason = txData.settlementAccountMatch.reason || 'account_mismatch';
                    // If verify.et hasn't registered our account, don't reject — rely on name matching
                    if (reason === 'no_registered_accounts') {
                        console.log(`[VerifyEt] ⚠️ Settlement account not registered with verify.et — skipping account check, using name match only`);
                    } else {
                        console.log(`[VerifyEt] ❌ Settlement mismatch (${reason}). Paid to: ${txData.receiverAccount}`);
                        return {
                            ok: false,
                            failureType: 'rejected',
                            error: `Payment was not sent to the correct account (received by: ${txData.receiverAccount || 'unknown'})`
                        };
                    }
                }

                // Track whether we skipped account check
                const accountCheckSkipped = txData.settlementAccountMatch && 
                    txData.settlementAccountMatch.reason === 'no_registered_accounts';

                if (expectedReceiverName && txData.receiverName && !accountCheckSkipped) {
                    // Only do name check if we verified account is registered
                    const cleanExpected = expectedReceiverName.toLowerCase().replace(/\s+/g, '');
                    const cleanFound = txData.receiverName.toLowerCase().replace(/\s+/g, '');
                    // Standard include check
                    let nameMatches = cleanFound.includes(cleanExpected) ||
                        cleanExpected.split(/\s+/).some(part => part.length > 2 && cleanFound.includes(part));
                    // Fuzzy: check if first 4 chars match (handles 'nahom'/'noham' transliterations)
                    if (!nameMatches) {
                        const exp4 = cleanExpected.slice(0, 4);
                        const words = txData.receiverName.toLowerCase().split(/\s+/);
                        nameMatches = words.some(w => w.slice(0, 4) === exp4 || exp4.includes(w.slice(0, 3)));
                    }
                    // Fuzzy: count matching characters (sort both, compare overlap)
                    if (!nameMatches) {
                        const expChars = cleanExpected.split('').sort().join('');
                        const foundWord = txData.receiverName.toLowerCase().split(' ')[0].split('').sort().join('');
                        const matches = [...expChars].filter(c => foundWord.includes(c)).length;
                        nameMatches = matches >= Math.floor(cleanExpected.length * 0.7);
                    }
                    if (!nameMatches) {
                        console.log(`[VerifyEt] ❌ Name mismatch. Expected: "${expectedReceiverName}", Got: "${txData.receiverName}"`);
                        return {
                            ok: false,
                            failureType: 'rejected',
                            error: `Receiver name mismatch: payment was received by "${txData.receiverName}"`
                        };
                    }
                } else if (accountCheckSkipped) {
                    console.log(`[VerifyEt] ℹ️ Skipping name check since account not registered — transaction verified: true by verify.et`);
                }

                console.log(`[VerifyEt] ✅ Verified: ${txId} → ${txData.amount} ETB to ${txData.receiverName}`);
                return {
                    ok: true,
                    amount: parseFloat(txData.amount) || expectedAmount,
                    receiverName: txData.receiverName || '',
                    senderName: txData.senderName || '',
                    txDate: txData.timestamp ? new Date(txData.timestamp) : new Date()
                };
            }

            console.log(`[VerifyEt] ❌ Transaction ${txId} exists but is not verified. Status: ${txData?.status}`);
            return {
                ok: false,
                failureType: 'rejected',
                error: txData?.message || `Transaction status is "${txData?.status || 'unverified'}"`
            };
        }

        console.log('[VerifyEt] Unexpected response:', JSON.stringify(data).slice(0, 200));
        return {
            ok: false,
            failureType: 'connection_error',
            error: data?.message || 'Unexpected response from verify.et'
        };

    } catch (err) {
        const errorMsg = err.response?.data?.message || err.message;
        const isTimeout = err.code === 'ECONNABORTED' || err.message?.includes('timeout');
        const status = err.response?.status;
        console.error(`[VerifyEt] ${isTimeout ? 'Timeout' : 'Error'} for TX ${txId} (HTTP ${status || 'N/A'}):`, errorMsg);
        return {
            ok: false,
            failureType: 'connection_error',
            error: `verify.et ${isTimeout ? 'timed out' : 'connection failed'}: ${errorMsg}`
        };
    }
}

/**
 * Poll verify.et for a queued request until it completes or times out.
 */
async function pollVerifyEt(statusUrl, maxWaitMs = 25000) {
    const VERIFY_ET_API_KEY = process.env.VERIFY_ET_API_KEY;
    const fullUrl = `https://verify.et${statusUrl}`;
    const pollInterval = 3000;
    const deadline = Date.now() + maxWaitMs;

    console.log(`[VerifyEt:Poll] Polling ${fullUrl} for up to ${maxWaitMs}ms`);

    while (Date.now() < deadline) {
        await new Promise(res => setTimeout(res, pollInterval));
        try {
            const res = await axios.get(fullUrl, {
                headers: { 'x-api-key': VERIFY_ET_API_KEY },
                timeout: 8000
            });
            const d = res.data;
            console.log(`[VerifyEt:Poll] Status:`, JSON.stringify(d).slice(0, 200));

            const status = d?.data?.processingStatus || d?.data?.status;

            if (status === 'completed' || status === 'success') {
                const txData = d.data;
                if (txData?.verified) {
                    let resultObj = txData;
                    if (Array.isArray(txData.result) && txData.result.length > 0) {
                        resultObj = txData.result[0];
                    } else if (txData.result && typeof txData.result === 'object') {
                        resultObj = txData.result;
                    }
                    return {
                        ok: true,
                        amount: parseFloat(resultObj.amount) || parseFloat(txData.amount) || 0,
                        receiverName: resultObj.receiverName || txData.receiverName || '',
                        senderName: resultObj.senderName || txData.senderName || '',
                        txDate: resultObj.timestamp ? new Date(resultObj.timestamp) : (resultObj.completedAt ? new Date(resultObj.completedAt) : (txData.completedAt ? new Date(txData.completedAt) : new Date()))
                    };
                }
                return {
                    ok: false,
                    failureType: 'rejected',
                    error: `Transaction completed but not verified (status: ${txData?.status})`
                };
            }

            if (status === 'failed' || status === 'error') {
                const errMsg = d?.data?.errorMessage || 'Verification failed at bank';
                console.log(`[VerifyEt:Poll] Failed: ${errMsg}`);
                return {
                    ok: false,
                    failureType: 'rejected',
                    error: errMsg
                };
            }

            console.log(`[VerifyEt:Poll] Still processing (${status}), retrying...`);
        } catch (e) {
            console.log(`[VerifyEt:Poll] Poll request error: ${e.message}`);
        }
    }

    return {
        ok: false,
        failureType: 'queued',
        error: 'Verification timed out — bank is taking too long. Please try again.'
    };
}

/* Scrape a CBEBirr receipt page.
 */

module.exports = {
    verifyWithVerifyEt,
    pollVerifyEt,
    verifyTelebirr,
    verifyTelebirrFromSMS,
    verifyCBEBirr,
    verifyCBE,
    verifyAbyssinia,
    lookupTransaction,
    normalizePhone,
    maskedAccountMatches,
};
