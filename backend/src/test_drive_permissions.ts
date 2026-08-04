import { google } from 'googleapis';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

async function checkPermissions() {
    try {
        const auth = new google.auth.GoogleAuth({
            keyFilename: process.env.GOOGLE_APPLICATION_CREDENTIALS,
            scopes: ['https://www.googleapis.com/auth/drive'],
        });

        const drive = google.drive({ version: 'v3', auth });
        const folderId = process.env.GDRIVE_ROOT_FOLDER_ID || '1DUr5MMZ-HpglgB0EgTqHE54mEK9B-fxC';

        console.log(`Checking folder ID: ${folderId}...`);

        const res = await drive.files.get({
            fileId: folderId,
            fields: 'id, name, capabilities, owners, shared, permissions',
            supportsAllDrives: true,
        });

        console.log('Folder metadata:', JSON.stringify(res.data, null, 2));

        if (res.data.capabilities) {
            console.log('\nCan you add children? ', res.data.capabilities.canAddChildren);
        }
    } catch (e: any) {
        console.error('Error fetching folder:', e.message);
    }
}

checkPermissions();
