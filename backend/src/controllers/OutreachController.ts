import { Request, Response } from 'express';
import { logDebug } from '../utils/logger';
import { outreachService } from '../services/OutreachService';

const MAX_CONCURRENT_BATCHES = 3;
let activeBatches = 0;
let nextBatchId = 1;

export const activeBatchDetails: Map<number, { size: number, processed: number, owner: string }> = new Map();
const batchQueue: Array<{ id: number, task: () => Promise<void>, size: number, owner: string }> = [];

export class OutreachController {

    static async runNextInQueue() {
        if (activeBatches >= MAX_CONCURRENT_BATCHES) return;
        if (batchQueue.length === 0) return;

        const taskObj = batchQueue.shift();
        if (!taskObj) return;

        activeBatches++;
        activeBatchDetails.set(taskObj.id, { size: taskObj.size, processed: 0, owner: taskObj.owner });
        
        await logDebug(`QueueManager: Starting Batch#${taskObj.id} (${taskObj.size} candidates) for ${taskObj.owner}. Active: ${activeBatches}/${MAX_CONCURRENT_BATCHES}`);
        
        try {
            await taskObj.task();
        } catch (e: any) {
            await logDebug(`QueueManager: Batch#${taskObj.id} failed: ${e.message}`);
        } finally {
            activeBatches--;
            activeBatchDetails.delete(taskObj.id);
            await logDebug(`QueueManager: Batch#${taskObj.id} completed.`);
            OutreachController.runNextInQueue();
        }
    }

    static async triggerOutreach(req: Request, res: Response) {
        const { candidates, jd, email, model, adjacentRoles, jobName, companyName, bypassDeduplication, useCompanyIntel, usePipeline, topN, topK, minExp, maxExp, screeningEngine, treeTopK } = req.body;

        if (!usePipeline && screeningEngine !== 'tree' && (!candidates || !Array.isArray(candidates) || candidates.length === 0)) {
            return res.status(400).json({ error: "Missing or empty 'candidates' array" });
        }
        if (!jd || !email || !jobName || !companyName) {
            return res.status(400).json({ error: "Missing 'jd', 'email', 'jobName', or 'companyName'" });
        }

        const currentBatchId = nextBatchId++;
        const targetModel = model || 'deepseek-ai/DeepSeek-V3.2';
        const pipelineEnabled = usePipeline === true;
        const resolvedTopN = typeof topN === 'number' ? Math.min(Math.max(topN, 50), 1000) : 700;
        const resolvedTopK = typeof topK === 'number' ? Math.min(Math.max(topK, 10), 500) : 300;
        const resolvedScreeningEngine = screeningEngine || 'llm';
        const resolvedTreeTopK = typeof treeTopK === 'number' ? Math.min(Math.max(treeTopK, 10), 2000) : 1000;
        
        await logDebug(`[API] Received outreach request for ${candidates?.length || 0} candidates. Batch ID: ${currentBatchId}, Model: ${targetModel}, Engine: ${resolvedScreeningEngine}, Pipeline: ${pipelineEnabled}${pipelineEnabled ? ` (N=${resolvedTopN}, K=${resolvedTopK})` : ''}`);

        const task = async () => {
            await outreachService.runOutreachCampaign(
                jd, candidates, companyName, email, targetModel, adjacentRoles, jobName, bypassDeduplication, currentBatchId, undefined, pipelineEnabled, resolvedTopN, resolvedTopK,
                typeof minExp === 'number' ? minExp : undefined,
                typeof maxExp === 'number' ? maxExp : undefined,
                resolvedScreeningEngine,
                resolvedTreeTopK,
                useCompanyIntel
            );
        };

        batchQueue.push({
            id: currentBatchId,
            task,
            size: candidates?.length || 0,
            owner: email
        });

        if (activeBatches >= MAX_CONCURRENT_BATCHES) {
            await logDebug(`Batch#${currentBatchId} Queued. Position in queue: ${batchQueue.length}`);
        }

        OutreachController.runNextInQueue();

        return res.status(202).json({
            message: "Outreach batch accepted and queued for processing.",
            batch_id: currentBatchId,
            queue_status: `Active Batches: ${activeBatches}/${MAX_CONCURRENT_BATCHES}, Pending in Queue: ${batchQueue.length}`
        });
    }

    static getQueueStatus(req: Request, res: Response) {
        const activeArray = Array.from(activeBatchDetails.entries()).map(([id, data]) => ({
            id,
            size: data.size,
            processed: data.processed,
            owner: data.owner
        }));

        res.json({
            activeCount: activeBatches,
            maxConcurrent: MAX_CONCURRENT_BATCHES,
            pendingCount: batchQueue.length,
            activeBatches: activeArray,
            queuedBatches: batchQueue.map(b => ({ id: b.id, size: b.size, owner: b.owner }))
        });
    }
}
