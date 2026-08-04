import { google } from 'googleapis';
import dotenv from 'dotenv';
import { logDebug } from '../utils/logger';
import fs from 'fs';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../../../.env') }); // Adjust relative path

const SENDER_NAME = process.env.SENDER_NAME || 'Saori';
const SENDER_EMAIL = process.env.GMAIL_ADDRESS || '';

export class EmailService {
    private gmailClient: any = null;
    private initialized = false;

    constructor() {
        this.initClient();
    }

    private initClient() {
        try {
            const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
            if (!credPath || !credPath.endsWith('client_secret.json')) {
                logDebug("GOOGLE_APPLICATION_CREDENTIALS is not set or not pointing to client_secret.json.");
                return;
            }

            const content = fs.readFileSync(credPath, 'utf-8');
            const credentials = JSON.parse(content);
            const { client_secret, client_id } = credentials.installed || credentials.web;

            const tokenPath = path.join(path.dirname(credPath), 'token.json');
            if (!fs.existsSync(tokenPath)) {
                logDebug(`token.json not found at ${tokenPath}. Please run the token generation script.`);
                return;
            }

            const tokenContent = fs.readFileSync(tokenPath, 'utf-8');
            const tokens = JSON.parse(tokenContent);

            const oAuth2Client = new google.auth.OAuth2(client_id, client_secret);
            oAuth2Client.setCredentials(tokens);

            this.gmailClient = google.gmail({ version: 'v1', auth: oAuth2Client });
            this.initialized = true;
        } catch (err: any) {
            logDebug(`[EmailService Error] Failed to initialize Gmail API client: ${err.message}`);
        }
    }

    async sendEmail(subject: string, body: string, to: string, cc?: string): Promise<boolean> {
        if (!this.initialized && !this.gmailClient) {
            this.initClient();
        }

        if (!this.gmailClient) {
            logDebug("Gmail API client not initialized, cannot send email.");
            return false;
        }

        try {
            const utf8Subject = `=?utf-8?B?${Buffer.from(subject).toString('base64')}?=`;
            const messageParts = [
                `From: ${SENDER_NAME} <${SENDER_EMAIL}>`,
                `To: ${to}`,
                cc ? `Cc: ${cc}` : '',
                'Content-Type: text/plain; charset=utf-8',
                'MIME-Version: 1.0',
                `Subject: ${utf8Subject}`,
                '',
                body
            ];

            // Remove empty lines for headers (like empty cc)
            const message = messageParts.filter(part => part !== '').join('\n');
            const encodedMessage = Buffer.from(message)
                .toString('base64')
                .replace(/\+/g, '-')
                .replace(/\//g, '_')
                .replace(/=+$/, '');

            await this.gmailClient.users.messages.send({
                userId: 'me',
                requestBody: {
                    raw: encodedMessage
                }
            });

            logDebug(`  [Email Sent] Successfully sent to ${to} via Gmail API`);
            return true;
        } catch (error: any) {
            logDebug(`  [Email Error] ${error.message}`);
            return false;
        }
    }
}

export const emailService = new EmailService();
