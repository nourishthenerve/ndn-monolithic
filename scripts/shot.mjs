import { chromium } from '@playwright/test';
const url = process.argv[2], out = process.argv[3];
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 });
await page.goto(url, { waitUntil: 'networkidle' });
await page.screenshot({ path: out });
await browser.close();
console.log('saved', out);
