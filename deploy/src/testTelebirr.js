const { verifyTelebirr } = require('./utils/scraper');

// Test account
const myAccountNumber = '0940072277'; // or whatever it should be
const expectedName = 'Yonatan';

const receiptUrl = 'https://transactioninfo.ethiotelecom.et/receipt/DES8F3QMFM';

async function runTest() {
    console.log('Testing Telebirr Scraper for URL:', receiptUrl);
    const result = await verifyTelebirr(receiptUrl, myAccountNumber, expectedName);
    console.log('\n--- VERIFICATION RESULT ---');
    console.log(JSON.stringify(result, null, 2));
}

runTest();
