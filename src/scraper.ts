/**
 * Metaview Stealth Scraper (TypeScript)
 * Interacts with the sourcing chatbot and retrieves candidates.
 */

import { chromium } from 'playwright-extra';
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
import { delay, typeWithHumanBehavior } from './utils';
import { initDb, saveCandidate, Candidate, getAllCandidateNames } from './database';
import fs from 'fs';
import path from 'path';
import parseArgs from 'minimist';

// @ts-ignore
chromium.use(StealthPlugin());

interface ScraperOptions {
  mode: 'full' | 'extract' | 'analyze' | 'upgrade';
  query?: string;
  tab?: number;
  list?: boolean;
  limit?: number;
  enrichOnly?: boolean;
}

async function runScraper(options: ScraperOptions) {
  const { mode, query, tab, list } = options;

  if (list) {
      try {
          const resp = await fetch('http://127.0.0.1:9222/json/list');
          const data = await resp.json() as any[];
          const sourcingPages = data.filter((p: any) => p.type === 'page' && p.url.includes('metaview.app/sourcing'));
          
          if (sourcingPages.length === 0) {
              console.log('No Metaview sourcing tabs found.');
              return;
          }
          
          console.log('\n--- Discovered Metaview Tabs ---');
          for (let i = 0; i < sourcingPages.length; i++) {
              console.log(`[Tab ${i}] "${sourcingPages[i].title || 'Untitled'}"`);
              console.log(`      URL: ${sourcingPages[i].url}`);
          }
          console.log('-------------------------------\n');
          console.log('Listing complete. Exiting.');
          return;
      } catch (err: any) {
          console.log(`Failed to fetch tab list via CDP HTTP API: ${err.message}. Falling back to connection...`);
      }
  }

  console.log(`Connecting to remote browser...`);
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const contexts = browser.contexts();
  const pages: any[] = [];
  
  for (const ctx of contexts) {
      pages.push(...ctx.pages());
  }
  
  const sourcingPages = pages.filter(p => p.url().includes('metaview.app/sourcing'));
  
  if (sourcingPages.length === 0) {
      console.log('No Metaview sourcing tabs found.');
      await browser.close();
      return;
  }

  // Identify tabs for the user
  console.log('\n--- Discovered Metaview Tabs ---');
  for (let i = 0; i < sourcingPages.length; i++) {
      const title = await sourcingPages[i].title().catch(() => 'Untitled');
      const url = sourcingPages[i].url();
      console.log(`[Tab ${i}] "${title}"`);
      console.log(`      URL: ${url}`);
  }
  console.log('-------------------------------\n');

  if (list) {
      console.log('Listing complete. Exiting.');
      await browser.close();
      return;
  }

  if (mode === 'analyze') {
      console.log('--- Analyzing DOM Structure ---');
      const analysisData: any[] = [];
      for (let i = 0; i < sourcingPages.length; i++) {
          const page = sourcingPages[i];
          await page.bringToFront().catch(() => {});
          await delay(1000);
          const data = await page.evaluate(() => {
              const links = Array.from(document.querySelectorAll('a')).map(a => ({ href: a.href, text: a.innerText, className: a.className }));
              const buttons = Array.from(document.querySelectorAll('button')).map(b => ({ text: b.innerText, className: b.className, aria: b.getAttribute('aria-label') }));
              const textareas = Array.from(document.querySelectorAll('textarea')).map(t => ({ placeholder: t.getAttribute('placeholder'), className: t.className }));
              const divs = Array.from(document.querySelectorAll('div')).filter(d => (d.innerText || '').length > 0 && (d.innerText || '').length < 100).map(d => ({ text: d.innerText, className: d.className }));
              return { url: window.location.href, links, buttons, textareas, uniqueDivsSnippet: divs.slice(0, 50) };
          });
          analysisData.push(data);
          console.log(`Analyzed Tab ${i}`);
      }
      fs.writeFileSync('dom_analysis.json', JSON.stringify(analysisData, null, 2));
      console.log('Analysis saved to dom_analysis.json. Exiting.');
      await browser.close();
      return;
  }

  await initDb();
  
  try {
    const page = tab !== undefined ? sourcingPages[tab] : sourcingPages[0];
    console.log(`Starting extraction on: "${await page.title()}"`);
    
    await page.bringToFront().catch(() => {});
    // Visual indicator in the browser
    await page.evaluate(() => {
            const div = document.createElement('div');
            div.id = 'ai-agent-badge';
            div.style.position = 'fixed';
            div.style.top = '10px';
            div.style.right = '10px';
            div.style.background = 'rgba(255, 0, 0, 0.9)';
            div.style.color = 'white';
            div.style.padding = '15px';
            div.style.zIndex = '999999';
            div.style.borderRadius = '8px';
            div.style.fontWeight = 'bold';
            div.style.boxShadow = '0 4px 15px rgba(0,0,0,0.3)';
            div.style.border = '2px solid white';
            div.innerText = `🚀 SCRAPER ACTIVE`;
            document.body.appendChild(div);
            // Lock via window object to prevent React SPA from purging the DOM lock
            // @ts-ignore
            window._aiAgentBusy = true;
        }).catch(() => {});

        await delay(1500); 

        if (mode === 'full' && query) {
            const textareaSelector = 'textarea';
            await page.waitForSelector(textareaSelector, { timeout: 10000 });
            
            console.log(`Entering query: "${query}"`);
            await page.click(textareaSelector);
            await page.keyboard.press('Control+A'); 
            await page.keyboard.press('Meta+A');
            await page.keyboard.press('Backspace');
            
            await typeWithHumanBehavior(page, textareaSelector, query);
            await delay(Math.random() * 500 + 500); 

            const submitButtonSelector = 'button[aria-label="Submit"], button:has(svg.lucide-arrow-up)';
            await page.click(submitButtonSelector);
            console.log(`Query submitted. Waiting...`);
            
            await waitForResults(page);
        }

        if (mode === 'upgrade') {
            const allNames = await getAllCandidateNames(options.limit);
            if (sourcingPages.length === 1 || tab !== undefined) {
                const targetPage = tab !== undefined ? sourcingPages[tab] : sourcingPages[0];
                await runUpgradePipeline(targetPage, allNames, tab || 0);
            } else {
                console.log(`\n🚀 Parallel Mode: Splitting ${allNames.length} candidates across ${sourcingPages.length} tabs...`);
                const chunkSize = Math.ceil(allNames.length / sourcingPages.length);
                const promises = [];
                for (let i = 0; i < sourcingPages.length; i++) {
                    const page = sourcingPages[i];
                    await page.bringToFront().catch(() => {});
                    const chunk = allNames.slice(i * chunkSize, (i + 1) * chunkSize);
                    promises.push(runUpgradePipeline(page, chunk, i));
                }
                await Promise.all(promises);
            }
        } else {
            await scrollAndExtract(page, 'candidates_upgraded', tab, false, options.enrichOnly);
        }
        console.log(`Extraction complete.`);
    } catch (error: any) {
        console.error(`Error: ${error.message}`);
    }

  console.log('Closing browser connection.');
  await browser.close();
}

