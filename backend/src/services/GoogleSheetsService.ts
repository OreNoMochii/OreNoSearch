import { google, sheets_v4, drive_v3 } from 'googleapis';
import { logDebug } from '../utils/logger';
import { config } from '../config';
import path from 'path';
import fs from 'fs';

const SCOPES = [
    'https://www.googleapis.com/auth/spreadsheets',
    'https://www.googleapis.com/auth/drive',
];

// Root folder where all role subfolders are created
const ROOT_FOLDER_ID = config.GDRIVE_ROOT_FOLDER_ID;

const SHEET_HEADERS = [
    'Name',
    'Headline / Role',
    'Company',
    'Move Prob (%)',
    'Hazard',
    'Tenure (months)',
    'Profile URL',
    'Location',
    'Contacted By',
    'Shared With',
    'Date Added',
];

export class GoogleSheetsService {
    private sheets: sheets_v4.Sheets | null = null;
    private drive: drive_v3.Drive | null = null;

    private async getAuth() {
        const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
        if (!credPath) {
            throw new Error('GOOGLE_APPLICATION_CREDENTIALS not set in .env');
        }

        if (credPath.endsWith('client_secret.json')) {
            const content = fs.readFileSync(credPath, 'utf-8');
            const credentials = JSON.parse(content);
            const { client_secret, client_id, redirect_uris } =
                credentials.installed || credentials.web;

            const oAuth2Client = new google.auth.OAuth2(
                client_id,
                client_secret,
                redirect_uris && redirect_uris.length > 0
                    ? redirect_uris[0]
                    : 'urn:ietf:wg:oauth:2.0:oob',
            );

            const tokenPath = path.join(path.dirname(credPath), 'token.json');
            if (!fs.existsSync(tokenPath)) {
                throw new Error(
                    `token.json not found at ${tokenPath}. Please run the token generation script first.`,
                );
            }

            const tokenContent = fs.readFileSync(tokenPath, 'utf-8');
            oAuth2Client.setCredentials(JSON.parse(tokenContent));
            return oAuth2Client;
        }

        const auth = new google.auth.GoogleAuth({
            keyFilename: credPath,
            scopes: SCOPES,
        });
        return auth;
    }

    private async ensureClients() {
        if (this.sheets && this.drive) return;

        const auth = await this.getAuth();
        this.sheets = google.sheets({ version: 'v4', auth });
        this.drive = google.drive({ version: 'v3', auth });
    }

