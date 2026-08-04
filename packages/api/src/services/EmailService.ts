import { google } from 'googleapis';
import type { gmail_v1 } from 'googleapis';
import { config } from '../config';
import { logInfo, logWarn, logError } from '../utils/logger';
import fs from 'fs';
import { parseAddressList, InvalidRecipientError } from '../core/email_address';
import path from 'path';

/**
 * Conservative RFC 5322 addr-spec check. Deliberately rejects the characters
 * that carry meaning inside a header (whitespace, angle brackets, quotes,
 * comma, semicolon, colon, backslash) rather than trying to accept the full
 * grammar — this is an outbound allowlist, not a parser.
 */

export class EmailService {
  private gmailClient: gmail_v1.Gmail | null = null;

  /**
   * Builds the Gmail client. Called lazily rather than from the constructor,
   * which previously performed synchronous file I/O at module import time.
   */
  private initClient(): gmail_v1.Gmail | null {
    if (this.gmailClient) return this.gmailClient;

    try {
      const credPath = config.GOOGLE_APPLICATION_CREDENTIALS;
      if (!credPath.endsWith('client_secret.json')) {
        logWarn('email_client_bad_credentials_path', { credPath });
        return null;
      }

      const credentials = JSON.parse(fs.readFileSync(credPath, 'utf-8'));
      const { client_secret, client_id } = credentials.installed ?? credentials.web;

      const tokenPath = path.join(path.dirname(credPath), 'token.json');
      if (!fs.existsSync(tokenPath)) {
        logWarn('email_token_missing', { tokenPath });
        return null;
      }

      const oAuth2Client = new google.auth.OAuth2(client_id, client_secret);
      oAuth2Client.setCredentials(JSON.parse(fs.readFileSync(tokenPath, 'utf-8')));

      this.gmailClient = google.gmail({ version: 'v1', auth: oAuth2Client });
      return this.gmailClient;
    } catch (err) {
      logError('email_client_init_failed', err);
      return null;
    }
  }

  /**
   * Sends a plain-text message via the Gmail API.
   * Returns false rather than throwing, so a delivery failure cannot mark a
   * batch of candidates as contacted.
   */
  async sendEmail(subject: string, body: string, to: string, cc?: string): Promise<boolean> {
    const client = this.initClient();
    if (!client) {
      logWarn('email_client_unavailable');
      return false;
    }

    let toList: string[];
    let ccList: string[];
    try {
      toList = parseAddressList(to, 'To');
      ccList = parseAddressList(cc, 'Cc');
      if (toList.length === 0) {
        throw new InvalidRecipientError('To list is empty after validation');
      }
    } catch (err) {
      // Fail closed: never attempt a send with unvalidated recipients.
      logError('email_recipients_rejected', err);
      return false;
    }

    try {
      // RFC 2047 encoding neutralises CR/LF in the subject by construction.
      const encodedSubject = `=?utf-8?B?${Buffer.from(subject, 'utf8').toString('base64')}?=`;

      const headers = [
        `From: ${config.SENDER_NAME} <${config.GMAIL_ADDRESS}>`,
        `To: ${toList.join(', ')}`,
        ...(ccList.length > 0 ? [`Cc: ${ccList.join(', ')}`] : []),
        'Content-Type: text/plain; charset=utf-8',
        'MIME-Version: 1.0',
        `Subject: ${encodedSubject}`,
      ];

      // RFC 5322 mandates CRLF line endings between headers.
      const raw = Buffer.from(`${headers.join('\r\n')}\r\n\r\n${body}`, 'utf8').toString(
        'base64url',
      );

      await client.users.messages.send({ userId: 'me', requestBody: { raw } });

      logInfo('email_sent', { recipientCount: toList.length, ccCount: ccList.length });
      return true;
    } catch (err) {
      logError('email_send_failed', err, { recipientCount: toList.length });
      return false;
    }
  }
}

export const emailService = new EmailService();
