/// <reference lib="dom" />
// The page.evaluate callbacks below run in the browser, so this file also needs the DOM types.
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';

// Text must stay readable: a contrast ratio of at least 4.5:1 (WCAG 2.2 AA for normal text)
// against its own background. 0.7.0 to 0.8.0 shipped light-theme text on the dark-mode Overview
// tiles (number #111111 on #1c1c1a) and white text on the brand orange (2.47:1) in both themes.

const CLI = fileURLToPath(new URL('../../../packages/cli/dist/main.js', import.meta.url));
const MIN_RATIO = 4.5;

let ui: ChildProcess | undefined;
let home: string | undefined;
test.afterEach(() => {
  ui?.kill('SIGTERM');
  ui = undefined;
  if (home !== undefined) rmSync(home, { recursive: true, force: true });
  home = undefined;
});

async function startUi(mode: 'enforce' | 'observe'): Promise<string> {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'sw-e2e-contrast-')));
  const cfg = join(home, 'sw.json');
  writeFileSync(cfg, JSON.stringify({ mode, approvals: { notify: false } }));
  const env = {
    PATH: process.env['PATH'] ?? '',
    HOME: home,
    USERPROFILE: home,
    XDG_STATE_HOME: home,
    XDG_CONFIG_HOME: home,
  };
  const child = spawn(process.execPath, [CLI, 'ui', '--config', cfg], {
    env,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  ui = child;
  return new Promise<string>((resolve, reject) => {
    let out = '';
    child.stdout.on('data', (c: Buffer) => {
      out += c.toString();
      const m = /SudoWall UI: (\S+)/.exec(out);
      if (m?.[1] !== undefined) resolve(m[1]);
    });
    child.on('exit', (code) => {
      reject(new Error(`ui exited with ${String(code)}`));
    });
  });
}

interface Contrast {
  name: string;
  color: string;
  background: string;
  ratio: number;
}

/** Contrast of each element's text against the first opaque background at or above it. */
async function contrastOf(page: Page, selector: string): Promise<Contrast[]> {
  return page.locator(selector).evaluateAll((els): Contrast[] => {
    const rgb = (css: string): [number, number, number, number] => {
      const m = /rgba?\(([^)]+)\)/.exec(css);
      if (m?.[1] === undefined) throw new Error(`unexpected colour ${css}`);
      const p = m[1]
        .split(/[\s,/]+/)
        .filter(Boolean)
        .map(Number);
      return [p[0] ?? 0, p[1] ?? 0, p[2] ?? 0, p[3] ?? 1];
    };
    const luminance = ([r, g, b]: [number, number, number, number]) => {
      const lin = (c: number) => {
        const s = c / 255;
        return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
    };
    const background = (el: Element): string => {
      for (let n: Element | null = el; n !== null; n = n.parentElement) {
        const bg = getComputedStyle(n).backgroundColor;
        const alpha = rgb(bg)[3];
        if (alpha === 1) return bg;
        if (alpha !== 0) throw new Error(`translucent background ${bg}`);
      }
      return getComputedStyle(document.body).backgroundColor;
    };
    return els.map((el) => {
      const cls = el.getAttribute('class') ?? '';
      const style = getComputedStyle(el);
      if (Number(style.opacity) !== 1) throw new Error(`${cls} has opacity`);
      const color = style.color;
      const bg = background(el);
      const [l1, l2] = [luminance(rgb(color)), luminance(rgb(bg))];
      const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
      const tile = el.closest('.stat')?.querySelector('.l')?.textContent;
      const name = tile !== undefined ? `tile "${tile}" ${cls}` : cls;
      return { name, color, background: bg, ratio };
    });
  });
}

function belowMinimum(measured: Contrast[]): string[] {
  return measured
    .filter((m) => m.ratio < MIN_RATIO)
    .map((m) => `${m.name}: ${m.color} on ${m.background} = ${m.ratio.toFixed(2)}:1`);
}

test.describe('dark mode', () => {
  test.use({ colorScheme: 'dark' });

  for (const mode of ['enforce', 'observe'] as const) {
    test(`every Overview tile's number and label is readable (${mode})`, async ({ page }) => {
      await page.goto(await startUi(mode));
      // enforce: checked, blocked, paused, allowed; observe: checked, would block, would ask, allowed.
      await expect(page.locator('.stats .stat')).toHaveCount(4);
      await expect(page.getByText('actions checked')).toBeVisible();
      const measured = await contrastOf(page, '.stats .stat .n, .stats .stat .l');
      expect(measured).toHaveLength(8);
      expect(belowMinimum(measured), `tiles below ${String(MIN_RATIO)}:1`).toEqual([]);
    });
  }
});

for (const scheme of ['light', 'dark'] as const) {
  test.describe(`${scheme} mode`, () => {
    test.use({ colorScheme: scheme });

    test('text on the brand orange is readable', async ({ page }) => {
      // Watching only: the sidebar's mode pill and the "would have been blocked" tile are orange.
      await page.goto(await startUi('observe'));
      await expect(page.locator('.side-mode.off')).toBeVisible();
      // The pending count, an ask badge and the pending strip need a paused call; the test adds
      // elements with the app's own markup so that the stylesheet is what is checked.
      await page.evaluate(() => {
        const link = [...document.querySelectorAll('.side li a')].find(
          (a) => a.textContent === 'Approvals',
        );
        if (link === undefined) throw new Error('no Approvals link');
        link.insertAdjacentHTML('beforeend', '<span class="count">1</span>');
        document
          .querySelector('main')
          ?.insertAdjacentHTML(
            'afterbegin',
            '<button type="button" class="pending-strip">1 action is waiting for your decision</button>' +
              '<p><span class="badge ask">asks you</span></p>',
          );
      });
      const measured = await contrastOf(
        page,
        '.side li a .count, .side-mode.off, .pending-strip, .badge.ask, .stat.block .n, .stat.block .l',
      );
      expect(measured).toHaveLength(6);
      expect(belowMinimum(measured), `orange elements below ${String(MIN_RATIO)}:1`).toEqual([]);
    });
  });
}
