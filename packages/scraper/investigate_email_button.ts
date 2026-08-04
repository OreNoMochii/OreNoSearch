/**
 * Investigation v2: Try click + dispatchEvent + check portals
 * to discover how the email is revealed on Metaview mail buttons.
 */

import { chromium } from 'playwright-extra';
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
import { delay } from './utils';

// @ts-ignore
chromium.use(StealthPlugin());

async function investigate() {
  console.log('Connecting to remote browser on port 9222...');
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const contexts = browser.contexts();
  const pages: any[] = [];

  for (const ctx of contexts) {
    pages.push(...ctx.pages());
  }

  const sourcingPages = pages.filter((p) => p.url().includes('my.metaview.app/sourcing'));

  if (sourcingPages.length === 0) {
    console.log('No Metaview sourcing tabs found.');
    await browser.close();
    return;
  }

  const page = sourcingPages[0];
  console.log(`Found sourcing page: ${page.url()}`);
  await page.bringToFront();
  await delay(2000);

  // Find all mail buttons
  const mailButtons = await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll('button'));
    const mailBtns = buttons.filter((b) => {
      const svg = b.querySelector('svg.lucide-mail, svg.lucide.lucide-mail');
      return !!svg;
    });
    return mailBtns.map((btn, idx) => {
      const rect = btn.getBoundingClientRect();
      return {
        idx,
        id: btn.id,
        className: btn.className,
        boundingBox: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      };
    });
  });

  console.log(`Found ${mailButtons.length} mail icon button(s)\n`);
  if (mailButtons.length === 0) {
    await browser.close();
    return;
  }

  const btn = mailButtons[0];
  const cx = btn.boundingBox.x + btn.boundingBox.width / 2;
  const cy = btn.boundingBox.y + btn.boundingBox.height / 2;

  // ── Take full DOM snapshot BEFORE any interaction ──
  const domSnapshotBefore = await page.evaluate(() => document.body.innerHTML.length);
  console.log(`DOM size before: ${domSnapshotBefore} chars`);

  // ── Approach 1: Dispatch synthetic pointer/mouse events ──
  console.log('\n=== APPROACH 1: Dispatching synthetic events on button ===');
  await page.evaluate((btnId: string) => {
    const el = document.getElementById(btnId);
    if (!el) return;
    ['pointerenter', 'mouseenter', 'pointerover', 'mouseover', 'pointermove', 'mousemove'].forEach(
      (eventType) => {
        el.dispatchEvent(new PointerEvent(eventType, { bubbles: true, cancelable: true }));
      },
    );
  }, btn.id);
  await delay(2000);

  let result = await scanForNewContent(page, btn.id);
  logResult('After synthetic events', result);

  // Reset - move mouse away
  await page.mouse.move(0, 0);
  await delay(500);

  // ── Approach 2: Use Playwright hover on the button element ──
  console.log('\n=== APPROACH 2: Playwright page.hover via evaluate-based selector ===');
  // Use evaluate to get exact position, then hover
  await page.mouse.move(cx, cy);
  await page.mouse.move(cx + 1, cy); // tiny move to trigger events
  await delay(2000);

  result = await scanForNewContent(page, btn.id);
  logResult('After Playwright mouse.move', result);

  // Reset
  await page.mouse.move(0, 0);
  await delay(500);

  // ── Approach 3: CLICK the button ──
  console.log('\n=== APPROACH 3: Clicking the mail button ===');
  await page.mouse.click(cx, cy);
  await delay(3000);

  result = await scanForNewContent(page, btn.id);
  logResult('After CLICK', result);

  // Check if a modal/dialog/dropdown appeared
  const modals = await page.evaluate(() => {
    const modalSelectors = [
      '[role="dialog"]',
      '[role="menu"]',
      '[role="listbox"]',
      '[data-state="open"]',
      '[class*="modal"]',
      '[class*="Modal"]',
      '[class*="dropdown"]',
      '[class*="Dropdown"]',
      '[class*="overlay"]',
      '[class*="Overlay"]',
      '[class*="popover"]',
      '[class*="Popover"]',
    ];
    const found: any[] = [];
    for (const sel of modalSelectors) {
      const els = Array.from(document.querySelectorAll(sel));
      for (const el of els) {
        found.push({
          selector: sel,
          tagName: el.tagName,
          id: el.id,
          className: el.className?.toString().substring(0, 150),
          text: (el as HTMLElement).innerText?.trim().substring(0, 500),
          outerHTML: el.outerHTML.substring(0, 1000),
        });
      }
    }
    return found;
  });
  console.log(`\n--- Modals/dialogs/dropdowns after click: ${modals.length} ---`);
  for (const m of modals) {
    console.log(`  Selector: ${m.selector}`);
    console.log(`  <${m.tagName}> id=${m.id} class="${m.className}"`);
    console.log(`  Text: "${m.text}"`);
    console.log(`  HTML: ${m.outerHTML.substring(0, 600)}`);
    console.log('');
  }

  // ── Approach 4: Check DOM diff ──
  const domSnapshotAfter = await page.evaluate(() => document.body.innerHTML.length);
  console.log(
    `\nDOM size after all interactions: ${domSnapshotAfter} chars (delta: ${domSnapshotAfter - domSnapshotBefore})`,
  );

  // ── Approach 5: Check all elements near the button coordinates ──
  console.log('\n=== APPROACH 5: Elements near button position ===');
  const nearbyEls = await page.evaluate((box: any) => {
    const allEls = Array.from(document.querySelectorAll('*'));
    const nearby = allEls.filter((el) => {
      const rect = el.getBoundingClientRect();
      const centerX = rect.x + rect.width / 2;
      const centerY = rect.y + rect.height / 2;
      const btnCenterX = box.x + box.width / 2;
      const btnCenterY = box.y + box.height / 2;
      const dist = Math.sqrt(Math.pow(centerX - btnCenterX, 2) + Math.pow(centerY - btnCenterY, 2));
      return (
        dist < 200 &&
        (el as HTMLElement).innerText?.trim().length > 0 &&
        (el as HTMLElement).innerText?.trim().length < 300
      );
    });
    return nearby
      .map((el) => ({
        tagName: el.tagName,
        className: el.className?.toString().substring(0, 100),
        text: (el as HTMLElement).innerText?.trim().substring(0, 200),
        rect: (() => {
          const r = el.getBoundingClientRect();
          return { x: r.x, y: r.y, w: r.width, h: r.height };
        })(),
      }))
      .slice(0, 30);
  }, btn.boundingBox);

  for (const n of nearbyEls) {
    console.log(
      `  <${n.tagName}> (${Math.round(n.rect.x)},${Math.round(n.rect.y)} ${Math.round(n.rect.w)}x${Math.round(n.rect.h)}) class="${n.className}"`,
    );
    console.log(`    "${n.text.substring(0, 120)}"`);
  }

  // ── Approach 6: Inspect React internals / fiber ──
  console.log('\n=== APPROACH 6: React fiber inspection ===');
  const reactData = await page.evaluate((btnId: string) => {
    const el = document.getElementById(btnId);
    if (!el) return null;
    // React stores fiber data on __reactFiber$ or __reactInternalInstance$
    const fiberKey = Object.keys(el).find(
      (k) => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'),
    );
    const propsKey = Object.keys(el).find((k) => k.startsWith('__reactProps$'));

    let propsData: any = null;
    if (propsKey) {
      const props = (el as any)[propsKey];
      // Extract only serializable parts
      propsData = {};
      for (const key of Object.keys(props)) {
        const val = props[key];
        if (
          typeof val === 'string' ||
          typeof val === 'number' ||
          typeof val === 'boolean' ||
          val === null
        ) {
          propsData[key] = val;
        } else if (typeof val === 'object' && val !== null) {
          try {
            propsData[key] = JSON.parse(JSON.stringify(val));
          } catch (e) {
            propsData[key] = `[${typeof val}]`;
          }
        }
      }
    }

    return {
      hasFiber: !!fiberKey,
      fiberKey: fiberKey || null,
      hasProps: !!propsKey,
      propsKey: propsKey || null,
      props: propsData,
      allKeys: Object.keys(el).filter((k) => k.startsWith('__')),
    };
  }, btn.id);
  console.log(`React fiber found: ${reactData?.hasFiber}`);
  console.log(`React props found: ${reactData?.hasProps}`);
  console.log(`Internal keys: ${JSON.stringify(reactData?.allKeys)}`);
  if (reactData?.props) {
    console.log(`Props: ${JSON.stringify(reactData.props, null, 2)}`);
  }

  // ── Close and Dismiss any open overlay by pressing Escape ──
  await page.keyboard.press('Escape');
  await delay(500);

  console.log('\n=== Investigation complete ===');
  await browser.close();
}

