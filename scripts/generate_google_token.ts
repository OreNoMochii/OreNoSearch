import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { google } from 'googleapis';

const SCOPES = [
    'https://www.googleapis.com/auth/spreadsheets',
    'https://www.googleapis.com/auth/drive',
    'https://www.googleapis.com/auth/gmail.send'
];
const TOKEN_PATH = path.join(__dirname, '../token.json');
const CREDENTIALS_PATH = path.join(__dirname, '../client_secret.json');

async function main() {
    if (!fs.existsSync(CREDENTIALS_PATH)) {
        console.error(`Error: Could not find ${CREDENTIALS_PATH}`);
        console.error('Please make sure client_secret.json is placed in the project root directory.');
        process.exit(1);
    }

    const content = fs.readFileSync(CREDENTIALS_PATH, 'utf-8');
    const credentials = JSON.parse(content);
    const { client_secret, client_id, redirect_uris } = credentials.installed || credentials.web;

    const oAuth2Client = new google.auth.OAuth2(
        client_id,
        client_secret,
        redirect_uris && redirect_uris.length > 0 ? redirect_uris[0] : 'urn:ietf:wg:oauth:2.0:oob'
    );

    const authUrl = oAuth2Client.generateAuthUrl({
        access_type: 'offline',
        scope: SCOPES,
        prompt: 'consent'
    });

    console.log('Authorize this app by visiting this url:');
    console.log(authUrl);
    console.log('');

    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });

    rl.question('Enter the code from that page here: ', async (code) => {
        rl.close();
        try {
            const { tokens } = await oAuth2Client.getToken(code);
            oAuth2Client.setCredentials(tokens);
            fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));
            console.log(`\nSuccessfully stored token to ${TOKEN_PATH}`);
            console.log('Now ensure GOOGLE_APPLICATION_CREDENTIALS in your .env points to client_secret.json');
        } catch (err) {
            console.error('Error retrieving access token', err);
        }
    });
}

main();