async function waitForResults(page: any) {
  console.log(`Waiting for results to load...`);
  const resultButtonSelector = 'button:has-text("I prefer this profile")';
  const resultPackSelector = 'div:has-text("Candidate Pack")';
  
  const maxRetries = 60;
  for (let i = 0; i < maxRetries; i++) {
        const hasPack = await page.locator(resultPackSelector).count().catch(() => 0) > 0;
        const hasProfiles = await page.locator(resultButtonSelector).count().catch(() => 0) > 0;
        const isRuminating = await page.locator('text=Ruminating').count().catch(() => 0) > 0;
      
      if ((hasPack || hasProfiles) && !isRuminating) {
          console.log(`Results or Pack detected and rumination finished!`);
          await delay(2000); // Buffer
          return;
      }
      await delay(3000);
      if (i % 5 === 0) console.log(`Still waiting for results... (${i * 3}s)`);
  }
}

/**
 * Extract emails by hovering over mail icon buttons.
 * Dispatches synthetic pointer events to trigger React Aria tooltips,
 * then reads the email from the [role="tooltip"] element.
 * 
 * Matching strategy: Uses spatial proximity (vertical distance) between
 * mail buttons and LinkedIn links rather than DOM ancestry, since the
 * buttons and links may live in separate DOM branches of the same card row.
 * 
 * Returns a Map of LinkedIn profile URL → email address.
 */
async function extractEmailsViaHover(page: any, alreadyExtractedEmails: Set<string>): Promise<Map<string, string>> {
    // Step 1: Find all mail buttons with state-filled and their positions,
    // plus all LinkedIn links and their positions — match by closest vertical distance
    const mailButtonInfo = await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('button'));
        const mailBtns = buttons.filter(b => {
            const svg = b.querySelector('svg.lucide-mail, svg.lucide.lucide-mail');
            // Only consider buttons that are actually on screen or very close to it
            if (!svg || !b.className.includes('state-filled')) return false;
            const rect = b.getBoundingClientRect();
            return rect.y > -100 && rect.y < window.innerHeight + 100;
        });

        // Collect all LinkedIn links and their vertical positions
        const allLinkedInLinks = Array.from(document.querySelectorAll('a[href*="linkedin.com"]'));
        const linkPositions = allLinkedInLinks.map(link => ({
            url: (link as HTMLAnchorElement).href,
            centerY: link.getBoundingClientRect().y + link.getBoundingClientRect().height / 2,
        }));

        return mailBtns.map(btn => {
            const btnRect = btn.getBoundingClientRect();
            const btnCenterY = btnRect.y + btnRect.height / 2;
            const btnCenterX = btnRect.x + btnRect.width / 2;

            // Find the closest LinkedIn link by vertical distance
            let closestUrl: string | null = null;
            let closestDist = Infinity;
            for (const lp of linkPositions) {
                const dist = Math.abs(btnCenterY - lp.centerY);
                if (dist < closestDist) {
                    closestDist = dist;
                    closestUrl = lp.url;
                }
            }

            return {
                id: btn.id,
                linkedinUrl: closestUrl,
                btnX: Math.round(btnCenterX),
                btnY: Math.round(btnCenterY),
                matchDist: Math.round(closestDist),
            };
        }).filter((info: any) => info.id && info.linkedinUrl && info.matchDist < 500);
    });

    if (mailButtonInfo.length > 0) {
        console.log(`  📧 Found ${mailButtonInfo.length} visible mail button(s) to inspect:`);
        for (const info of mailButtonInfo) {
            console.log(`     btn@y=${info.btnY} → ${info.linkedinUrl} (dist=${info.matchDist}px)`);
        }
    }

    const emailMap = new Map<string, string>();

    for (const info of mailButtonInfo) {
        // Skip if we already extracted or inspected this candidate
        if (alreadyExtractedEmails.has(info.linkedinUrl)) continue;
        alreadyExtractedEmails.add(info.linkedinUrl); // Track immediately to prevent infinite loops!

        // CLICK approach: Click the mail button to open the contact details dialog.
        const btnLocator = page.locator(`[id="${info.id}"]`);
        if (await btnLocator.count() === 0) continue;

        await btnLocator.scrollIntoViewIfNeeded();
        await delay(300);
        await btnLocator.click({ force: true });

        // Wait for dialog to render
        await delay(1000);

        // Read emails from VISIBLE listbox options using Playwright locator
        const optionsLocator = page.locator('[role="option"][data-key]');
        const count = await optionsLocator.count();
        let email: string | null = null;
        for (let i = 0; i < count; i++) {
            if (await optionsLocator.nth(i).isVisible().catch(() => false)) {
                const key = await optionsLocator.nth(i).getAttribute('data-key');
                if (key && key.includes('@')) {
                    email = key;
                    break;
                }
            }
        }

        // Close the dialog by pressing Escape
        await page.keyboard.press('Escape');
        await delay(500);

        if (email && info.linkedinUrl) {
            emailMap.set(info.linkedinUrl, email);
            console.log(`     ✉ ${email} → ${info.linkedinUrl.split('/in/')[1] || info.linkedinUrl}`);
        }
    }

    return emailMap;
}


/**
 * Parse the innerText of a detail panel into structured candidate data.
 * Converts the detail panel's format (en dashes, dot separators) into
 * the format expected by the ML pipeline (arrows, parenthesized durations).
 */
