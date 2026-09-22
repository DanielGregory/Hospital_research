/**
 * Browser smoke test: builds nothing itself (run `pnpm --filter @er/game build` first),
 * serves apps/game/dist, and plays levels 1 and 2 in Chromium.
 *
 *   pnpm e2e            # build + run
 *   SCREENSHOTS=dir pnpm e2e
 */
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium, type Page } from 'playwright-core';

const PORT = 4179;
const root = resolve(import.meta.dirname, '..');
const shots = process.env.SCREENSHOTS;
if (shots) mkdirSync(shots, { recursive: true });

function fail(msg: string): never {
  throw new Error(msg);
}

async function shot(page: Page, name: string) {
  if (shots) await page.screenshot({ path: resolve(shots, `${name}.png`), fullPage: true });
}

async function main() {
  const vite = resolve(root, 'node_modules/.bin/vite');
  const server = spawn(vite, ['preview', '--port', String(PORT), '--strictPort'], { cwd: root, stdio: 'pipe', detached: true });
  const stop = () => {
    try {
      process.kill(-server.pid!, 'SIGTERM'); // whole process group
    } catch {
      // already gone
    }
  };
  try {
    await new Promise<void>((ok, bad) => {
      const t = setTimeout(() => bad(new Error('preview server did not start')), 20_000);
      server.stdout.on('data', (d: Buffer) => {
        if (d.toString().includes(String(PORT))) {
          clearTimeout(t);
          ok();
        }
      });
    });
    const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium' });
    try {
      for (const scheme of ['light', 'dark'] as const) {
        const page = await browser.newPage({ viewport: { width: 1200, height: 900 }, colorScheme: scheme });
        const errors: string[] = [];
        page.on('pageerror', (e) => errors.push(e.message));
        page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
        await page.goto(`http://localhost:${PORT}/`);
        await shot(page, `menu-${scheme}`);
        await page.getByTestId('level-1').click();
        await shot(page, `briefing-${scheme}`);
        await page.getByTestId('continue').click();

        // Level 1, as shipped (arrival order): should fail on its fixed night.
        await page.getByTestId('start').click();
        await page.getByTestId('speed-8').click();
        await page.waitForTimeout(1500);
        const clock1 = await page.getByTestId('clock').textContent();
        await page.waitForTimeout(500);
        const clock2 = await page.getByTestId('clock').textContent();
        if (clock1 === clock2) fail(`clock did not advance at 8x (${clock1})`);
        await shot(page, `play-${scheme}`);
        await page.getByTestId('skip').click();
        const r1 = await page.getByTestId('result').textContent();
        if (r1 !== 'Goals not met') fail(`level 1 with arrival order: expected failure, got "${r1}"`);

        // Retry with acuity order: should pass and unlock "next".
        await page.getByTestId('retry').click();
        await page.getByTestId('discipline-acuity').check();
        await page.getByTestId('start').click();
        await page.getByTestId('skip').click();
        const r2 = await page.getByTestId('result').textContent();
        if (r2 !== 'Goals met') fail(`level 1 with acuity order: expected pass, got "${r2}"`);
        await shot(page, `debrief-${scheme}`);

        // Level 2 setup screen with the schedule editor.
        await page.getByTestId('next').click();
        await page.getByTestId('continue').click();
        await page.getByTestId('schedule-doctor').waitFor();
        await shot(page, `setup-${scheme}`);

        // Level 5: boarding view renders and plays to the end.
        await page.goto(`http://localhost:${PORT}/`);
        await page.getByTestId('level-5').click();
        await page.getByTestId('continue').click();
        await page.getByTestId('escalation').check();
        await page.getByTestId('fasttrack-enabled').check();
        await page.getByTestId('start').click();
        await page.getByTestId('speed-8').click();
        await page.waitForTimeout(2500);
        await shot(page, `play-boarding-${scheme}`);
        await page.getByTestId('skip').click();
        const r5 = await page.getByTestId('result').textContent();
        if (r5 !== 'Goals met') fail(`level 5 with the reference plan: expected pass, got "${r5}"`);

        // Layout editor: draw an extra acute room, test the plan, watch a shift on the grid view.
        await page.goto(`http://localhost:${PORT}/`);
        await page.getByTestId('layout-editor').click();
        const grid = page.getByTestId('layout-grid');
        const box = (await grid.boundingBox())!;
        const at = (cx: number, cy: number) => ({ x: box.x + ((cx + 0.5) / 24) * box.width, y: box.y + ((cy + 0.5) / 14) * box.height });
        await page.getByTestId('tool-acute').click();
        const a = at(18, 8);
        const b = at(21, 11);
        await page.mouse.move(a.x, a.y);
        await page.mouse.down();
        await page.mouse.move(b.x, b.y, { steps: 5 });
        await page.mouse.up();
        if (!(await page.getByText('Acute beds (4×4)').count())) fail('dragging on the grid did not add a room');
        await page.getByTestId('test-layout').click();
        await page.getByTestId('layout-score').waitFor();
        await shot(page, `layout-editor-${scheme}`);
        await page.getByTestId('play-layout').click();
        await page.getByTestId('speed-8').click();
        await page.waitForTimeout(3000);
        await shot(page, `play-grid-${scheme}`);
        await page.getByTestId('skip').click();
        if ((await page.getByTestId('result').textContent()) !== 'Shift complete') fail('sandbox run did not finish');

        // Sandbox: everything on, with the process editor; test and watch.
        await page.goto(`http://localhost:${PORT}/`);
        await page.getByTestId('sandbox').click();
        await page.getByTestId('preset-everything').click();
        await page.getByTestId('process-editor').waitFor();
        await page.getByTestId('sandbox-test').click();
        await page.getByTestId('sandbox-score').waitFor({ timeout: 20_000 });
        await shot(page, `sandbox-${scheme}`);
        await page.getByTestId('sandbox-play').click();
        await page.getByTestId('speed-8').click();
        await page.waitForTimeout(1500);
        await page.getByTestId('skip').click();
        if ((await page.getByTestId('result').textContent()) !== 'Shift complete') fail('sandbox (everything on) did not finish');
        await shot(page, `sandbox-debrief-${scheme}`);

        // Level 7 shows the budget line and blocks an over-budget plan.
        await page.goto(`http://localhost:${PORT}/`);
        await page.getByTestId('level-7').click();
        await page.getByTestId('continue').click();
        await page.getByTestId('budget-line').waitFor();
        await shot(page, `setup-budget-${scheme}`);

        // Mobile width: no horizontal scroll on the menu.
        await page.setViewportSize({ width: 375, height: 800 });
        await page.goto(`http://localhost:${PORT}/`);
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
        if (overflow) fail('menu scrolls horizontally at 375px');
        await shot(page, `menu-mobile-${scheme}`);

        if (errors.length) fail(`browser errors: ${errors.join(' | ')}`);
        await page.close();
      }
      console.log('e2e smoke: OK');
    } finally {
      await browser.close();
    }
  } finally {
    stop();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
