const { chromium } = await import(process.env.INK_TRACKER_PLAYWRIGHT);

const browser = await chromium.launch({ headless: true, executablePath: process.env.INK_TRACKER_BROWSER });
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 }, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
await page.goto('http://127.0.0.1:8765/test/fixtures/hyatt-ui-harness.html', { waitUntil: 'networkidle' });
await page.locator('#hyatt-tracker-root').evaluate((host) => host.shadowRoot.querySelector('[data-action="open"]').click());
await page.waitForTimeout(250);
await page.screenshot({ path: 'test/fixtures/hyatt-ui-render.png', fullPage: true });
const summary = await page.locator('#hyatt-tracker-root').evaluate((host) => ({
  cards: host.shadowRoot.querySelectorAll('.card').length,
  text: host.shadowRoot.querySelector('.body').innerText,
  modalWidth: host.shadowRoot.querySelector('.modal').getBoundingClientRect().width,
  bodyScrollWidth: host.shadowRoot.querySelector('.body').scrollWidth,
  bodyClientWidth: host.shadowRoot.querySelector('.body').clientWidth
}));
await page.locator('#hyatt-tracker-root').evaluate((host) => host.shadowRoot.querySelector('[data-setup="personal-1234"]').click());
await page.waitForTimeout(100);
await page.screenshot({ path: 'test/fixtures/hyatt-setup-render.png', fullPage: true });
const setup = await page.locator('#hyatt-tracker-root').evaluate((host) => ({
  form: Boolean(host.shadowRoot.querySelector('[data-setup-form]')),
  activePanels: host.shadowRoot.querySelectorAll('.mode-panel.active').length,
  text: host.shadowRoot.querySelector('.body').innerText
}));
console.log(JSON.stringify({ errors, summary, setup }, null, 2));
await browser.close();
