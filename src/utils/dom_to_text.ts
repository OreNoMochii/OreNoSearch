import { Page } from 'playwright';

export interface DOMState {
    textRepresentation: string;
    interactiveElements: Map<number, { xpath: string; selector: string; elementId: number }>;
}

export async function captureDOMState(page: Page): Promise<{textMap: string, rawMap: any[]}> {
    return await page.evaluate(() => {
        // Clear previous agent tags
        document.querySelectorAll('[data-agent-id]').forEach(el => el.removeAttribute('data-agent-id'));

        let agentIdCounter = 1;
        const elementsMap: any[] = [];
        let domText = '--- VISUAL DOM MAP ---\n';

        function isVisible(el: Element): boolean {
            const style = window.getComputedStyle(el);
            return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0' && (el as HTMLElement).offsetWidth > 0;
        }

        // 1. Inputs & Textareas
        const inputs = document.querySelectorAll('input, textarea');
        inputs.forEach((el) => {
            if (!isVisible(el)) return;
            const id = agentIdCounter++;
            el.setAttribute('data-agent-id', id.toString());
            const placeholder = el.getAttribute('placeholder') || '';
            const val = (el as HTMLInputElement).value || '';
            domText += `[${id}] INPUT(type="${(el as HTMLInputElement).type}"): placeholder="${placeholder}" value="${val}"\n`;
            elementsMap.push({ id, type: 'input' });
        });

        // 2. Buttons & Links & Interactives
        const interactives = document.querySelectorAll('button, a, [role="button"]');
        interactives.forEach((el) => {
            if (!isVisible(el)) return;
            
            let text = (el as HTMLElement).innerText || '';
            text = text.replace(/\n/g, ' ').trim();
            const ariaLabel = el.getAttribute('aria-label') || '';
            const titleText = text.substring(0, 50) + (text.length > 50 ? '...' : '');
            
            // Skip empty interactives generally, unless they have aria-labels (like send button icons)
            if (!titleText && !ariaLabel) return;

            // Flag disabled elements so the LLM avoids them
            const isDisabled = (el as HTMLButtonElement).disabled || el.getAttribute('data-disabled') === 'true' || el.getAttribute('aria-disabled') === 'true';
            
            const id = agentIdCounter++;
            el.setAttribute('data-agent-id', id.toString());
            
            const disabledTag = isDisabled ? ' [DISABLED]' : '';
            
            if (el.tagName.toLowerCase() === 'a') {
                const href = (el as HTMLAnchorElement).href;
                domText += `[${id}] LINK: "${titleText}" (href="${href}") ${ariaLabel ? `(Aria: ${ariaLabel})` : ''}${disabledTag}\n`;
            } else {
                domText += `[${id}] BUTTON: "${titleText}" ${ariaLabel ? `(Aria: ${ariaLabel})` : ''}${disabledTag}\n`;
            }
            elementsMap.push({ id, type: 'button', disabled: isDisabled });
        });

        // 3. Relevant Text Context (Popups, "Thinking" states, Modal headers)
        // We look for divs with text that are relatively short to indicate system state, keeping noise down.
        const allTextNodes = document.querySelectorAll('div, p, span, h1, h2, h3');
        const textSnippets = new Set<string>();
        
        allTextNodes.forEach((el) => {
            if (!isVisible(el)) return;
            
            // Skip if it contains other major blocks to avoid duplication
            if (el.children.length > 2) return;
            
            const text = (el as HTMLElement).innerText || '';
            const tClean = text.replace(/\n/g, ' ').trim();
            
            // Log short, meaningful context strings
            if (tClean.length > 3 && tClean.length < 150) {
                 // Prevent overlapping text logs
                 if (!Array.from(textSnippets).some(s => s.includes(tClean))) {
                    textSnippets.add(tClean);
                 }
            }
        });

        if (textSnippets.size > 0) {
            domText += `\n--- ON-SCREEN CONTEXT TEXT ---\n`;
            Array.from(textSnippets).forEach(t => {
                domText += `"${t}"\n`;
            });
        }

        return { textMap: domText, rawMap: elementsMap };
    });
}

// Action Executor Helpers — resilient to stale DOM IDs
export async function agentClick(page: Page, elementId: number) {
    const selector = `[data-agent-id="${elementId}"]`;
    
    try {
        // First try: direct selector with short timeout
        const el = page.locator(selector);
        if (await el.count() > 0 && await el.isVisible().catch(() => false)) {
            await el.evaluate((node: HTMLElement) => node.click());
            return;
        }
    } catch (_) {
        // Element not found, try alternatives
    }
    
    // Second try: wait a bit for possible re-render
    try {
        await page.waitForSelector(selector, { timeout: 2000 });
        await page.evaluate((sel) => {
            const el = document.querySelector(sel) as HTMLElement;
            if (el) el.click();
        }, selector);
        return;
    } catch (_) {
        // Still not found — try fallback strategies
    }
    
    // Fallback: scan all data-agent-id elements for the closest match
    console.log(`[agentClick] Element [${elementId}] not found. Attempting fallback scan...`);
    const clicked = await page.evaluate((targetId: number) => {
        // Look for any interactive element near the expected ID
        for (let offset = -3; offset <= 3; offset++) {
            const nearId = targetId + offset;
            const el = document.querySelector(`[data-agent-id="${nearId}"]`) as HTMLElement;
            if (el && el.offsetWidth > 0) {
                el.click();
                return nearId;
            }
        }
        return null;
    }, elementId);
    
    if (clicked !== null) {
        console.log(`[agentClick] Fallback clicked nearby element [${clicked}] instead of [${elementId}]`);
    } else {
        console.log(`[agentClick] Could not find any element near [${elementId}]. Skipping click.`);
    }
}

export async function agentType(page: Page, elementId: number, text: string) {
    const selector = `[data-agent-id="${elementId}"]`;
    
    try {
        await page.waitForSelector(selector, { timeout: 3000 });
        await page.evaluate((sel) => {
            const el = document.querySelector(sel) as HTMLElement;
            if (el) el.focus();
        }, selector);
        await page.fill(selector, text);
        return;
    } catch (_) {
        // Fallback: find any visible textarea and type into it
        console.log(`[agentType] Element [${elementId}] not found. Falling back to first visible textarea.`);
        const textareaExists = await page.locator('textarea').count();
        if (textareaExists > 0) {
            await page.locator('textarea').first().focus();
            await page.fill('textarea', text);
        } else {
            console.log(`[agentType] No textarea found on page. Cannot type.`);
        }
    }
}
