import { OutreachHistoryRepository } from '../domain/ports';
import { getSentCandidatesBatch, logOutreachSent } from '../repositories/postgres_repo';

export class PostgresOutreachHistory implements OutreachHistoryRepository {
  async findAlreadySent(
    profileUrls: readonly string[],
    recipients: readonly string[],
    companyName: string,
  ): Promise<ReadonlySet<string>> {
    return await getSentCandidatesBatch([...profileUrls], [...recipients], companyName);
  }

  async markSent(
    profileUrls: readonly string[],
    recipients: readonly string[],
    companyName: string,
    jobName: string,
  ): Promise<number> {
    return await logOutreachSent([...profileUrls], [...recipients], companyName, jobName);
  }
}