async function scanForNewContent(page: any, btnId: string) {
  // Check button attributes
  const btnState = await page.evaluate((id: string) => {
    const el = document.getElementById(id);
    if (!el) return null;
    const attrs: any = {};
    for (let i = 0; i < el.attributes.length; i++) {
      attrs[el.attributes[i].name] = el.attributes[i].value;
    }
    return { attrs, outerHTML: el.outerHTML.substring(0, 600) };
  }, btnId);

  // Check for tooltips
  const tooltips = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('[role="tooltip"]')).map((el) => ({
      text: (el as HTMLElement).innerText?.trim(),
      html: el.outerHTML.substring(0, 500),
    }));
  });

  // Check for any new element with email
  const emailEls = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('*'))
      .filter((el) => {
        const t = (el as HTMLElement).innerText || '';
        return t.includes('@') && t.length < 150 && !t.includes('{') && !t.includes('layer');
      })
      .map((el) => ({
        tag: el.tagName,
        text: (el as HTMLElement).innerText.trim().substring(0, 150),
      }))
      .slice(0, 10);
  });

  // Check floating elements
  const floats = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('*'))
      .filter((el) => {
        const s = window.getComputedStyle(el);
        const r = el.getBoundingClientRect();
        const t = (el as HTMLElement).innerText || '';
        return (
          (s.position === 'fixed' || s.position === 'absolute') &&
          r.width > 30 &&
          r.width < 400 &&
          r.height > 10 &&
          r.height < 80 &&
          t.length > 2 &&
          t.length < 150 &&
          !t.includes('SCRAPER')
        );
      })
      .map((el) => ({
        tag: el.tagName,
        text: (el as HTMLElement).innerText.trim(),
        class: el.className?.toString().substring(0, 100),
      }))
      .slice(0, 10);
  });

  return { btnState, tooltips, emailEls, floats };
}

function logResult(label: string, result: any) {
  console.log(`\n--- ${label} ---`);
  console.log(`  Button attrs: ${JSON.stringify(result.btnState?.attrs)}`);
  console.log(`  Tooltips: ${result.tooltips.length}`);
  for (const t of result.tooltips) console.log(`    "${t.text}"`);
  console.log(`  Email elements: ${result.emailEls.length}`);
  for (const e of result.emailEls) console.log(`    <${e.tag}> "${e.text}"`);
  console.log(`  Floating elements: ${result.floats.length}`);
  for (const f of result.floats) console.log(`    <${f.tag}> class="${f.class}" → "${f.text}"`);
}

investigate().catch((err) => {
  console.error(err);
  process.exit(1);
});
