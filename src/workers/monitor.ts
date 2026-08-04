import { Page } from 'playwright';
import { assignTabBadge, delay } from '../utils/dom';

export async function runMonitorWorker(page: Page) {
    const tabPrefix = '[Worker: Monitor] ';
    console.log(`${tabPrefix}Initializing Deterministic Monitor...`);
    
    await page.bringToFront().catch(() => {});
    await assignTabBadge(page, 'MONITOR (DETERMINISTIC)');

    while (true) {
        try {
            // Ensure sidebar is expanded to read routing DOM
            await ensureSidebarOpen(page);
            
            // Gather ALL chat URLs that are idle (contain "ago" = done processing)
            // The sidebar text never says "action needed" literally — actions are detected 
            // INSIDE the chat page via buttons like "I prefer this", "Looks good", etc.
            const targetUrls = await page.evaluate(() => {
                return Array.from(document.querySelectorAll('a'))
                    .filter(a => {
                        if (!/\/sourcing\/[0-9a-fA-F\-]{20,}/.test(a.href)) return false;
                        const text = (a.innerText || a.textContent || '').toLowerCase();
                        // Only visit chats that are idle (show "ago") or have "new candidates"
                        // Skip anything that is still thinking/evaluating/expanding
                        return (text.includes('ago') || text.includes('new candidates')) 
                            && !text.includes('thinking') 
                            && !text.includes('evaluating') 
                            && !text.includes('expanding');
                    })
                    .map(a => a.href.split('?')[0]);
            });
            const uniqueUrls = [...new Set(targetUrls)];
            
            if (uniqueUrls.length === 0) {
                 console.log(`${tabPrefix}No idle chats found in sidebar. All chats still processing.`);
            } else {
                 console.log(`${tabPrefix}Found ${uniqueUrls.length} idle chats to scan for actionable buttons.`);
            }

            for (const url of uniqueUrls) {
                const currentClean = page.url().split('?')[0];
                if (url !== currentClean) {
                    console.log(`${tabPrefix}Navigating to chat: ${url}`);
                    await page.goto(url).catch(() => console.log(`${tabPrefix}Navigation failed to ${url}`));
                    await delay(5000); // Wait for chat to load fully
                }
                
                // Search for actionable buttons inside the chat — use multiple strategies
                const clicked = await clickActionableButton(page, tabPrefix);

                if (clicked) {
                    console.log(`${tabPrefix}Action performed: "${clicked}" on chat: ${url}`);
                    await delay(3000); // Let UI settle after click
                }
                 
                // Brief pause between checking different chats (30 seconds)
                await delay(30000);
            }
        } catch (e) {
            console.log(`${tabPrefix}Error:`, e);
            await delay(10000); // Brief recovery delay
        }
        
        // Wait 2 to 5 minutes before running the full cycle again
        const cycleDelay = 120000 + Math.random() * 180000; 
        console.log(`${tabPrefix}Cycle complete. Sleeping for ${Math.floor(cycleDelay/60000)} minutes.`);
        await delay(cycleDelay); 
    }
}

/**
 * Clicks the first actionable (non-disabled) button matching known positive actions.
 * Uses Playwright's native click for proper event dispatch through React.
 */
async function clickActionableButton(page: Page, prefix: string): Promise<string | null> {
    const positiveTexts = ['i prefer this profile', 'i prefer this', 'looks good', 'select all'];
    
    // Strategy 1: Use page.evaluate to find non-disabled buttons/elements
    const buttonInfo = await page.evaluate((positiveTexts: string[]) => {
        const allInteractives = [
            ...Array.from(document.querySelectorAll('button')),
            ...Array.from(document.querySelectorAll('[role="button"]')),
            ...Array.from(document.querySelectorAll('div[data-react-aria-pressable]'))
        ];
        
        for (const el of allInteractives) {
            const text = (el.textContent || el.innerHTML || '').toLowerCase().trim();
            const isDisabled = (el as HTMLButtonElement).disabled 
                || el.getAttribute('data-disabled') === 'true' 
                || el.getAttribute('aria-disabled') === 'true';
            
            if (isDisabled) continue; // Skip disabled buttons
            
            for (const positive of positiveTexts) {
                if (text.includes(positive)) {
                    // Tag it so we can find it with Playwright
                    el.setAttribute('data-monitor-target', 'true');
                    return { found: true, text: positive };
                }
            }
        }
        return { found: false, text: null };
    }, positiveTexts);
    
    if (buttonInfo.found) {
        try {
            // Use Playwright's native click for proper React event dispatch
            const target = page.locator('[data-monitor-target="true"]').first();
            await target.click({ timeout: 5000 });
            // Clean up tag
            await page.evaluate(() => {
                document.querySelectorAll('[data-monitor-target]').forEach(el => el.removeAttribute('data-monitor-target'));
            });
            return buttonInfo.text;
        } catch (e) {
            console.log(`${prefix}Playwright click failed, trying evaluate() fallback...`);
            // Fallback: use evaluate click
            await page.evaluate(() => {
                const el = document.querySelector('[data-monitor-target="true"]') as HTMLElement;
                if (el) {
                    el.click();
                    el.removeAttribute('data-monitor-target');
                }
            });
            return buttonInfo.text;
        }
    }
    
    // Strategy 2: Check for text-based matches in any visible clickable element
    // This catches cases where buttons are styled as divs or spans
    const fallbackClick = await page.evaluate((positiveTexts: string[]) => {
        const allElements = Array.from(document.querySelectorAll('*'));
        for (const el of allElements) {
            const htmlEl = el as HTMLElement;
            // Must be a leaf-ish element (not a huge container)
            if (el.children.length > 3) continue;
            const text = (htmlEl.innerText || '').toLowerCase().trim();
            if (text.length > 100) continue;
            
            const isDisabled = htmlEl.getAttribute('disabled') !== null
                || htmlEl.getAttribute('data-disabled') === 'true';
            if (isDisabled) continue;
            
            for (const positive of positiveTexts) {
                if (text === positive || text.includes(positive)) {
                    // Check it's actually clickable (has cursor pointer or is a button/a)
                    const style = window.getComputedStyle(el);
                    const isClickable = style.cursor === 'pointer' 
                        || el.tagName === 'BUTTON' 
                        || el.tagName === 'A'
                        || el.getAttribute('role') === 'button'
                        || el.closest('button') !== null;
                    
                    if (isClickable) {
                        htmlEl.click();
                        return positive;
                    }
                }
            }
        }
        return null;
    }, positiveTexts);
    
    return fallbackClick;
}

async function ensureSidebarOpen(page: Page) {
    const opened = await page.evaluate(() => {
        const hasSourcingLinks = Array.from(document.querySelectorAll('a')).some(a => a.href.includes('/sourcing/'));
        if (!hasSourcingLinks) {
            // Try multiple sidebar toggle patterns
            const toggleBtn = document.querySelector('svg.lucide-panel-left')?.closest('button') as HTMLButtonElement | null;
            if (toggleBtn) {
                toggleBtn.click();
                return true;
            }
            // Fallback: look for any sidebar toggle button
            const sidebarToggle = document.querySelector('[aria-label*="sidebar"]') as HTMLButtonElement | null
                || document.querySelector('[aria-label*="menu"]') as HTMLButtonElement | null;
            if (sidebarToggle) {
                sidebarToggle.click();
                return true;
            }
        }
        return false;
    });
    if (opened) {
        await delay(2000); // Extra time for sidebar animation
    } else {
        await delay(500);
    }
}
