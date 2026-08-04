import { Page } from 'playwright';
import OpenAI from 'openai';
import { z } from 'zod';
import { zodResponseFormat } from 'openai/helpers/zod';
import * as dotenv from 'dotenv';
import { captureDOMState, agentClick, agentType } from '../utils/dom_to_text';
import { delay } from '../utils/dom';

dotenv.config();

const client = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    baseURL: 'https://api.deepinfra.com/v1/openai'
});

const AgentActionSchema = z.object({
    thought: z.string().describe("Your reasoning. ALWAYS required."),
    action: z.enum(["CLICK", "TYPE_AND_SUBMIT", "WAIT", "EXTRACT_CANDIDATES", "REFRESH"]).describe("The specific action to take."),
    target_id: z.number().nullable().optional().describe("The [ID] of the element you want to interact with. Use null if not applicable."),
    text: z.string().nullable().optional().describe("The text you want to type, if action is TYPE_AND_SUBMIT. Use null if not applicable.")
});

type AgentAction = z.infer<typeof AgentActionSchema>;

export async function runAgentCycle(
    page: Page,
    personaPrompt: string,
    history: { role: 'user' | 'assistant', content: string }[] = [],
    tabPrefix: string = '[Agent] '
): Promise<{ actionType: string, newHistory: any[] }> {
    
    // 1. Capture what is on the screen right now
    const { textMap } = await captureDOMState(page);
    
    const messages: any[] = [
        { role: "system", content: `${personaPrompt}\n\nYou MUST respond with a perfectly structured JSON object matching EXACTLY these keys: \n{ "thought": "string", "action": "CLICK|TYPE_AND_SUBMIT|WAIT", "target_id": null_or_number, "text": null_or_string }\nAll four keys must ALWAYS be present in your response. Never omit any key.\nOnly click on elements that exist in the VISUAL DOM MAP.` },
        ...history,
        { role: "user", content: `CURRENT SCREEN STATE:\n\n${textMap}\n\nWhat is your next action?` }
    ];

    try {
        // Attempt structured output first
        let result: AgentAction | null = null;
        
        try {
            const completion = await client.chat.completions.parse({
                model: "openai/gpt-oss-120b",
                messages: messages,
                response_format: zodResponseFormat(AgentActionSchema, "agent_action"),
                temperature: 0.2
            });
            result = completion.choices[0].message.parsed;
        } catch (parseErr: any) {
            // Structured output failed — fallback to raw completion + manual JSON extraction
            console.log(`${tabPrefix}Structured output failed, falling back to raw JSON extraction...`);
            
            const rawCompletion = await client.chat.completions.create({
                model: "openai/gpt-oss-120b",
                messages: messages,
                temperature: 0.2
            });
            
            const rawContent = rawCompletion.choices[0]?.message?.content || '';
            
            // Extract JSON from the response (it may be wrapped in markdown code blocks)
            const jsonMatch = rawContent.match(/\{[\s\S]*?"thought"[\s\S]*?"action"[\s\S]*?\}/);
            if (jsonMatch) {
                const parsed = JSON.parse(jsonMatch[0]);
                result = {
                    thought: parsed.thought || 'Fallback parse - no thought provided',
                    action: parsed.action || 'WAIT',
                    target_id: parsed.target_id ?? null,
                    text: parsed.text ?? null
                };
            }
        }
        
        if (!result) {
            console.log(`${tabPrefix}Could not parse LLM response. Defaulting to WAIT.`);
            return { actionType: "WAIT", newHistory: history };
        }

        console.log(`\n${tabPrefix}🧠 THOUGHT: ${result.thought}`);
        console.log(`${tabPrefix}⚡ ACTION: ${result.action} ` + 
            (result.target_id ? `[Target: ${result.target_id}]` : '') + 
            (result.text ? ` -> "${result.text}"` : ''));

        // 2. Execute Action Intelligently
        if (result.action === 'CLICK' && result.target_id) {
            await agentClick(page, result.target_id);
            await delay(3000); // Wait for UI transition
        } 
        else if (result.action === 'TYPE_AND_SUBMIT' && result.text) {
            // Find the textarea directly if target_id fails
            const targetId = result.target_id;
            if (targetId) {
                await agentType(page, targetId, result.text);
            } else {
                // Fallback: type directly into textarea
                await page.fill('textarea', result.text).catch(() => {});
            }
            await delay(500);
            
            // Submit: try Enter first, then explicit submit button click
            await page.keyboard.press('Enter');
            await page.evaluate(() => {
                // Find submit button by aria-label or by the arrow-up SVG icon
                const btn = document.querySelector('button[aria-label="Submit"]') as HTMLElement
                    || document.querySelector('button:has(svg.lucide-arrow-up)') as HTMLElement;
                if (btn) btn.click();
            });
            
            await delay(4000); // Wait for thinking state
        }
        else if (result.action === 'WAIT') {
             // System requested wait (e.g. Metaview is thinking)
             await delay(10000);
        }
        else if (result.action === 'REFRESH') {
            console.log(`${tabPrefix}Hard refreshing page...`);
            await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
            await delay(5000);
        }
        else if (result.action === 'EXTRACT_CANDIDATES') {
            console.log(`${tabPrefix}Preparing payload for database extraction...`);
        }

        // Add to history so it knows what it just did
        history.push({ role: "user", content: `CURRENT SCREEN STATE:\n\n${textMap}\n\nWhat is your next action?` });
        history.push({ role: "assistant", content: JSON.stringify(result) });
        
        // Keep history short (last 6 interactions = 3 pairs) to avoid massive context
        if (history.length > 6) {
           history = history.slice(-6);
        }

        return { actionType: result.action, newHistory: history };

    } catch (e) {
        console.error(`${tabPrefix}Error negotiating DOM:`, e);
        await delay(5000);
        return { actionType: "ERROR", newHistory: history };
    }
}
