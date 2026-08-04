import { Page } from 'playwright';
import { assignTabBadge, delay, typeWithHumanBehavior } from '../utils/dom';
import { stateManager } from '../core/state';

export async function runAwakenerWorker(page: Page) {
    const tabPrefix = '[Worker: Awakener] ';
    console.log(`${tabPrefix}Initializing Deterministic Awakener...`);
    
    await page.bringToFront().catch(() => {});
    await assignTabBadge(page, 'AWAKENER (DETERMINISTIC)');

    while (true) {
        try {
            // Ensure sidebar is expanded
            await ensureSidebarOpen(page);
            
            // Find dormant chats: those with "ago" in their text, meaning they're idle
            const targetUrls = await page.evaluate(() => {
                return Array.from(document.querySelectorAll('a'))
                    .filter(a => {
                        if (!/\/sourcing\/[0-9a-fA-F\-]{20,}/.test(a.href)) return false;
                        const text = (a.innerText || a.textContent || '').toLowerCase();
                        return text.includes('ago') 
                            && !text.includes('thinking') 
                            && !text.includes('new candidates') 
                            && !text.includes('evaluating') 
                            && !text.includes('expanding');
                    })
                    .map(a => a.href.split('?')[0]);
            });
            const uniqueUrls = [...new Set(targetUrls)];
            
            // Randomize to avoid always hitting the same chats first
            uniqueUrls.sort(() => 0.5 - Math.random());

            console.log(`${tabPrefix}Found ${uniqueUrls.length} dormant chats to check.`);

            let awakenedOne = false;

            for (const url of uniqueUrls) {
                // Allow up to 4 expansions per chat
                if (!stateManager.canExpand(url, 4)) continue;
                
                const currentClean = page.url().split('?')[0];
                if (url !== currentClean) {
                    console.log(`${tabPrefix}Navigating to dormant chat: ${url}`);
                    await page.goto(url).catch(() => {});
                    await delay(5000);
                }
                
                // Check if it's currently thinking — leave it alone
                const isThinking = await page.evaluate(() => {
                    const allHtml = (document.body.innerText || '').toLowerCase();
                    return allHtml.includes('metaview is thinking') || allHtml.includes('generating');
                });
                
                if (isThinking) {
                    console.log(`${tabPrefix}Chat is still thinking. Skipping.`);
                    continue;
                }

                // Look for textarea to send the "propose 200 unique candidates" message
                const textareaCount = await page.locator('textarea').count();
                
                if (textareaCount > 0) {
                    await page.click('textarea');
                    await page.keyboard.press('Control+A'); 
                    await page.keyboard.press('Meta+A');
                    await page.keyboard.press('Backspace');
                    
                    await typeWithHumanBehavior(page, 'textarea', "propose 200 unique candidates");
                    await delay(1000); 
                    
                    // Submit via Enter + explicit button click
                    await page.keyboard.press('Enter');
                    await delay(500);
                    await page.evaluate(() => {
                        const btn = document.querySelector('button[aria-label="Submit"]') as HTMLButtonElement
                            || document.querySelector('button:has(svg.lucide-arrow-up)') as HTMLButtonElement;
                        if (btn) btn.click();
                    });
                    
                    stateManager.recordExpansion(url);
                    console.log(`${tabPrefix}Dormant chat awoken: ${url}`);
                    
                    // Wait 5 to 8 minutes before trying another chat
                    const wakeWait = 300000 + Math.random() * 180000;
                    console.log(`${tabPrefix}Taking a ${Math.floor(wakeWait/60000)} minute break...`);
                    await delay(wakeWait);
                    awakenedOne = true;
                    break; 
                } else {
                    console.log(`${tabPrefix}No textarea found at ${url}. Skipping.`);
                }

                // Brief pause between checking different chats
                await delay(5000);
            }

            if (!awakenedOne) {
                console.log(`${tabPrefix}No dormant chats available to awaken.`);
            }

        } catch (e) {
             console.log(`${tabPrefix}Error:`, e);
             await delay(10000);
        }
        
        // Wait 10 to 15 minutes before restarting
        const cycleDelay = 600000 + Math.random() * 300000; 
        console.log(`${tabPrefix}Cycle complete. Sleeping for ${Math.floor(cycleDelay/60000)} minutes.`);
        await delay(cycleDelay); 
    }
}

async function ensureSidebarOpen(page: Page) {
    await page.evaluate(() => {
        const hasSourcingLinks = Array.from(document.querySelectorAll('a')).some(a => a.href.includes('/sourcing/'));
        if (!hasSourcingLinks) {
            const toggleBtn = document.querySelector('svg.lucide-panel-left')?.closest('button') as HTMLButtonElement | null;
            if (toggleBtn) toggleBtn.click();
        }
    });
    await delay(1500);
}
