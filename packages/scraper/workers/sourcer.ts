import { Page } from 'playwright';
import { assignTabBadge, delay } from '../utils/dom';
import { runAgentCycle } from '../core/agent_loop';

export async function runSourcerWorker(page: Page) {
    const tabPrefix = '[Agent: Sourcer] ';
    console.log(`${tabPrefix}Initializing Autonomous Agent...`);
    
    await page.bringToFront().catch(() => {});
    await assignTabBadge(page, 'SOURCER (AGENT)');

    let history: any[] = [];
    
    const persona = `
You are the "Sourcer" AI Agent for Metaview. 
Your singular goal is to generate unique, varied tech/corporate roles and search for them.
RULES:
1. TOP PRIORITY: If Metaview asks you for feedback at any time, find a positive feedback button like "Select all", "Looks good", or "I prefer this profile" and use the CLICK action on it. DO NOT start a new search until this is handled. NEVER click a button marked [DISABLED].
2. Look at the sidebar links to see what roles have already been searched. NEVER search for a role that is already there.
3. If there is no pending feedback on the screen, and you are not on a "New Search" screen, CLICK the "New search" button or link.
4. Once you are on a fresh chat input, you MUST type exactly this phrase:
   "propose 200 candidates living in greater tokyo area for [UNIQUE ROLE]"
   (Replace [UNIQUE ROLE] with a highly realistic, in-demand title in current market conditions. Strictly prioritize high-salary, senior leadership, or C-level roles like 'Chief Technology Officer', 'VP of Engineering', 'Chief AI Officer', or 'Director of Cybersecurity'.)
   Then choose TYPE_AND_SUBMIT.
5. If Metaview says "Metaview is thinking", "Generating", or "Waiting", you MUST choose the WAIT action.
6. Only interact with elements that exist in the VISUAL DOM MAP. NEVER guess element IDs — only use [ID] numbers you see in the current map.
    `;

    while (true) {
        console.log(`${tabPrefix}Parsing DOM and asking LLM for next move...`);
        
        try {
            const { actionType, newHistory } = await runAgentCycle(page, persona, history, tabPrefix);
            history = newHistory;
            
            if (actionType === 'TYPE_AND_SUBMIT') {
                const randomWaitMs = 480000 + Math.random() * 420000; // 8 to 15 minutes
                console.log(`${tabPrefix}Successfully submitted new search prompt. Cooling down for ${Math.floor(randomWaitMs/60000)} minutes...`);
                await delay(randomWaitMs); 
            } else if (actionType === 'CLICK') {
                console.log(`${tabPrefix}Clicked target UI element. Waiting for UI to settle...`);
                await delay(5000); 
            } else if (actionType === 'ERROR') {
                console.log(`${tabPrefix}Error occurred. Recovering...`);
                // On error, clear history to avoid compounding bad context
                history = [];
                await delay(10000);
            } else {
                // WAIT or other — polling gap
                await delay(15000);
            }
        } catch (err: any) {
            console.log(`${tabPrefix}Unexpected error in agent cycle: ${err.message}`);
            history = []; // Reset history on crash
            await delay(15000);
        }
    }
}
