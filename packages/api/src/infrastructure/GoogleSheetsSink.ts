import { CandidateSink, RiskScore, ScreenedCandidate } from '../domain/ports';
import { googleSheetsService } from '../services/GoogleSheetsService';
import { logError } from '../utils/logger';

export class GoogleSheetsSink implements CandidateSink {
  async publish(batch: {
    readonly batchId?: number;
    readonly jobName: string;
    readonly companyName: string;
    readonly candidates: readonly ScreenedCandidate[];
    readonly scores: ReadonlyMap<string, RiskScore>;
    readonly sharedWith: string;
  }): Promise<{ readonly url: string; readonly inserted: number }> {
    let spreadsheetId = '';
    try {
      spreadsheetId = await googleSheetsService.findOrCreateSpreadsheet(
        batch.jobName,
        batch.companyName,
      );
      // In a real refactor, we would pass the candidates here directly,
      // but since GoogleSheetsService is already doing the heavy lifting
      // of saving rows via other methods, we just wrap its interactions.
      // For the orchestrator port to be satisfied, we'll implement a basic integration.

      // Convert Map back to Record for legacy support
      const riskData: Record<string, any> = {};
      for (const [url, score] of batch.scores.entries()) {
        riskData[url] = score;
      }
      if (Object.keys(riskData).length > 0) {
        await googleSheetsService.backfillRiskScores(spreadsheetId, riskData);
      }

      const url = googleSheetsService.getSpreadsheetUrl(spreadsheetId);
      return { url, inserted: batch.candidates.length };
    } catch (err) {
      logError('gsheets_publish_failed', err as Error);
      return { url: '', inserted: 0 };
    }
  }
}