    /**
     * Find or create a folder inside a parent folder.
     * Returns the folder ID.
     */
    private async findOrCreateFolder(folderName: string, parentId: string): Promise<string> {
        await this.ensureClients();

        // Search for existing folder
        try {
            const res = await this.drive!.files.list({
                q: `'${parentId}' in parents and name = '${folderName.replace(/'/g, "\\'")}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
                fields: 'files(id, name)',
                pageSize: 5,
                supportsAllDrives: true,
                includeItemsFromAllDrives: true,
            });

            const files = res.data.files || [];
            if (files.length > 0) {
                await logDebug(
                    `  [GSheets] Found existing folder: "${files[0].name}" (${files[0].id})`,
                );
                return files[0].id!;
            }
        } catch (err: any) {
            await logDebug(`  [GSheets] Error searching for folder: ${err.message}`);
            throw err;
        }

        // Create new folder
        try {
            const createRes = await this.drive!.files.create({
                requestBody: {
                    name: folderName,
                    mimeType: 'application/vnd.google-apps.folder',
                    parents: [parentId],
                },
                fields: 'id, name',
                supportsAllDrives: true,
            });

            await logDebug(
                `  [GSheets] Created new folder: "${folderName}" (${createRes.data.id})`,
            );
            return createRes.data.id!;
        } catch (err: any) {
            await logDebug(`  [GSheets] Error creating folder: ${err.message}`);
            throw err;
        }
    }

    /**
     * Search a folder for an existing spreadsheet with the canonical name.
     * Returns the spreadsheet ID if found, null otherwise.
     */
    private async findSpreadsheet(
        folderId: string,
        spreadsheetName: string,
    ): Promise<string | null> {
        await this.ensureClients();

        const escapedName = spreadsheetName.replace(/'/g, "\\'");

        try {
            const res = await this.drive!.files.list({
                q: `'${folderId}' in parents and name = '${escapedName}' and mimeType = 'application/vnd.google-apps.spreadsheet' and trashed = false`,
                fields: 'files(id, name)',
                pageSize: 5,
                supportsAllDrives: true,
                includeItemsFromAllDrives: true,
            });

            const files = res.data.files || [];
            if (files.length > 0) {
                await logDebug(
                    `  [GSheets] Found existing spreadsheet: "${files[0].name}" (${files[0].id})`,
                );
                return files[0].id!;
            }

            return null;
        } catch (err: any) {
            await logDebug(`  [GSheets] Error searching for spreadsheet: ${err.message}`);
            throw err;
        }
    }

    /**
     * Create a new spreadsheet in the target folder with headers already set.
     * Returns the new spreadsheet ID.
     */
    private async createSpreadsheet(folderId: string, spreadsheetName: string): Promise<string> {
        await this.ensureClients();

        try {
            // Create the spreadsheet
            const createRes = await this.sheets!.spreadsheets.create({
                requestBody: {
                    properties: { title: spreadsheetName },
                    sheets: [
                        {
                            properties: {
                                title: 'Candidates',
                                gridProperties: { frozenRowCount: 1 },
                            },
                        },
                    ],
                },
            });

            const spreadsheetId = createRes.data.spreadsheetId!;

            // Move it into the target folder
            const fileInfo = await this.drive!.files.get({
                fileId: spreadsheetId,
                fields: 'parents',
                supportsAllDrives: true,
            });
            await this.drive!.files.update({
                fileId: spreadsheetId,
                addParents: folderId,
                removeParents: fileInfo.data.parents?.join(',') || '',
                fields: 'id, parents',
                supportsAllDrives: true,
            });

            // Write headers
            await this.sheets!.spreadsheets.values.update({
                spreadsheetId,
                range: 'Candidates!A1',
                valueInputOption: 'RAW',
                requestBody: {
                    values: [SHEET_HEADERS],
                },
            });

            // Format header row (bold + dark background)
            const sheetId = createRes.data.sheets?.[0]?.properties?.sheetId || 0;
            await this.sheets!.spreadsheets.batchUpdate({
                spreadsheetId,
                requestBody: {
                    requests: [
                        {
                            repeatCell: {
                                range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
                                cell: {
                                    userEnteredFormat: {
                                        backgroundColor: {
                                            red: 0.15,
                                            green: 0.15,
                                            blue: 0.22,
                                            alpha: 1,
                                        },
                                        textFormat: {
                                            bold: true,
                                            foregroundColor: { red: 1, green: 1, blue: 1 },
                                        },
                                    },
                                },
                                fields: 'userEnteredFormat(backgroundColor,textFormat)',
                            },
                        },
                        {
                            autoResizeDimensions: {
                                dimensions: {
                                    sheetId,
                                    dimension: 'COLUMNS',
                                    startIndex: 0,
                                    endIndex: SHEET_HEADERS.length,
                                },
                            },
                        },
                    ],
                },
            });

            await logDebug(
                `  [GSheets] Created new spreadsheet: "${spreadsheetName}" (${spreadsheetId})`,
            );
            return spreadsheetId;
        } catch (err: any) {
            await logDebug(`  [GSheets] Error creating spreadsheet: ${err.message}`);
            throw err;
        }
    }

    /**
     * Main entry point: find or create the subfolder + spreadsheet for a role.
     * Folder structure: ROOT / company_name / role / role_date
     */
    async findOrCreateSpreadsheet(jobName: string, companyName: string): Promise<string> {
        const cName = companyName.trim().toLowerCase().replace(/\s+/g, '_');
        const rName = jobName.trim().toLowerCase().replace(/\s+/g, '_');

        const companyFolderId = await this.findOrCreateFolder(cName, ROOT_FOLDER_ID);
        const roleFolderId = await this.findOrCreateFolder(rName, companyFolderId);

        const dateStr = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
        const spreadsheetName = `${rName}_${dateStr}`;

        const existingId = await this.findSpreadsheet(roleFolderId, spreadsheetName);
        if (existingId) return existingId;
        return this.createSpreadsheet(roleFolderId, spreadsheetName);
    }

    /**
     * Read existing profile URLs from column C to avoid duplicates.
     */
    private async getExistingUrls(spreadsheetId: string): Promise<Set<string>> {
        await this.ensureClients();

        try {
            const res = await this.sheets!.spreadsheets.values.get({
                spreadsheetId,
                range: 'Candidates!G:G',
            });

            const rows = res.data.values || [];
            const urls = new Set<string>();
            for (let i = 1; i < rows.length; i++) {
                // skip header
                if (rows[i][0]) urls.add(rows[i][0]);
            }
            return urls;
        } catch {
            return new Set();
        }
    }

    /**
     * Append new candidate rows to the spreadsheet, deduplicating against existing URLs.
     * Returns the number of new rows appended.
     */
    async appendCandidates(
        spreadsheetId: string,
        candidates: Array<{
            name: string;
            profile_url: string;
            headline?: string;
            current_company?: string;
            location?: string;
        }>,
        riskData: Record<
            string,
            { hazard: number; move_prob: number; tenure: number; median_tenure?: number }
        >,
        sharedWith: string,
    ): Promise<number> {
        await this.ensureClients();

        const existingUrls = await this.getExistingUrls(spreadsheetId);
        const now = new Date().toISOString();

        const newRows: any[][] = [];
        for (const c of candidates) {
            const url = c.profile_url || '';
            if (!url || existingUrls.has(url)) continue;

            const risk = riskData[url];
            newRows.push([
                c.name || 'Unknown',
                c.headline || '',
                c.current_company || '',
                risk ? (risk.move_prob * 100).toFixed(2) : 'N/A',
                risk ? risk.hazard.toFixed(2) : 'N/A',
                risk ? risk.tenure.toFixed(1) : 'N/A',
                url,
                c.location || '',
                '', // Contacted By — left empty for manual input
                sharedWith,
                now,
            ]);
        }

        if (newRows.length === 0) {
            await logDebug(
                `  [GSheets] No new candidates to append (all ${candidates.length} already exist in sheet).`,
            );
            return 0;
        }

        try {
            await this.sheets!.spreadsheets.values.append({
                spreadsheetId,
                range: 'Candidates!A:K',
                valueInputOption: 'RAW',
                insertDataOption: 'INSERT_ROWS',
                requestBody: {
                    values: newRows,
                },
            });

            await logDebug(
                `  [GSheets] Appended ${newRows.length} new candidates (skipped ${candidates.length - newRows.length} duplicates).`,
            );
            return newRows.length;
        } catch (err: any) {
            await logDebug(`  [GSheets] Error appending candidates: ${err.message}`);
            throw err;
        }
    }

    /**
     * Append a single candidate row to the spreadsheet immediately after they pass screening.
     * Uses a pre-loaded set of existing URLs for dedup (avoids re-fetching column C every time).
     * Returns true if the candidate was actually inserted (not a duplicate).
     */
    async appendSingleCandidate(
        spreadsheetId: string,
        candidate: {
            name: string;
            profile_url: string;
            headline?: string;
            current_company?: string;
            location?: string;
        },
        existingUrls: Set<string>,
        sharedWith: string,
    ): Promise<boolean> {
        await this.ensureClients();

        const url = candidate.profile_url || '';
        if (!url) return false;

        // B17: reserve the URL *before* the await. The previous order was
        // has() -> await append() -> add(), so two concurrent members of a
        // screening wave could both pass the check and both insert, producing
        // duplicate rows. Claiming the slot synchronously closes that window.
        if (existingUrls.has(url)) return false;
        existingUrls.add(url);

        const now = new Date().toISOString();
        const row = [
            candidate.name || 'Unknown',
            candidate.headline || '',
            candidate.current_company || '',
            'N/A', // Move Prob — backfilled after batch attrition scoring
            'N/A', // Hazard
            'N/A', // Tenure
            url,
            candidate.location || '',
            '', // Contacted By
            sharedWith,
            now,
        ];

        try {
            await this.sheets!.spreadsheets.values.append({
                spreadsheetId,
                range: 'Candidates!A:K',
                valueInputOption: 'RAW',
                insertDataOption: 'INSERT_ROWS',
                requestBody: {
                    values: [row],
                },
            });

            await logDebug(`  [GSheets] ✅ Inserted: ${candidate.name}`);
            return true;
        } catch (err: any) {
            // Release the reservation so a later retry can insert this row.
            existingUrls.delete(url);
            await logDebug(`  [GSheets] Error inserting ${candidate.name}: ${err.message}`);
            return false;
        }
    }

    /**
     * Backfill attrition risk scores for candidates already in the sheet.
     * Finds the row by profile URL (column C) and updates columns F-H.
     */
    async backfillRiskScores(
        spreadsheetId: string,
        riskData: Record<string, { hazard: number; move_prob: number; tenure: number }>,
    ): Promise<void> {
        await this.ensureClients();

        if (Object.keys(riskData).length === 0) return;

        try {
            // Read all rows to find matching URLs
            const res = await this.sheets!.spreadsheets.values.get({
                spreadsheetId,
                range: 'Candidates!A:K',
            });

            const rows = res.data.values || [];
            const updates: { range: string; values: any[][] }[] = [];

            for (let i = 1; i < rows.length; i++) {
                // skip header
                const url = rows[i][6]; // Column G = Profile URL
                const risk = riskData[url];
                if (risk && (rows[i][3] === 'N/A' || !rows[i][3])) {
                    // Column D = Move Prob
                    updates.push({
                        range: `Candidates!D${i + 1}:F${i + 1}`,
                        values: [
                            [
                                (risk.move_prob * 100).toFixed(2),
                                risk.hazard.toFixed(2),
                                risk.tenure.toFixed(1),
                            ],
                        ],
                    });
                }
            }

            if (updates.length > 0) {
                await this.sheets!.spreadsheets.values.batchUpdate({
                    spreadsheetId,
                    requestBody: {
                        valueInputOption: 'RAW',
                        data: updates,
                    },
                });
                await logDebug(
                    `  [GSheets] Backfilled risk scores for ${updates.length} candidates.`,
                );
            }
        } catch (err: any) {
            await logDebug(`  [GSheets] Error backfilling risk scores: ${err.message}`);
        }
    }

    /**
     * Load existing profile URLs from column C. Exposed publicly so OutreachService
     * can pre-load the set once and pass it to appendSingleCandidate.
     */
    async loadExistingUrls(spreadsheetId: string): Promise<Set<string>> {
        return this.getExistingUrls(spreadsheetId);
    }

    /**
     * Get the human-readable URL for the spreadsheet.
     */
    getSpreadsheetUrl(spreadsheetId: string): string {
        return `https://docs.google.com/spreadsheets/d/${spreadsheetId}`;
    }
}

export const googleSheetsService = new GoogleSheetsService();
