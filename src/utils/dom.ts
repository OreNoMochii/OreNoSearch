import { Page } from 'playwright';

export const delay = (time: number) => new Promise(resolve => setTimeout(resolve, time));

export async function typeWithHumanBehavior(page: Page, selector: string, text: string) {
    try {
        await page.focus(selector);
        await page.type(selector, text, { delay: 50 });
    } catch (error) {
        console.error("Error during human-like typing:", error);
        // Fallback to fast typing
        await page.fill(selector, text);
    }
}

/**
 * Common Metaview DOM actions
 */
export async function submitPrompt(page: Page, prompt: string, tabPrefix: string = '') {
    const textareaSelector = 'textarea';
    await page.waitForSelector(textareaSelector, { timeout: 10000 });
    
    console.log(`${tabPrefix}Entering query: "${prompt}"`);
    await page.click(textareaSelector);
    await page.keyboard.press('Control+A'); 
    await page.keyboard.press('Meta+A');
    await page.keyboard.press('Backspace');
    
    await typeWithHumanBehavior(page, textareaSelector, prompt);
    await delay(Math.random() * 500 + 500); 

    const submitButtonSelector = 'button[aria-label="Submit"], button:has(svg.lucide-arrow-up)';
    await page.click(submitButtonSelector);
    console.log(`${tabPrefix}Query submitted. Waiting...`);
}

export async function assignTabBadge(page: Page, agentName: string) {
    await page.evaluate((name) => {
        const existing = document.getElementById('metaview-agent-badge');
        if (existing) existing.remove();

        const div = document.createElement('div');
        div.id = 'metaview-agent-badge';
        div.style.position = 'fixed';
        div.style.top = '10px';
        div.style.right = '10px';
        div.style.background = 'rgba(0, 0, 0, 0.9)';
        div.style.color = '#00FF00';
        div.style.padding = '15px';
        div.style.zIndex = '999999';
        div.style.borderRadius = '8px';
        div.style.fontWeight = 'bold';
        div.style.boxShadow = '0 4px 15px rgba(0,255,0,0.3)';
        div.style.border = '2px solid #00FF00';
        
        div.innerText = `🤖 [${name}] IS ACTIVE`;
        
        // Setup an interval to enforce the page title since React SPAs tend to overwrite it
        const win = window as any;
        if (!win.metaviewBadgeInterval) {
            win.metaviewBadgeInterval = setInterval(() => {
                const titlePrefix = `🤖 [${name}] IS ACTIVE | `;
                if (!document.title.startsWith(titlePrefix)) {
                    document.title = titlePrefix + document.title.replace(/🤖 \[.*?\] IS ACTIVE \| /, '');
                }
                
                // Keep the UI badge alive
                if (!document.getElementById('metaview-agent-badge')) {
                     document.body.appendChild(div);
                }
            }, 1000);
        }
    }, agentName).catch(() => {});
}
