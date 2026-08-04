import fs from 'fs';
import path from 'path';

// Logs are kept relative to the backend execution context
const DEBUG_LOG = path.join(process.cwd(), 'agent_debug.log');
const SKIPPED_LOG = path.join(process.cwd(), 'skipped_candidates.log');

export function logDebug(msg: string) {
    const entry = `${new Date().toISOString()} - INFO - ${msg}\n`;
    console.log(msg);
    fs.appendFileSync(DEBUG_LOG, entry);
}

export function logSkipped(candidate: any, stage: string, reasoning: string) {
    const timestamp = new Date().toISOString();
    const name = candidate.name || 'Unknown';
    const email = candidate.email || 'N/A';

    const logEntry = `[${timestamp}] STAGE: ${stage} | NAME: ${name} | EMAIL: ${email}\nREASON: ${reasoning}\n${'-'.repeat(50)}\n`;
    fs.appendFileSync(SKIPPED_LOG, logEntry);
}
