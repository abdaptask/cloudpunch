import { expect, test } from '@playwright/test';
import { mockApi, scrollsSideways } from './api.js';

/**
 * The web app in a real browser (item 9), at desktop width and on a
 * phone (item 6): Team, a person's day, the day summary, the admin
 * console, Shifts and the Overview. The page must never scroll
 * sideways; wide tables scroll inside their own box.
 */

test.beforeEach(async ({ page }) => {
  await mockApi(page);
});

test('Team today lists the team, and a person opens their day', async ({ page }) => {
  await page.goto('/app/');
  const today = page.getByRole('list', { name: 'team-today' });
  await expect(today.getByText('Roshni Sahani')).toBeVisible();
  await expect(today.getByText('Farheen Khanam')).toBeVisible();
  expect(await scrollsSideways(page)).toBe(false);

  await today.getByRole('button', { name: /Roshni Sahani/ }).click();
  await expect(page.getByRole('heading', { name: 'Roshni Sahani' })).toBeVisible();
  expect(await scrollsSideways(page)).toBe(false);
});

test('Team → Day summary shows problems first and opens a person', async ({ page }) => {
  await page.goto('/app/');
  await page.getByRole('tab', { name: 'Day summary' }).click();
  const list = page.getByRole('list', { name: 'day-summary' });
  await expect(list.getByRole('button').first()).toContainText('Nilesh Darekar');
  await expect(page.getByLabel('summary-headline')).toContainText('1 not clocked in');
  expect(await scrollsSideways(page)).toBe(false);
  await list.getByRole('button', { name: /Farheen Khanam/ }).click();
  await expect(page.getByRole('heading', { name: 'Farheen Khanam' })).toBeVisible();
});

test('Team → Exceptions loads', async ({ page }) => {
  await page.goto('/app/');
  await page.getByRole('tab', { name: 'Exceptions' }).click();
  await expect(page.getByRole('tab', { name: 'Exceptions' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  expect(await scrollsSideways(page)).toBe(false);
});

test('the admin console moves between sections', async ({ page }) => {
  await page.goto('/app/admin/');
  const sections = page.getByRole('navigation', { name: 'admin-sections' });
  await expect(sections).toBeVisible();
  for (const name of ['People', 'Holidays', 'Rules', 'Computers', 'Reports']) {
    await sections.getByRole('button', { name, exact: true }).click();
    await expect(sections.getByRole('button', { name, exact: true })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(await scrollsSideways(page), `${name} scrolls sideways`).toBe(false);
  }
});

test('Shifts fits the window, wide or a phone', async ({ page }) => {
  await page.goto('/app/admin/');
  await page
    .getByRole('navigation', { name: 'admin-sections' })
    .getByRole('button', { name: 'Shifts', exact: true })
    .click();
  const india = page.getByRole('listitem', { name: 'named shift India day' });
  await expect(india).toBeVisible();
  await expect(india.getByLabel('people on India day')).toHaveText('14 people');
  // Nothing in the row runs past its edge or the window's (the console's
  // content scrolls on its own, so the page alone wouldn't show it).
  const width = page.viewportSize()?.width ?? 0;
  const spills = await india.evaluate((row, w) => {
    const edge = Math.min(row.getBoundingClientRect().right, w);
    return (
      row.scrollWidth > row.clientWidth + 1 ||
      [...row.querySelectorAll('*')].some((el) => el.getBoundingClientRect().right > edge + 1)
    );
  }, width);
  expect(spills).toBe(false);
  expect(await scrollsSideways(page)).toBe(false);
});

test('Reports → Overview loads its numbers and charts', async ({ page }) => {
  await page.goto('/app/admin/');
  await page
    .getByRole('navigation', { name: 'admin-sections' })
    .getByRole('button', { name: 'Reports', exact: true })
    .click();
  await page.getByRole('tab', { name: 'Overview' }).click();
  await expect(page.getByLabel('overview-totals')).toContainText('Attendance');
  await expect(page.getByRole('figure', { name: 'attendance-chart' })).toBeVisible();
  expect(await scrollsSideways(page)).toBe(false);
});

test('on a phone the console sections are a row across the top', async ({ page }, info) => {
  test.skip(info.project.name !== 'phone', 'phone layout only');
  await page.goto('/app/admin/');
  const nav = page.getByRole('navigation', { name: 'admin-sections' });
  const box = await nav.boundingBox();
  // Across the top, the full width, not a 200-wide column down the side.
  expect(box?.width ?? 0).toBeGreaterThan(300);
  expect(box?.height ?? 999).toBeLessThan(80);
  // Big enough to tap.
  const first = nav.getByRole('button').first();
  expect((await first.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(40);
});
