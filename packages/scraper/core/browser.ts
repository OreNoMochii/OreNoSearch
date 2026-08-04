import { chromium } from 'playwright-extra';
import { Page, Browser } from 'playwright';
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

// @ts-ignore
chromium.use(StealthPlugin());

export async function connectToBrowser(): Promise<{ browser: Browser, sourcingPages: Page[] }> {
    console.log(`Connecting to remote browser...`);
    const browser = await chromium.connectOverCDP('http://localhost:9222');
    const contexts = browser.contexts();
    const pages: Page[] = [];
    
    for (const ctx of contexts) {
        pages.push(...ctx.pages());
    }
    
    const sourcingPages = pages.filter(p => p.url().includes('metaview.app/sourcing'));
    
    if (sourcingPages.length < 4) {
        throw new Error(`Insufficient Metaview sourcing tabs found. Expected at least 4 tabs. Found: ${sourcingPages.length}`);
    }

    return { browser, sourcingPages };
}
