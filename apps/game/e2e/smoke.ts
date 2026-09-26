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

/** Click through any tip or alert that paused the game. */
async function unhold(page: Page) {
  for (let i = 0; i < 5; i++) {
    const b = page.getByTestId('resume');
    if (!(await b.isVisible().catch(() => false))) return;
    await b.click();
  }
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
    // Software WebGL so the 3D view renders without a GPU.
    const browser = await chromium.launch({
      executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium',
      args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader'],
    });
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

        // Level 1, as shipped (arrival order): should fail on its fixed night. The tutorial pauses for its first tip.
        await page.getByTestId('start').click();
        await page.getByTestId('resume').waitFor();
        await shot(page, `coach-${scheme}`);
        await unhold(page);
        await page.getByTestId('auto-pause').uncheck();
        await page.getByTestId('speed-8').click();
        await page.waitForTimeout(1500);
        await unhold(page);
        const clock1 = await page.getByTestId('clock').textContent();
        await page.waitForTimeout(500);
        const clock2 = await page.getByTestId('clock').textContent();
        if (clock1 === clock2) fail(`clock did not advance at 8x (${clock1})`);
        // The 3D view is the default; the 2D view is one click away and the choice sticks.
        await page.getByTestId('floor-3d').waitFor();
        await shot(page, `play-${scheme}`);
        await page.getByTestId('view-2d').click();
        await page.getByTestId('floor-2d').waitFor();
        await page.waitForTimeout(300);
        await shot(page, `play-2d-${scheme}`);
        await page.getByTestId('view-3d').click();
        await page.getByTestId('floor-3d').waitFor();
        await page.getByTestId('skip').click();
        const r1 = await page.getByTestId('result').textContent();
        if (r1 !== 'Goals not met') fail(`level 1 with arrival order: expected failure, got "${r1}"`);
        await page.getByTestId('why').waitFor();
        await page.getByTestId('stories').waitFor();
        if ((await page.getByTestId('stars').getAttribute('aria-label')) !== '0 of 3 stars') fail('a failed level should earn no stars');

        // Retry with acuity order: should pass and unlock "next".
        await page.getByTestId('retry').click();
        await page.getByTestId('discipline-acuity').check();
        await page.getByTestId('start').click();
        await page.getByTestId('skip').click();
        const r2 = await page.getByTestId('result').textContent();
        if (r2 !== 'Goals met') fail(`level 1 with acuity order: expected pass, got "${r2}"`);
        if ((await page.getByTestId('stars').getAttribute('aria-label')) === '0 of 3 stars') fail('a passed level should earn stars');
        await shot(page, `debrief-${scheme}`);

        // Level 2 setup screen with the schedule editor.
        await page.getByTestId('next').click();
        await page.getByTestId('continue').click();
        await page.getByTestId('schedule-doctor').waitFor();
        await shot(page, `setup-${scheme}`);

        // Beat the best found: reveal it, load it, play it; the debrief compares (matching is not beating).
        await page.getByTestId('benchmark').waitFor();
        await page.getByTestId('benchmark-reveal').click();
        await shot(page, `benchmark-${scheme}`);
        await page.getByTestId('benchmark-use').click();
        await page.getByTestId('start').click();
        await unhold(page);
        await page.getByTestId('skip').click();
        const bm = await page.getByTestId('benchmark-result').textContent();
        if (!bm?.includes('Best found on this shift')) fail(`benchmark comparison missing: ${bm}`);
        if ((await page.getByTestId('result').textContent()) !== 'Goals met') fail('the best found setup should meet the level 2 goals');

        // Career: found a hospital, buy an upgrade, simulate a week, then run one live.
        await page.goto(`http://localhost:${PORT}/`);
        await page.getByTestId('career').click();
        await page.getByTestId('career-name').fill('Test General');
        await page.getByTestId('career-start').click();
        await page.getByTestId('career-hq').waitFor();
        const before = await page.getByTestId('career-money').textContent();
        await page.getByTestId('buy-triageTraining').click();
        if ((await page.getByTestId('career-money').textContent()) === before) fail('buying an upgrade did not cost money');
        await shot(page, `career-hq-${scheme}`);
        await page.getByTestId('career-simulate').click();
        await page.getByTestId('career-week').waitFor({ timeout: 20_000 });
        await page.getByTestId('ledger').waitFor();
        await shot(page, `career-week-${scheme}`);
        await page.getByTestId('career-continue').click();
        await page.getByTestId('chart-score').waitFor();
        await page.getByTestId('career-play').click();
        await page.getByTestId('speed-8').click();
        await page.waitForTimeout(1500);
        await unhold(page);
        await page.getByTestId('skip').click();
        await page.getByTestId('career-week').waitFor({ timeout: 20_000 });
        await page.getByTestId('career-continue').click();
        await page.reload();
        await page.getByTestId('career').click();
        if (!(await page.getByTestId('career-hq').textContent())?.includes('week 3')) fail('career did not save two weeks');
        await shot(page, `career-history-${scheme}`);

        // Endless sandbox: runs until stopped, then shows results so far.
        await page.goto(`http://localhost:${PORT}/`);
        await page.getByTestId('sandbox').click();
        await page.getByTestId('sandbox-endless').click();
        await page.getByTestId('endless-day').waitFor();
        await page.getByTestId('speed-8').click();
        await page.waitForTimeout(1500);
        await unhold(page);
        await page.getByTestId('stop-here').click();
        if ((await page.getByTestId('result').textContent()) !== 'Shift complete') fail('stopping an endless run did not show results');

        // Level 6: the incident is announced and pauses the game; call in help; change the process mid-shift.
        await page.goto(`http://localhost:${PORT}/`);
        await page.getByTestId('level-6').click();
        await page.getByTestId('continue').click();
        await page.getByTestId('start').click();
        await page.getByTestId('auto-pause').check();
        await page.getByTestId('speed-8').click();
        await page.getByText('Major incident declared').first().waitFor({ timeout: 20_000 });
        await shot(page, `incident-${scheme}`);
        await page.getByTestId('resume').click();
        await page.getByTestId('call-in').click();
        await page.getByText(/On the way: here in/).waitFor();
        await page.getByTestId('adjust-plan').click();
        await page.getByTestId('process-editor').waitFor();
        await shot(page, `plan-drawer-${scheme}`);
        await page.getByTestId('apply-plan').click();
        await unhold(page);
        await page.getByTestId('skip').click();
        await page.getByTestId('why').waitFor();
        await shot(page, `debrief-why-${scheme}`);

        // Daily challenge: the menu card opens the day's level with a note, and the debrief offers a share line.
        await page.goto(`http://localhost:${PORT}/`);
        await page.getByTestId('daily').click();
        await page.getByTestId('daily-note').waitFor();
        await page.getByTestId('continue').click();
        await page.getByTestId('start').click();
        await unhold(page);
        await page.getByTestId('skip').click();
        const share = await page.getByTestId('share-text').textContent();
        if (!share?.includes('ER Shift daily')) fail(`daily share text missing: ${share}`);

        // Level 5: boarding view renders and plays to the end.
        await page.goto(`http://localhost:${PORT}/`);
        await page.getByTestId('level-5').click();
        await page.getByTestId('continue').click();
        await page.getByTestId('escalation').check();
        await page.getByTestId('fasttrack-enabled').check();
        await page.getByTestId('start').click();
        await page.getByTestId('speed-8').click();
        await page.waitForTimeout(2500);
        await unhold(page);
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
        await page.getByTestId('undo').click();
        if (await page.getByText('Acute beds (4×4)').count()) fail('undo did not remove the room');
        await page.getByTestId('redo').click();
        if (!(await page.getByText('Acute beds (4×4)').count())) fail('redo did not bring the room back');
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

        // Level 8: design the floor. The architect's draft fails; the best found plan passes; the debrief maps the walking.
        await page.goto(`http://localhost:${PORT}/`);
        await page.getByTestId('level-8').click();
        await page.getByTestId('continue').click();
        await page.getByTestId('plan-section').waitFor();
        await page.getByTestId('layout-hints').waitFor();
        await page.getByTestId('test-plan').click();
        await page.getByTestId('plan-test').getByTestId('walk-map').waitFor({ timeout: 20_000 });
        await shot(page, `design-${scheme}`);
        await page.getByTestId('start').click();
        await unhold(page);
        await page.getByTestId('skip').click();
        if ((await page.getByTestId('result').textContent()) !== 'Goals not met') fail("level 8: the architect's draft should fail");
        await page.getByTestId('walk-map').waitFor();
        await shot(page, `design-debrief-${scheme}`);
        await page.getByTestId('retry').click();
        await page.getByTestId('benchmark-reveal').click();
        await page.getByTestId('benchmark-use').click();
        await page.getByTestId('start').click();
        await page.getByTestId('speed-8').click();
        await page.waitForTimeout(1500);
        await unhold(page);
        await shot(page, `design-play-${scheme}`);
        await page.getByTestId('skip').click();
        if ((await page.getByTestId('result').textContent()) !== 'Goals met') fail('level 8: the best found plan should meet the goals');

        // Planner: fit the model to the sample visits, run what-ifs, read results, watch one, print the report.
        await page.goto(`http://localhost:${PORT}/`);
        await page.getByTestId('planner-card').click();
        await page.getByTestId('use-sample').click();
        await page.getByTestId('fit-model').click();
        await page.getByTestId('baseline-check').waitFor({ timeout: 90_000 });
        await shot(page, `planner-check-${scheme}`);
        await page.getByTestId('module-security').check();
        await page.getByTestId('module-nursing').check();
        await page.getByTestId('module-diagnostics').check();
        await page.getByTestId('separate-units').check();
        await page.getByTestId('diagnostics-card').waitFor();
        await shot(page, `planner-department-${scheme}`);
        await page.getByTestId('to-scenarios').click();
        await page.getByTestId('add-template').selectOption('security');
        await page.getByTestId('add-scenario').click();
        await page.getByTestId('add-template').selectOption('icuBeds');
        await page.getByTestId('add-scenario').click();
        await page.getByTestId('weeks').selectOption('5');
        await page.getByTestId('run-scenarios').click();
        await page.getByTestId('results-table').waitFor({ timeout: 90_000 });
        await page.getByTestId('forest-plot').waitFor();
        await page.getByTestId('bottlenecks').waitFor();
        await shot(page, `planner-results-${scheme}`);
        await page.getByTestId('watch-baseline').click();
        await page.getByTestId('speed-8').click();
        await page.waitForTimeout(1500);
        await unhold(page);
        await page.getByTestId('skip').click();
        await page.getByTestId('retry').click();
        await page.getByTestId('tab-report').click();
        await page.getByTestId('report').waitFor();
        await shot(page, `planner-report-${scheme}`);

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
