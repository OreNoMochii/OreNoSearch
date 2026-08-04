import { OpenAI } from 'openai';
import dotenv from 'dotenv';

import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../../../.env') }); // Assuming execution from root, adjust as needed

if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY must be set in .env");
}

export const llmClient = new OpenAI({
    baseURL: "https://api.deepinfra.com/v1/openai",
    apiKey: process.env.OPENAI_API_KEY,
    timeout: 300000, // 5 minute timeout for deep reasoning
    maxRetries: 3    // Auto-retry on connection errors or transient failures
});

let nvidiaClient: OpenAI | null = null;

export function getClient(model: string): OpenAI {
    if (model.startsWith('nvidia:')) {
        if (!process.env.NVIDIA_API_KEY) {
            throw new Error("NVIDIA_API_KEY must be set in .env to use NVIDIA NIM models");
        }
        if (!nvidiaClient) {
            nvidiaClient = new OpenAI({
                baseURL: "https://integrate.api.nvidia.com/v1",
                apiKey: process.env.NVIDIA_API_KEY,
                timeout: 300000,
                maxRetries: 0  // We handle retries ourselves with backoff
            });
        }
        return nvidiaClient;
    }
    return llmClient;
}
