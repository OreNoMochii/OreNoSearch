import { googleSheetsService } from './services/GoogleSheetsService';

async function test() {
    try {
        console.log('Testing connection and sheet creation...');
        const spreadsheetId = await googleSheetsService.findOrCreateSpreadsheet(
            'Test Role',
            'Test Company',
        );
        console.log('Success! Spreadsheet ID:', spreadsheetId);
        console.log('URL:', googleSheetsService.getSpreadsheetUrl(spreadsheetId));

        // Optionally insert a test candidate
        console.log('Testing incremental insertion...');
        const existing = new Set<string>();
        const inserted = await googleSheetsService.appendSingleCandidate(
            spreadsheetId,
            {
                name: 'Test Candidate',
                profile_url: 'https://linkedin.com/in/test-candidate-' + Date.now(),
                headline: 'Software Engineer',
                current_company: 'Test Company',
                location: 'Test City',
            },
            existing,
            'test@example.com',
        );
        console.log('Insertion result:', inserted ? 'Success' : 'Failed / Duplicate');
    } catch (e) {
        console.error('Test failed:', e);
    }
}
test();