function parseDetailPanelText(panelText: string): {
  name: string; location: string; headline: string; summary: string;
  experience: string; education: string; current_company: string; latest_role: string;
} {
  const rawLines = panelText.split('\n').map(l => l.trim()).filter(l => l.length > 0);

  // Remove UI noise
  const noiseExact = new Set([
    'Prev', 'Next', 'J', 'K', 'Y', 'M', 'N', 'Yes', 'Maybe', 'No',
    'IS THIS CANDIDATE A GOOD FIT?',
    "Save this candidate, or let us know why they aren't a match.",
    'No email selected', 'No phone selected'
  ]);
  const lines = rawLines.filter(l => !noiseExact.has(l));

  const name = lines[0] || 'Unknown';

  // Find section boundaries
  const summaryIdx = lines.findIndex(l => l === 'Summary');
  const careerIdx = lines.findIndex(l => /^Career(\s*\(\d+\))?$/.test(l));
  const educationIdx = lines.findIndex(l => /^Education(\s*\(\d+\))?$/.test(l));
  const contactIdx = lines.findIndex(l => l === 'Contact information');

  // Location: between name and first section
  let location = '';
  const validSections = [summaryIdx, careerIdx, educationIdx, contactIdx].filter(i => i > 0);
  const firstSection = validSections.length > 0 ? Math.min(...validSections) : lines.length;
  for (let i = 1; i < Math.min(firstSection, 5); i++) {
    const l = lines[i];
    if (l && l.length > 3 && l.length < 100) { location = l; break; }
  }

  // Section end helper
  const sectionEnd = (startIdx: number): number => {
    const later = [careerIdx, educationIdx, contactIdx, lines.length].filter(i => i > startIdx);
    return later.length > 0 ? Math.min(...later) : lines.length;
  };

  // Date patterns
  const expDatePattern = /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{4}\s+[–\-]\s+(Now|(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{4})/;
  const eduDatePattern = /^(?:(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+)?\d{4}\s+[–\-]\s+(?:(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+)?\d{4}/;

  // Convert date format: "May 2024 – Now · 2 yrs, 1 mth" → "May 2024 → Now (2 yrs 1 mo)"
  const convertDate = (dateStr: string): string => {
    let fmt = dateStr.replace(/\s*–\s*/g, ' → ');
    const durMatch = fmt.match(/·\s*(.+)$/);
    if (durMatch) {
      const dur = durMatch[1].replace(/,\s*/g, ' ').replace(/mths?/g, 'mos');
      fmt = fmt.replace(/\s*·\s*.+$/, ` (${dur.trim()})`);
    }
    return fmt;
  };

  // Parse entries from a section using date lines as anchors.
  // For each date line: 2 lines before = line1 (role/school), 1 line before = line2 (company/degree)
  const parseEntries = (sectionLines: string[], dateRegex: RegExp) => {
    // Filter out "See X more" expand buttons and "See less" collapse buttons
    const filtered = sectionLines.filter(l => !/^See \d+ more$/.test(l) && !/^See less$/.test(l));
    const dateIndices: number[] = [];
    for (let i = 0; i < filtered.length; i++) {
      if (dateRegex.test(filtered[i])) dateIndices.push(i);
    }

    const entries: Array<{line1: string, line2: string, dateStr: string, description: string}> = [];
    for (let d = 0; d < dateIndices.length; d++) {
      const di = dateIndices[d];
      const line1 = di >= 2 ? filtered[di - 2] : (di >= 1 ? filtered[di - 1] : '');
      const line2 = di >= 2 ? filtered[di - 1] : '';
      const dateStr = filtered[di];

      let descEnd: number;
      if (d + 1 < dateIndices.length) {
        descEnd = dateIndices[d + 1] - 2;
      } else {
        descEnd = filtered.length;
      }
      const descLines = filtered.slice(di + 1, Math.max(di + 1, descEnd));
      entries.push({ line1, line2, dateStr, description: descLines.join('\n') });
    }
    return entries;
  };

  // --- Summary ---
  let summary = '';
  if (summaryIdx >= 0) {
    summary = lines.slice(summaryIdx + 1, sectionEnd(summaryIdx)).join('\n');
  }

  // --- Career / Experience ---
  let experience = '';
  let current_company = '';
  let latest_role = '';
  let headline = '';

  if (careerIdx >= 0) {
    const careerLines = lines.slice(careerIdx + 1, sectionEnd(careerIdx));

    // Skip stats section (Current tenure / Avg tenure / Total experience + values)
    let totalExp = '';
    let statsEnd = 0;
    // Stats labels appear in all-caps in the Metaview detail panel
    const statsLabelsNorm = ['current tenure', 'avg tenure', 'total experience'];
    for (let i = 0; i < careerLines.length; i++) {
      const lineNorm = careerLines[i].toLowerCase();
      if (statsLabelsNorm.includes(lineNorm)) {
        if (lineNorm === 'total experience' && i + 1 < careerLines.length) {
          totalExp = careerLines[i + 1];
        }
        statsEnd = i + 2;
      }
    }

    const entries = parseEntries(careerLines.slice(statsEnd), expDatePattern);

    const expParts: string[] = [];
    if (totalExp) {
      expParts.push(totalExp.replace(/,\s*/g, ' ').replace(/mths?/g, 'mos'));
    }

    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      // Detail panel order: Role (line1), Company (line2)
      // Expected output order: Company, then ↳ Role
      if (e.line2) expParts.push(e.line2);
      if (e.line1) expParts.push(`↳ ${e.line1}`);
      expParts.push(convertDate(e.dateStr));
      if (e.description) expParts.push(e.description);

      if (i === 0) {
        current_company = e.line2;
        latest_role = e.line1;
        headline = e.line1;
      }
    }
    experience = expParts.join('\n');
  }

  // --- Education ---
  let education = '';
  if (educationIdx >= 0) {
    const eduEnd = contactIdx >= 0 ? contactIdx : lines.length;
    const eduLines = lines.slice(educationIdx + 1, eduEnd);
    const entries = parseEntries(eduLines, eduDatePattern);

    const eduParts: string[] = [];
    for (const e of entries) {
      if (e.line1) eduParts.push(e.line1);
      if (e.line2) eduParts.push(`↳ ${e.line2}`);
      eduParts.push(convertDate(e.dateStr));
      if (e.description) eduParts.push(e.description);
    }
    education = eduParts.join('\n');
  }

  return { name, location, headline, summary, experience, education, current_company, latest_role };
}

/**
 * Extract rich candidate data from the currently open detail panel.
 * Expands collapsed sections, extracts innerText, and parses it.
 */
async function extractFromDetailPanel(page: any): Promise<{
  name: string; profile_url: string; location: string; headline: string;
  summary: string; experience: string; education: string;
  current_company: string; latest_role: string;
} | null> {
  try {
    // Scroll the detail panel to the bottom to trigger lazy loading
    await page.evaluate(async () => {
      const closeBtn = document.querySelector('button[aria-label="Close"]');
      if (closeBtn) {
        let panel: HTMLElement | null = closeBtn as HTMLElement;
        for (let i = 0; i < 15; i++) {
          panel = panel?.parentElement || null;
          if (!panel) break;
          const style = window.getComputedStyle(panel);
          if (panel.scrollHeight > panel.clientHeight && (style.overflowY === 'auto' || style.overflowY === 'scroll')) {
             for (let j = 0; j < 10; j++) {
               panel.scrollTop += 800;
               await new Promise(r => setTimeout(r, 150));
             }
             panel.scrollTop = 0; // Scroll back to top
             break;
          }
        }
      }
    });
    await delay(500);

    // Expand "See X more" buttons in the detail panel
    const seeMoreBtns = page.locator('button:has-text("See"):has-text("more")');
    for (let i = 0; i < await seeMoreBtns.count(); i++) {
      try {
        if (await seeMoreBtns.nth(i).isVisible()) {
          await seeMoreBtns.nth(i).scrollIntoViewIfNeeded();
          await seeMoreBtns.nth(i).click();
          await delay(600);
        }
      } catch {}
    }
    await delay(300);

    // Get panel innerText and LinkedIn URL specifically from the detail panel
    
    // Wait for DOM to stabilize (wait out framer-motion/CSS transitions)
    let previousText = '';
    let stableCount = 0;
    for (let i = 0; i < 15; i++) {
      const currentText = await page.evaluate(() => {
        const closeBtn = document.querySelector('button[aria-label="Close"]');
        if (!closeBtn) return '';
        let p: HTMLElement | null = closeBtn as HTMLElement;
        for (let j = 0; j < 15; j++) {
          p = p?.parentElement || null;
          if (!p) break;
          if (p.querySelectorAll('section').length >= 1) break;
        }
        return p ? p.innerText : '';
      });
      if (currentText === previousText && currentText.length > 0) {
        stableCount++;
        if (stableCount >= 2) break; // Stable for at least 600ms
      } else {
        stableCount = 0;
      }
      previousText = currentText;
      await delay(300);
    }

    const detailData = await page.evaluate(() => {
      const closeBtn = document.querySelector('button[aria-label="Close"]');
      if (!closeBtn) return { text: '', url: '' };
      let panel: HTMLElement | null = closeBtn as HTMLElement;
      for (let i = 0; i < 15; i++) {
        panel = panel?.parentElement || null;
        if (!panel) break;
        if (panel.querySelectorAll('section').length >= 1) break;
      }
      if (!panel) return { text: '', url: '' };
      
      const lnk = panel.querySelector('a[aria-label="View LinkedIn profile"]');
      return { 
        text: panel.innerText || '', 
        url: lnk ? (lnk as HTMLAnchorElement).href : '' 
      };
    });

    if (!detailData.text) return null;
    const parsed = parseDetailPanelText(detailData.text);
    return { ...parsed, profile_url: detailData.url };
  } catch (err: any) {
    console.log(`    Detail extraction error: ${err.message}`);
    return null;
  }
}

/**
 * Phase 2: Click through all candidates via the detail panel's Next navigation.
 * Opens the first candidate's detail, extracts rich data, navigates Next, repeats.
 */
async function clickThroughDetailPanels(page: any, emailMap: Map<string, string>, targetTable: string = 'candidates', tabIndex?: number) {
  const log = (msg: string) => console.log(tabIndex !== undefined ? `[Tab ${tabIndex}] ${msg}` : msg);

  log('\n--- Phase 2: Enriching candidates via detail panels ---');

  // Scroll list container back to top so the first card is visible
  await page.evaluate(() => {
    const containers = Array.from(document.querySelectorAll('*')).filter(el => {
      const style = window.getComputedStyle(el);
      return (el as HTMLElement).scrollHeight > (el as HTMLElement).clientHeight + 10 &&
             (style.overflowY === 'auto' || style.overflowY === 'scroll');
    });
    for (const c of containers) (c as HTMLElement).scrollTop = 0;
  });
  await delay(1000);

  // Click the first candidate card name to open the detail panel
  let panelOpened = false;
  for (let attempt = 0; attempt < 2 && !panelOpened; attempt++) {
      const nameElHandle = await page.evaluateHandle(() => {
          const linkedinLinks = Array.from(document.querySelectorAll('a[href*="linkedin.com"]'));
          for (const link of linkedinLinks) {
              let container: HTMLElement | null = link as HTMLElement;
              for (let i = 0; i < 15; i++) {
                  container = container?.parentElement || null;
                  if (container) {
                      const nameEl = container.querySelector('div[class*="variant-h4"], div[class*="variant-h3"], div[class*="variant-h5"]');
                      if (nameEl) {
                          const text = (nameEl as HTMLElement).innerText || '';
                          if (!text.includes('Candidate Search Filters') && !text.includes('Filtered Candidates')) {
                              return nameEl;
                          }
                      }
                  }
              }
          }
          return null;
      });

      const el = nameElHandle.asElement();
      if (el) {
          try {
              await el.scrollIntoViewIfNeeded();
              await delay(300);
              await el.click();
              await page.waitForSelector('button[aria-label="Close"]', { timeout: 4000 });
              panelOpened = true;
          } catch {}
      }
      if (!panelOpened) await delay(1000);
  }

  if (!panelOpened) {
    log('  Failed to open detail panel. Skipping Phase 2.');
    return;
  }
  await delay(1000);

  const seenUrls = new Set<string>();
  let count = 0;

  while (true) {
    count++;
    const data = await extractFromDetailPanel(page);

    if (!data) {
      log(`  [${count}] Extraction failed. Stopping.`);
      break;
    }

    const currentPageUrl = page.url();
    if (seenUrls.has(currentPageUrl)) {
      log(`  Looped back to ${data.name}. All candidates processed.`);
      break;
    }
    seenUrls.add(currentPageUrl);

    const email = emailMap.get(data.profile_url);
    const finalUrl = data.profile_url || `https://my.metaview.app/candidate/${Buffer.from(data.name + data.location).toString('hex')}`;

    if (!data.experience?.trim() && !data.education?.trim()) {
      log(`  [${count}] Skipped: No experience or education found for ${data.name}`);
    } else {
      await saveCandidate({
        name: data.name,
        profile_url: finalUrl,
        location: data.location,
        headline: data.headline || 'Sourced via Metaview',
        summary: data.summary,
        experience: data.experience,
        education: data.education,
        current_company: data.current_company || data.location,
        latest_role: data.latest_role,
        email,
      }, targetTable);

      log(`  [${count}] ${data.name} — ${data.latest_role || 'N/A'} @ ${data.current_company || 'N/A'} (exp: ${data.experience?.length ?? 0} chars, url: ${finalUrl.substring(0, 60)})`);
    }

    // Navigate to next candidate
    const nextLink = page.locator('a[aria-label="Next candidate"]');
    if (await nextLink.count() === 0) {
      log('  No Next button. Reached last candidate.');
      break;
    }

    const currentUrl = page.url();
    try {
      // Use Playwright click but force it, React Router handles it client-side
      await nextLink.first().click({ force: true, noWaitAfter: true });

      // Wait for the main page URL to change
      await page.waitForFunction(
        (oldUrl: string) => window.location.href !== oldUrl,
        currentUrl,
        { timeout: 10000 }
      );
      await delay(2500);
    } catch {
      log('  Navigation timeout. Stopping.');
      break;
    }
  }

  // Close detail panel
  try { await page.locator('button[aria-label="Close"]').click(); } catch {}
  await delay(500);

  log(`Phase 2 complete. Enriched ${seenUrls.size} candidates with detailed data.\n`);
}


async function scrollAndExtract(page: any, targetTable: string = 'candidates', tabIndex?: number, isUpgrade: boolean = false, enrichOnly: boolean = false) {
    const log = (msg: string) => console.log(tabIndex !== undefined ? `[Tab ${tabIndex}] ${msg}` : msg);
    log(`Beginning scroll-and-extract...`);
    
    const allExtracted = new Map();
    const globalInspectedUrls = new Set<string>();
    const globalEmailMap = new Map<string, string>();
    let pageNum = 1;
    
    if (enrichOnly) {
        log(`Skipping Phase 1 Extraction due to enrich-only flag.`);
    } else {
        while (true) {
        log(`Scraping Page ${pageNum}...`);
        
        // Find the single largest scrollable container with candidate data
        const selector = await page.evaluate(() => {
            document.querySelectorAll('[data-scraper-scroll]').forEach(el => el.removeAttribute('data-scraper-scroll'));
    
            const potential = Array.from(document.querySelectorAll('*')).filter(el => {
                const hEl = el as HTMLElement;
                const style = window.getComputedStyle(el);
                const text = hEl.innerText || '';
                const hasCandidates = text.includes('Experience') || text.includes('Overview') || text.includes('Education') || text.includes('Summary');
                
                return el.scrollHeight - Math.floor(el.clientHeight) > 10 && 
                       (style.overflowY === 'auto' || style.overflowY === 'scroll' || style.overflowY === 'hidden') &&
                       hasCandidates;
            });
            
            // Pick the largest container by area
            potential.sort((a, b) => (b.clientWidth * b.clientHeight) - (a.clientWidth * a.clientHeight));
    
            if (potential.length === 0) return 'body';
            
            const best = potential[0];
            best.setAttribute('data-scraper-scroll', '0');
            return '[data-scraper-scroll="0"]';
        });
    
        console.log(`Using container: ${selector}`);
    
        await page.evaluate((sel: string) => {
            const el = document.querySelector(sel);
            if (el) el.scrollTop = 0;
        }, selector);
        await delay(1500);
    
        let consecutiveNoNew = 0;
        let newCandidatesFoundThisPage = 0;
    
        for (let i = 0; i < 10000; i++) {
            const currentCountBefore = allExtracted.size;
            await delay(1000); 
    
            const batch = await page.evaluate(async () => {
              const expandButtons = Array.from(document.querySelectorAll('button')).filter(b => {
                 const t = (b as HTMLElement).innerText;
                 return t.includes('+') && t.includes('more');
              });
              for (const btn of expandButtons) (btn as HTMLElement).click();
    
              const linkedinLinks = Array.from(document.querySelectorAll('a[href*="linkedin.com"]'));
              const results = [];
              for (const link of linkedinLinks) {
                  let container: HTMLElement | null = link as HTMLElement;
                  for (let i = 0; i < 15; i++) {
                      container = container?.parentElement || null;
                      if (container) {
                          const nameEl = container.querySelector('div[class*="variant-h4"], div[class*="variant-h3"], div[class*="variant-h5"]');
                          if (nameEl) {
                              const text = (nameEl as HTMLElement).innerText || '';
                              if (!text.includes('Candidate Search Filters') && !text.includes('Filtered Candidates')) {
                                  break;
                              }
                          }
                      }
                  }
                  
                  if (!container) continue;

                  const nameEl = container.querySelector('div[class*="variant-h4"], div[class*="variant-h3"], div[class*="variant-h5"]');
                  if (!nameEl) continue;

                  const text = (nameEl as HTMLElement).innerText || '';
                  const name = text.split('\n')[0].trim();
                  
                  // Ignore common UI elements and short names
                  if (name.length < 2 || name.includes('Filters') || name.includes('검색') || name.includes('Candidates')) continue;

                  const locEl = container.querySelector('div[class*="variant-body3Medium"], div[class*="variant-body3"]');
                  const location = locEl ? (locEl as HTMLElement).innerText.trim() : 'Unknown';
                  
                  const profile_url = (link as HTMLAnchorElement).href;
                  
                  const headlineEl = container.querySelector('div[class*="variant-body2Semibold"], div[class*="variant-body2"]');
                  const headline = headlineEl ? (headlineEl as HTMLElement).innerText.trim() : '';

                  results.push({ name, location, profile_url, headline, raw: container.innerText });
              }
    
              // Deduplicate results by profile_url, keeping the one with the largest raw content
              const deduplicated = new Map();
              for (const r of results) {
                const existing = deduplicated.get(r.profile_url);
                if (!existing || (r.raw && existing.raw && r.raw.length > existing.raw.length)) {
                  deduplicated.set(r.profile_url, r);
                }
              }
              return Array.from(deduplicated.values());
            });

            // Extract emails via contact dialog on visible mail icon buttons
            const emailMap = await extractEmailsViaHover(page, globalInspectedUrls);
            if (emailMap.size > 0) {
                log(`  📧 Extracted ${emailMap.size} email(s) via tooltip hover`);
            }
            // Accumulate emails for Phase 2 detail panel enrichment
            for (const [url, email] of emailMap) {
                globalEmailMap.set(url, email);
            }
    
            for (const res of batch) {
              const key = (res.name + res.location).toLowerCase();
              const existing = allExtracted.get(key);
              
              // Only process if it's new OR if the new container has significantly more evidence/raw text
              if (!existing || (res.raw && existing.raw && res.raw.length > existing.raw.length + 100)) {
                allExtracted.set(key, res);
                
                const raw = res.raw || '';
                const lines = raw.split('\n').map((l: string) => l.trim()).filter((l: string) => l.length > 0);
                const cleanLines = lines.filter((l: string) => !['Yes', 'Maybe', 'No', 'Manage candidate', 'Select all', 'Add to sequence'].includes(l));
                
                let summary = '', experience = '', education = '', current_company = '';
                let latest_role = '';
    
                const summaryIdx = cleanLines.findIndex((l: string) => l.toLowerCase() === 'summary' || l.toLowerCase() === 'overview');
                const experienceIdx = cleanLines.findIndex((l: string) => l.toLowerCase() === 'experience' || l.toLowerCase() === 'recent experience');
                const educationIdx = cleanLines.findIndex((l: string) => l.toLowerCase() === 'education');
                
                if (summaryIdx !== -1) {
                    const endIdx = experienceIdx !== -1 ? experienceIdx : (educationIdx !== -1 ? educationIdx : cleanLines.length);
                    summary = cleanLines.slice(summaryIdx + 1, endIdx).join('\n');
                }
                if (experienceIdx !== -1) {
                    const endIdx = educationIdx !== -1 ? educationIdx : cleanLines.length;
                    experience = cleanLines.slice(experienceIdx + 1, endIdx).join('\n');
                    const expLines = cleanLines.slice(experienceIdx + 1, endIdx);
                    
                    if (expLines.length > 0) {
                        // Prioritize the line with the ↳ symbol, which usually indicates the role title
                        const roleLine = expLines.find((l: string) => l.includes('↳'));
                        if (roleLine) {
                            latest_role = roleLine.replace('↳', '').trim();
                        } else {
                            // Fallback: skip lines that look like total years of experience (e.g., "25 yrs 1 mo")
                            const nonDuration = expLines.filter((l: string) => !/\d+\s*(yrs|mo|yr|mos)/.test(l));
                            if (nonDuration.length > 0) {
                                latest_role = nonDuration[0];
                            }
                        }
                    }
    
                    const nowIdx = expLines.findIndex((l: string) => l.includes('→ Now'));
                    if (nowIdx !== -1) {
                        if (nowIdx >= 2) current_company = expLines[nowIdx - 2];
                        else if (nowIdx >= 1) current_company = expLines[nowIdx - 1].replace('↳', '').trim();
                    }
                }
                if (educationIdx !== -1) {
                    const rawEduLines = cleanLines.slice(educationIdx + 1);
                    // Boundary detection: stop when we hit another candidate's section
                    const boundaryIdx = rawEduLines.findIndex((l: string, idx: number) => 
                        idx > 0 && (l.toLowerCase() === 'summary' || l.toLowerCase() === 'overview' || l.toLowerCase() === 'experience' || l.toLowerCase() === 'recent experience')
                    );
                    const safeEduLines = boundaryIdx !== -1 ? rawEduLines.slice(0, Math.max(0, boundaryIdx - 1)) : rawEduLines;
                    const noiseKeywords = ['Manage candidate', 'No email', 'No phone', 'Yes', 'Maybe', 'No'];
                    education = safeEduLines.filter((l: string) => !noiseKeywords.some(kw => l.includes(kw))).join('\n');
                }
    
                // Email: strictly use the tooltip-hovered email to avoid recruiter false positives
                const extractedEmail = emailMap.get(res.profile_url);
                if (extractedEmail) res.email = extractedEmail; // Save to res so alreadyExtractedEmails skips it in next loop
                const phoneMatch = raw.match(/\+?[\d\s\-()]{10,20}/);
    
                const finalUrl = res.profile_url || `https://my.metaview.app/candidate/${Buffer.from(res.name + res.location).toString('hex')}`;
    
                if (!experience?.trim() && !education?.trim()) {
                  console.log(`Skipped: No experience or education found for ${res.name}`);
                } else {
                  await saveCandidate({
                    name: res.name, profile_url: finalUrl, location: res.location,
                    headline: res.headline || 'Sourced via Metaview',
                    summary, experience, education,
                    current_company: current_company || res.location,
                    latest_role,
                    email: extractedEmail,
                    phone_number: (phoneMatch && !raw.includes('No phone selected')) ? phoneMatch[0].trim() : undefined
                  }, targetTable);
                  console.log(`Processed: ${res.name} (Role: ${latest_role || 'N/A'}, Company: ${current_company || 'N/A'}, Email: ${extractedEmail || 'N/A'})`);
                }
              }
            }
    

    
            let scrollResult = await page.evaluate((sel: string) => {
                const el = document.querySelector(sel);
                if (!el) return { scrolled: false, oldTop: -1, newTop: -1, sh: -1, ch: -1 };
                const oldTop = el.scrollTop;
                // Scroll by 40% of client height for better coverage
                el.scrollTop += Math.floor(el.clientHeight * 0.4);
                return { scrolled: el.scrollTop > oldTop, oldTop, newTop: el.scrollTop, sh: el.scrollHeight, ch: el.clientHeight };
            }, selector);
    
            if (!scrollResult.scrolled) {
                const box = await page.locator(selector).first().boundingBox().catch(() => null);
                if (box) {
                    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
                    await page.mouse.wheel(0, 1000);
                }
            }
    
            if (allExtracted.size === currentCountBefore) {
                consecutiveNoNew++;
            } else {
                consecutiveNoNew = 0;
                newCandidatesFoundThisPage += (allExtracted.size - currentCountBefore);
            }
    
            // High-patience termination logic:
            // 1. If we have 0 candidates after 10 scrolls, it's a dead tab.
            // 2. For the upgrade pipeline, we only expect 1-2 candidates, so stop after 3 dry scrolls.
            // 3. For normal scraping, stop after 7 dry scrolls.
            const hasStartedFound = allExtracted.size > 0;
            // Upgrade mode expects 1-2 candidates, so 2 dry scrolls is plenty.
            const threshold = hasStartedFound ? (isUpgrade ? 2 : 7) : 10;
            
            if (consecutiveNoNew >= threshold) {
                log(`Terminating page scroll loop: ${hasStartedFound ? 'Reached end of page list' : 'No candidates detected after ' + threshold + ' attempts'}.`);
                break;
            }
    
            await delay(isUpgrade ? 500 : 1500);
        }
    
        log(`Page ${pageNum} scraping complete. Found ${newCandidatesFoundThisPage} new candidates.`);
        
        if (newCandidatesFoundThisPage === 0) {
            log(`No new candidates found on Page ${pageNum}. Assuming we have finished all pages.`);
            break;
        }
    
        // Check for Next Page button
        const nextBtnSelector = 'button:has(svg.lucide-chevron-right)';
        const nextBtn = page.locator(nextBtnSelector).first();
        const isVisible = await nextBtn.isVisible().catch(() => false);
        const isEnabled = await nextBtn.isEnabled().catch(() => false);
        
        if (!isVisible || !isEnabled) {
            console.log("Next page button is not visible or disabled. Finished all pages.");
            break;
        }
        
        const classes = await nextBtn.getAttribute('class').catch(() => '');
        log(`Found next page button. Classes: "${classes}". Clickable: true.`);
        
        log("Clicking Next Page button...");
        await nextBtn.click().catch((err: any) => {
            log(`Failed to click next page button: ${err.message}`);
        });
        
        pageNum++;
        await delay(5000); // Wait for next page to load
    }
    
    log(`Phase 1 Extraction Count: ${allExtracted.size}`);
    }

    // Phase 2: Click through detail panels for rich data extraction
    // This enhances Phase 1's card-level data with full descriptions,
    // career stats, and education details from the detail panel.
    await clickThroughDetailPanels(page, globalEmailMap, targetTable, tabIndex);
}

/**
 * Dismiss any detail panel that might be blocking interaction with the filters.
 * IMPORTANT: Does NOT press Escape (that closes the filters panel too) and
 * does NOT click arbitrary coordinates (risk of hitting nav links/logo).
 */
async function dismissOverlays(page: any, logFn: (msg: string) => void) {
    // Close any open detail panel via its Close button
    const closeBtn = page.locator('button[aria-label="Close"]');
    if (await closeBtn.count() > 0 && await closeBtn.first().isVisible().catch(() => false)) {
        try {
            await closeBtn.first().click({ force: true, timeout: 2000 });
            logFn(`  Dismissed open detail panel.`);
            await delay(500);
        } catch {}
    }

    // Dismiss any popover/listbox that might be floating (e.g. email dropdown)
    // by clicking on the main content area (the chat/candidate list), not the top-left logo
    const chatArea = page.locator('textarea');
    if (await chatArea.count() > 0) {
        try {
            // Click just above the textarea — safe neutral zone in the chat area
            const box = await chatArea.first().boundingBox();
            if (box) {
                await page.mouse.click(box.x + box.width / 2, box.y - 20);
                await delay(200);
            }
        } catch {}
    }
}

/**
 * Automate upgrading the database by searching each candidate individually
 * and scraping their fully enriched detail panel.
 */
async function runUpgradePipeline(page: any, names: string[], tabIndex: number) {
    const logFilePath = path.join(process.cwd(), `upgrade_pipeline_tab${tabIndex}.log`);
    // Unified file for all tabs to make reprocessing easy
    const skippedFilePath = path.join(process.cwd(), `skipped_candidates.jsonl`);

    function logUpgrade(msg: string) {
        const out = `[Tab ${tabIndex}] ${msg}`;
        console.log(out);
        fs.appendFileSync(logFilePath, `[${new Date().toISOString()}] ${out}\n`);
    }

    function logSkipped(name: string, reason: string) {
        logUpgrade(`  Skipped: ${reason}`);
        const logObj = { timestamp: new Date().toISOString(), name, reason, tabIndex };
        fs.appendFileSync(skippedFilePath, JSON.stringify(logObj) + '\n');
    }

    logUpgrade(`\n=== Starting Database Upgrade Pipeline on Tab ${tabIndex} ===`);
    logUpgrade(`Assigned ${names.length} candidates to upgrade.`);

    let consecutiveOverlayFailures = 0;
    const MAX_CONSECUTIVE_FAILURES = 5;

    for (let i = 0; i < names.length; i++) {
        const name = names[i];
        logUpgrade(`\n[${i + 1}/${names.length}] Upgrading candidate: ${name}`);

        // Immediate Name Validation to catch garbage data
        if (name.length > 25) {
            logSkipped(name, 'Name is suspiciously long (> 25 chars), likely a scraped headline.');
            continue;
        }
        if (/\d/.test(name)) {
            logSkipped(name, 'Name contains numbers, likely a scraped title/date.');
            continue;
        }
        if (name.length <= 3) {
            logSkipped(name, 'Name is too short (<= 3 chars).');
            continue;
        }

        // === OVERLAY RECOVERY: Circuit breaker ===
        // If we've failed many times in a row due to overlays, navigate back to the sourcing URL
        // (page.reload() can break CDP connections; goto with the same URL is safer)
        if (consecutiveOverlayFailures >= MAX_CONSECUTIVE_FAILURES) {
            logUpgrade(`  ⚠️ ${consecutiveOverlayFailures} consecutive failures — navigating back to sourcing page to reset state...`);
            try {
                const currentUrl = page.url();
                await page.goto(currentUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
                await delay(3000);
                consecutiveOverlayFailures = 0;
                logUpgrade(`  ✅ Page reset successfully.`);
            } catch (err: any) {
                logUpgrade(`  ❌ Page reset failed: ${err.message}. Continuing anyway...`);
                consecutiveOverlayFailures = 0; // Reset to avoid infinite loop
            }
        }

        // === OVERLAY RECOVERY: Dismiss any lingering overlays before starting ===
        await dismissOverlays(page, logUpgrade);

        // Open filters panel if it is not open (indicated by the input field missing)
        const nameInputSelector = 'input[aria-label="Enter name"]';
        const inputCount = await page.locator(nameInputSelector).count();
        if (inputCount === 0) {
            logUpgrade(`  Opening filters panel...`);
            const filterBtn = page.locator('button:has(svg.lucide-wrench)');
            if (await filterBtn.count() > 0) {
                try {
                    await filterBtn.first().click({ timeout: 3000, force: true });
                } catch {
                    logSkipped(name, 'Failed to click filters button (overlay blocking?).');
                    consecutiveOverlayFailures++;
                    continue;
                }
                await delay(1500);
            } else {
                logSkipped(name, 'Failed to find the filters button.');
                consecutiveOverlayFailures++;
                continue;
            }
        }

        // Wait for the name input field to exist in DOM
        // The Name field is at the BOTTOM of a tall scrollable modal panel,
        // so it exists in DOM but is off-screen until scrolled.
        try {
            await page.waitForSelector(nameInputSelector, { timeout: 5000 });
        } catch {
            logSkipped(name, 'Name input field not found after opening filters.');
            consecutiveOverlayFailures++;
            continue;
        }

        // Enter the candidate's name
        // CRITICAL: The name input is at the bottom of the filter modal (y≈1500).
        // We must scroll it into view before interacting.
        logUpgrade(`  Typing name...`);
        const inputLocator = page.locator(nameInputSelector).first();
        let nameTyped = false;

        // Retry loop: try up to 3 times with recovery between attempts
        for (let attempt = 0; attempt < 3; attempt++) {
            try {
                // Scroll the input into the visible area of the modal
                await inputLocator.scrollIntoViewIfNeeded();
                await delay(300);
                await inputLocator.click({ timeout: 3000 });
                await page.keyboard.press('Control+A');
                await page.keyboard.press('Meta+A');
                await page.keyboard.press('Backspace');
                // Use fill instead of type to simulate pasting and preserve exact spacing
                await inputLocator.fill(name);
                await delay(500);
                nameTyped = true;
                break;
            } catch (err) {
                if (attempt < 2) {
                    logUpgrade(`  Name input blocked (attempt ${attempt + 1}/3). Recovering...`);
                    await dismissOverlays(page, logUpgrade);
                    await delay(500);
                    // Re-check if the filter panel is still open
                    const stillVisible = await page.locator(nameInputSelector).count();
                    if (stillVisible === 0) {
                        logUpgrade(`  Filter panel closed during recovery. Re-opening...`);
                        const filterBtn = page.locator('button:has(svg.lucide-wrench)');
                        if (await filterBtn.count() > 0) {
                            try {
                                await filterBtn.first().click({ timeout: 3000, force: true });
                                await delay(1500);
                            } catch {}
                        }
                    }
                }
            }
        }

        if (!nameTyped) {
            logSkipped(name, 'Could not focus on name input field after 3 recovery attempts.');
            consecutiveOverlayFailures++;
            continue;
        }

        // Successfully typed name — reset the failure counter
        consecutiveOverlayFailures = 0;

        // 1. Click "Save filters" button
        logUpgrade(`  Clicking 'Save filters' button...`);
        const saveFiltersBtn = page.locator('button:has-text("Save filters")').first();
        if (await saveFiltersBtn.isVisible().catch(() => false)) {
            try {
                await saveFiltersBtn.click({ timeout: 3000, force: true });
            } catch {
                logUpgrade(`  Could not click 'Save filters' button. Pressing Enter instead...`);
                await page.keyboard.press('Enter');
            }
        } else {
            logUpgrade(`  Could not find 'Save filters' button. Pressing Enter instead...`);
            await page.keyboard.press('Enter');
        }

        await delay(2000); // Wait for Metaview to process and generate the filtered candidates button

        // 2. Click the LATEST non-archive "Filtered Candidates" button using pure text matching.
        // Archive buttons have text starting with "Archive:". The active one starts with a number.
        // The latest button is always the last one in the DOM (chat appends downward).
        logUpgrade(`  Clicking 'Filtered Candidates' button...`);
        let buttonText: string | null = null;
        for (let attempt = 0; attempt < 4 && !buttonText; attempt++) {
            buttonText = await page.evaluate(() => {
                const allButtons = Array.from(document.querySelectorAll('button'));
                // Find all buttons whose text contains "Filtered Candidates" but NOT "Archive"
                const candidates = allButtons.filter(btn => {
                    const text = btn.innerText || '';
                    return text.includes('Filtered Candidates') && !text.includes('Archive');
                });
                // Click the LAST one (most recently added to the DOM = latest filter result)
                if (candidates.length > 0) {
                    const target = candidates[candidates.length - 1];
                    const text = (target as HTMLElement).innerText;
                    (target as HTMLElement).click();
                    return text;
                }
                return null;
            });
            if (buttonText) {
                logUpgrade(`  Clicked latest 'Filtered Candidates' button. Text: "${buttonText.replace(/\n/g, ' ')}"`);
            } else {
                logUpgrade(`  Waiting for 'Filtered Candidates' button to appear (attempt ${attempt + 1})...`);
                await delay(2000);
            }
        }
        if (!buttonText) {
            logSkipped(name, 'Could not find any Filtered Candidates button.');
            continue;
        }

        // Parse the filter count from button text (e.g. "0 Filtered Candidates 2 Filters Applied")
        const filterCountMatch = buttonText.match(/(\d+)\s*Filters?\s*Applied/i);
        const candidateCountMatch = buttonText.match(/^(\d+)\s*Filtered/);
        const filterCount = filterCountMatch ? parseInt(filterCountMatch[1]) : 0;
        const candidateCount = candidateCountMatch ? parseInt(candidateCountMatch[1]) : -1;

        if (candidateCount === 0) {
            const reason = filterCount > 1
                ? `0 candidates returned. ${filterCount} filters were active (expected 1 = name only). Extra filters may be narrowing results — clear them manually or check the Metaview sourcing view.`
                : `0 candidates returned from search (${filterCount} filter active).`;
            logSkipped(name, reason);
            continue;
        }

        // Wait for candidate results to load
        // A minimal wait before checking for the LinkedIn logo to ensure Metaview starts rendering
        await delay(500); 
        try {
            await page.waitForSelector('a[href*="linkedin.com"]', { timeout: 10000 });
        } catch {
            logUpgrade(`  No candidates appeared after 10 seconds, assuming 0 results.`);
        }
        await delay(300); // Tiny safety delay for rendering

        // Run the extraction pipeline directed to the upgraded table
        await scrollAndExtract(page, 'candidates_upgraded', tabIndex, true);

        // === OVERLAY RECOVERY: Clean up after extraction ===
        // scrollAndExtract → clickThroughDetailPanels may leave a detail panel open.
        // Dismiss it so the next iteration starts clean.
        await dismissOverlays(page, logUpgrade);

        await delay(1000);
    }
    
    console.log(`\n=== Database Upgrade Pipeline Complete ===`);
}

// Entry Point
const argv = parseArgs(process.argv.slice(2), {
  string: ['mode', 'tab'],
  boolean: ['list', 'enrich-only'],
  alias: { m: 'mode', t: 'tab', l: 'list', e: 'enrich-only' },
  default: { mode: 'full' }
});

let runtimeMode: 'full' | 'extract' | 'analyze' | 'upgrade' = argv.mode as 'full' | 'extract' | 'analyze' | 'upgrade';
let targetTab = argv.tab !== undefined ? parseInt(argv.tab) : undefined;
let listOnly = argv.list || false;
let enrichOnly = argv['enrich-only'] || false;
let upgradeLimit = argv.limit !== undefined ? parseInt(argv.limit) : undefined;
let positionalArgs = argv._;

if (positionalArgs[0] === 'extract' || positionalArgs[0] === 'full' || positionalArgs[0] === 'analyze' || positionalArgs[0] === 'upgrade') {
    runtimeMode = positionalArgs[0] as 'full' | 'extract' | 'analyze' | 'upgrade';
    positionalArgs = positionalArgs.slice(1);
}

if (argv.upgrade) {
    runtimeMode = 'upgrade';
}

// Smart default: If a target tab is specified, but the user did not supply a query or a mode,
// default to 'extract' mode to avoid overwriting their active sourcing view with a generic query.
const hasExplicitMode = argv.mode !== undefined;
const hasQuery = positionalArgs.length > 0;
if (targetTab !== undefined && !hasExplicitMode && !hasQuery) {
    runtimeMode = 'extract';
}

const queryArg = hasQuery ? positionalArgs.join(' ') : 'Software Engineer React Node San Francisco';

runScraper({
  mode: runtimeMode,
  query: hasQuery ? queryArg : undefined, // only pass query if explicitly provided
  tab: targetTab,
  list: listOnly,
  limit: upgradeLimit,
  enrichOnly: enrichOnly
}).catch(err => {
  console.error(err);
  process.exit(1);
});
