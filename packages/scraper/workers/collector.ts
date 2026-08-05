import { Page } from 'playwright';
import { assignTabBadge, delay } from '../utils/dom';
import { stateManager } from '../core/state';
import { saveCandidate } from '../database';

export async function runCollectorWorker(page: Page) {
    const tabPrefix = '[Worker: Collector] ';
    console.log(`${tabPrefix}Initializing Deterministic Collector...`);
    
    await page.bringToFront().catch(() => {});
    await assignTabBadge(page, 'COLLECTOR (DETERMINISTIC)');

    while (true) {
        try {
            // Set, not array: this is membership-tested once per sidebar chat
            // and the extracted list grows without bound across runs.
            const extractedUrls = new Set(stateManager.getExtractedIds());
            
            // Ensure sidebar is expanded
            await ensureSidebarOpen(page);
            
            // Find chats with "X new candidates" badge in the sidebar
            const targetUrls = await page.evaluate(() => {
                return Array.from(document.querySelectorAll('a'))
                    .filter(a => {
                        if (!/\/sourcing\/[0-9a-fA-F\-]{20,}/.test(a.href)) return false;
                        const text = (a.innerText || a.textContent || '').toLowerCase();
                        return /\d+\s+new candidates/.test(text);
                    })
                    .map(a => a.href.split('?')[0]);
            });
            const uniqueUrls = [...new Set(targetUrls)];
            
            if (uniqueUrls.length === 0) {
                 console.log(`${tabPrefix}No 'New Candidates' badges found in the sidebar.`);
            } else {
                 console.log(`${tabPrefix}Found ${uniqueUrls.length} chats with new candidates.`);
            }

            let didExtract = false;

            for (const url of uniqueUrls) {
                // Skip if we've already extracted this chat
                if (extractedUrls.has(url)) continue;
                
                const currentClean = page.url().split('?')[0];
                if (url !== currentClean) {
                    console.log(`${tabPrefix}Navigating to: ${url}`);
                    await page.goto(url).catch(() => {});
                    await delay(5000);
                }
                
                // Verify candidates are actually on screen
                // One textContent read on body rather than one per element
                // across every div, span and button on the page.
                const hasCandidates = await page.evaluate(() => {
                    const text = (document.body.textContent || '').toLowerCase();
                    return text.includes('candidate pack') || /\d+ candidates/.test(text) || text.includes('new candidates');
                });
                
                if (hasCandidates) {
                    console.log(`${tabPrefix}Candidate batch found at ${url}. Engaging extractor...`);
                    await scrollAndExtract(page, tabPrefix, url);
                    stateManager.recordExtraction(url);
                    console.log(`${tabPrefix}Extraction complete and saved.`);
                    didExtract = true;
                    await delay(5000);
                    break; // Process one chat per cycle to avoid overwhelming
                }
            }

            if (!didExtract) {
                // Fallback: check current screen for dynamically loaded candidates
                const currentHref = page.url().split('?')[0];
                if (currentHref.includes('/sourcing/') && !extractedUrls.has(currentHref)) {
                    const isThinking = await page.evaluate(() => {
                        const allHtml = (document.body.innerText || '').toLowerCase();
                        return allHtml.includes('metaview is thinking') || allHtml.includes('generating');
                    });
                    
                    if (!isThinking) {
                        const hasCandidatesOnScreen = await page.evaluate(() => {
                            const t = (document.body.textContent || '').toLowerCase();
                            return t.includes('candidate pack') || /\d+ candidates/.test(t);
                        });
                        
                        if (hasCandidatesOnScreen) {
                            console.log(`${tabPrefix}Candidates detected on current active screen!`);
                            await scrollAndExtract(page, tabPrefix, currentHref);
                            stateManager.recordExtraction(currentHref);
                        }
                    }
                }
            }
            
        } catch (e) {
            console.log(`${tabPrefix}Error:`, e);
            await delay(10000);
        }
        
        // Wait 3 to 5 minutes before running the full loop again
        const cycleDelay = 180000 + Math.random() * 120000; 
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

async function scrollAndExtract(page: Page, prefix: string = '', pageUrl: string = '') {
    const allExtracted = new Map();
    
    // Tag the scrollable containers
    const containerSelectors = await page.evaluate(() => {
        document.querySelectorAll('[data-scraper-scroll]').forEach(el => el.removeAttribute('data-scraper-scroll'));

        // Ordered cheapest-check-first.
        //
        // This used to walk EVERY element in the document and, for each, read
        // innerText, getComputedStyle, scrollHeight and clientHeight. All four
        // flush layout, and innerText forces a full style-and-layout pass — so
        // on a page with thousands of nodes this was thousands of synchronous
        // reflows, repeated on every iteration of the scroll loop below.
        //
        // Now: narrow structurally first (candidate cards are divs), then
        // filter on textContent, which reads the DOM without touching layout,
        // and only measure the handful of survivors.
        const divs = Array.from(document.querySelectorAll('div'));

        const withText = divs.filter(el => {
            const text = el.textContent || '';
            return text.includes('Experience') || text.includes('Education') || text.includes('Summary');
        });

        const potential = withText.filter(el => {
            if (el.scrollHeight - Math.floor(el.clientHeight) <= 10) return false;
            const overflowY = window.getComputedStyle(el).overflowY;
            return overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'hidden';
        });

        potential.sort((a, b) => (b.clientWidth * b.clientHeight) - (a.clientWidth * a.clientHeight));

        const picked: Element[] = [];
        for (const el of potential) {
            if (!picked.some(p => p.contains(el) || el.contains(p))) {
                picked.push(el);
            }
        }

        return picked.map((el, idx) => {
            const selector = `[data-scraper-scroll="${idx}"]`;
            el.setAttribute('data-scraper-scroll', idx.toString());
            return selector;
        });
    });

    if (containerSelectors.length === 0) {
        containerSelectors.push('body'); // Fallback
    }

    console.log(`${prefix}Found ${containerSelectors.length} potential containers.`);

    for (const selector of containerSelectors) {
        console.log(`${prefix}Processing container: ${selector}`);
        
        await page.evaluate((sel: string) => {
            const el = document.querySelector(sel);
            if (el) el.scrollTop = 0;
        }, selector);
        await delay(1500);

        let consecutiveNoNew = 0;

        for (let i = 0; i < 200; i++) {
            const currentCountBefore = allExtracted.size;
            await delay(1000); 

            // Execute Page DOM Extraction
            const batch = await page.evaluate(async (pageUrl: string) => {
              // Click any "+N more" expand buttons
              const expandButtons = Array.from(document.querySelectorAll('button')).filter(b => {
                 const t = (b as HTMLElement).innerText;
                 return t.includes('+') && t.includes('more');
              });
              for (const btn of expandButtons) (btn as HTMLElement).click();

              // --- Card detection strategy ---
              // Metaview candidate cards contain structured sections: Summary, Experience, Education
              // We find container divs that have these sections and are the right size
              const allDivs = Array.from(document.querySelectorAll('div'));
              const cards = allDivs.filter(el => {
                const text = el.innerText || '';
                const hasStructure = text.includes('Experience') || text.includes('Summary') || text.includes('Education');
                return hasStructure && text.length > 250 && text.length < 5000;
              });

              const blacklist = ['Experience', 'Education', 'Summary', 'Candidate Pack', 'Manage candidate', 'No email selected', 'No phone selected', 'All', 'Unreviewed', 'Yes', 'Maybe', 'No', 'Selected', 'Ideal Candidate Profile', 'Must-Have Requirements', 'Nice-to-Have', 'Anti-Signals'];
              const results: any[] = [];

              for (const container of cards) {
                // --- Name extraction ---
                // Primary: look for variant-h4 or variant-h3 class divs
                const nameEl = container.querySelector('div[class*="variant-h4"], div[class*="variant-h3"], div[class*="variant-h5"]'); 
                let name = nameEl ? (nameEl as HTMLElement).innerText.split('\n')[0].trim() : 'Unknown';
                
                if (name === 'Unknown' || blacklist.includes(name)) {
                   const divs = Array.from(container.querySelectorAll('div'))
                     .map(d => (d as HTMLElement).innerText.split('\n')[0].trim())
                     .filter(t => t.length > 2 && t.length < 60 && !blacklist.includes(t));
                   
                  const validNames = divs.filter(t => {
                     const hasLetters = /[a-zA-Z]/.test(t);
                     const isDuration = /\d+ (yrs|mo|yr|mos)/.test(t) || /^[A-Z][a-z]{2} \d{4}/.test(t);
                     const isLocation = /^[A-Z][a-z]+, [A-Z][a-z]+/.test(t);
                     const isJobTitle = ['Manager', 'Engineer', 'Developer', 'Director', 'VP', 'Lead', 'Senior'].some(w => t.includes(w) && t.length > 20);
                     const isMeta = ['Experience', 'Education', 'Summary', 'Calibration', 'Company stage', 'Functional emphasis'].some(word => t.includes(word));
                     return hasLetters && !isDuration && !isLocation && !isJobTitle && !isMeta;
                  });
                  if (validNames[0]) name = validNames[0];
                }

                if (name === 'Unknown' || blacklist.includes(name) || name.length < 2) continue;
                
                // --- Location extraction ---
                const locEl = container.querySelector('div[class*="variant-body3Medium"][class*="color-faded"]')
                    || container.querySelector('div[class*="variant-body3Medium"]');
                const location = locEl ? (locEl as HTMLElement).innerText.trim() : 'Unknown';
                
                // --- Profile URL extraction ---
                // Try LinkedIn first, fall back to any link, then generate from page URL
                const linkedinEl = container.querySelector('a[href*="linkedin.com"]');
                let profile_url = '';
                if (linkedinEl) {
                    profile_url = (linkedinEl as HTMLAnchorElement).href;
                } else {
                    // Try any link in the card
                    const anyLink = container.querySelector('a[href]');
                    if (anyLink) {
                        profile_url = (anyLink as HTMLAnchorElement).href;
                    } else {
                        // Generate a deterministic URL from the page URL and candidate name
                        const nameSlug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
                        profile_url = pageUrl ? `${pageUrl}#candidate-${nameSlug}` : `metaview://candidate/${nameSlug}`;
                    }
                }
                
                // --- Headline extraction ---
                const headlineEl = container.querySelector('div[class*="variant-body2Semibold"], div[class*="variant-body2Medium"], div[class*="variant-body2"]');
                const headline = headlineEl ? (headlineEl as HTMLElement).innerText.trim() : '';

                results.push({ name, location, profile_url, headline, raw: container.innerText });
              }
              return results;
            }, pageUrl);

            // Save to Database
            for (const res of batch) {
              const key = (res.name + res.location).toLowerCase();
              if (!allExtracted.has(key)) {
                allExtracted.set(key, res);
                
                const raw: string = res.raw || '';
                const lines = raw.split('\n').map((l: string) => l.trim()).filter((l: string) => l.length > 0);
                const cleanLines = lines.filter((l: string) => !['Yes', 'Maybe', 'No', 'Manage candidate', 'Select all', 'Add to sequence'].includes(l));
                
                let summary = '', experience = '', education = '', current_company = '';

                const summaryIdx = cleanLines.findIndex((l: string) => l.toLowerCase() === 'summary');
                const experienceIdx = cleanLines.findIndex((l: string) => l.toLowerCase() === 'experience');
                const educationIdx = cleanLines.findIndex((l: string) => l.toLowerCase() === 'education');
                
                if (summaryIdx !== -1) {
                    const endIdx = experienceIdx !== -1 ? experienceIdx : (educationIdx !== -1 ? educationIdx : cleanLines.length);
                    summary = cleanLines.slice(summaryIdx + 1, endIdx).join('\n');
                }
                if (experienceIdx !== -1) {
                    const endIdx = educationIdx !== -1 ? educationIdx : cleanLines.length;
                    experience = cleanLines.slice(experienceIdx + 1, endIdx).join('\n');
                    const expLines = cleanLines.slice(experienceIdx + 1, endIdx);
                    // Find the first "→ Now" line to determine current company
                    const nowIdx = expLines.findIndex((l: string) => l.includes('→ Now'));
                    if (nowIdx !== -1) {
                        // Company name is typically 2 lines before the "→ Now" date line
                        // Pattern: CompanyName / ↳ Role Title / Date → Now
                        for (let j = nowIdx - 1; j >= 0; j--) {
                            const line = expLines[j].replace('↳', '').trim();
                            // Skip role title lines (they start with ↳)
                            if (expLines[j].includes('↳')) continue;
                            // Skip date lines
                            if (/^[A-Z][a-z]{2} \d{4}/.test(line)) continue;
                            // Skip duration lines
                            if (/^\d+ (yrs|mo|yr|mos)/.test(line)) continue;
                            // This should be the company name
                            if (line.length > 1 && line.length < 100) {
                                current_company = line;
                                break;
                            }
                        }
                    }
                }
                if (educationIdx !== -1) {
                    const rawEduLines = cleanLines.slice(educationIdx + 1);
                    // Boundary detection: stop when we hit another candidate's section
                    const boundaryIdx = rawEduLines.findIndex((l: string, idx: number) => 
                        idx > 0 && (l.toLowerCase() === 'summary' || l.toLowerCase() === 'experience')
                    );
                    const safeEduLines = boundaryIdx !== -1 ? rawEduLines.slice(0, Math.max(0, boundaryIdx - 1)) : rawEduLines;
                    const noiseKeywords = ['Manage candidate', 'No email', 'No phone', 'Yes', 'Maybe', 'No', 'I prefer this'];
                    education = safeEduLines.filter(l => !noiseKeywords.some(kw => l.includes(kw))).join('\n');
                }

                const emailMatch = raw.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
                const phoneMatch = raw.match(/\+?[\d\s\-()]{10,20}/);

                const finalUrl = res.profile_url || `metaview://candidate/${Buffer.from(res.name + res.location).toString('hex')}`;
                
                await saveCandidate({
                  name: res.name, profile_url: finalUrl, location: res.location,
                  headline: res.headline || 'Sourced via Metaview',
                  summary, experience, education,
                  current_company: current_company || 'N/A',
                  email: emailMatch ? emailMatch[0].replace(' ', '') : undefined,
                  phone_number: (phoneMatch && !raw.includes('No phone selected')) ? phoneMatch[0].trim() : undefined
                });
                console.log(`${prefix}Saved to DB: ${res.name} (Company: ${current_company || 'N/A'})`);
              }
            }

            // Deal with "Show more"
            const showMoreSelector = 'button:has-text("Show"):has-text("more"), button:has-text("Load"):has-text("more")';
            const showMoreBtn = page.locator(showMoreSelector).first();
            if (await showMoreBtn.isVisible().catch(() => false) && await showMoreBtn.isEnabled().catch(() => false)) {
                await showMoreBtn.click();
                await delay(6000);
            }

            // Execute Scroll Mechanism (Hardened for Virtual Scrolling)
            let scrollResult = await page.evaluate(async (sel: string) => {
                const el = document.querySelector(sel);
                if (!el) return { scrolled: false, oldTop: -1, newTop: -1, sh: -1, ch: -1 };
                const oldTop = el.scrollTop;
                
                el.scrollBy({ top: el.clientHeight * 0.6, behavior: 'auto' });
                
                await new Promise(r => setTimeout(r, 200));
                
                return { scrolled: el.scrollTop > oldTop, oldTop, newTop: el.scrollTop, sh: el.scrollHeight, ch: el.clientHeight };
            }, selector);

            if (!scrollResult.scrolled) {
                await page.locator(selector).click().catch(() => {});
                await page.keyboard.press('PageDown');
                await delay(500);
                await page.keyboard.press('PageDown');
                
                const box = await page.locator(selector).first().boundingBox().catch(() => null);
                if (box) {
                    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
                    await page.mouse.wheel(0, 2000);
                }
            }

            if (allExtracted.size === currentCountBefore) {
                consecutiveNoNew++;
            } else {
                consecutiveNoNew = 0;
            }

            // Patient termination logic
            const hasStartedFound = allExtracted.size > 0;
            const threshold = hasStartedFound ? 40 : 15;
            
            if (consecutiveNoNew >= threshold) {
                console.log(`${prefix}Terminating scroll: ${hasStartedFound ? 'Reached end of list' : 'No candidates detected'}.`);
                break;
            }

            await delay(1500);
        }
    }

    console.log(`${prefix}Total Extracted this loop: ${allExtracted.size}`);
}
