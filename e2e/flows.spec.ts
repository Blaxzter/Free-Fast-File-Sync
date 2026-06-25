import { test, expect, type Page } from "@playwright/test";

/* Tier-1 mocked-IPC flow tests. Each test selects a fakeEngine scenario by
 * setting window.__E2E_SCENARIO__ BEFORE the app boots (addInitScript), then
 * drives the real Jobs list -> Job detail -> preview/resolve/apply UI.
 *
 * Selectors are the production DOM the user actually sees:
 *  - the jobs list row button (data-job-id)
 *  - Compare / Apply / Cancel buttons (accessible names)
 *  - per-pair sections (data-pair-id from the PreviewJobResult wrapper)
 *  - the conflict <select> (combobox), the big-delete confirm checkbox
 *  - meaning-driven labels/banners (ACTION_MEANING, BASELINE_MEANING)
 * No engine label/color is hardcoded in a component; all of it flows from
 * domain/meaning.ts, so these assertions also pin the meaning map. */

async function gotoScenario(page: Page, scenario: string) {
  await page.addInitScript((s) => {
    (window as unknown as { __E2E_SCENARIO__: string }).__E2E_SCENARIO__ = s;
  }, scenario);
  await page.goto("/");
  // Wait until the fake engine registered + the app mounted.
  await page.waitForFunction(() => (window as unknown as { __E2E_READY__?: boolean }).__E2E_READY__ === true);
  // The jobs list renders the seeded job row.
  await page.getByRole("button", { name: /job/i }).first().waitFor();
}

async function openJob(page: Page) {
  // The first job row opens the detail route.
  await page.locator("[data-job-id]").first().click();
  await page.getByRole("button", { name: /^Compare/ }).waitFor();
}

function compareBtn(page: Page) {
  return page.getByRole("button", { name: /^(Compare|Comparing)/ });
}
function applyBtn(page: Page) {
  return page.getByRole("button", { name: /^Apply/ });
}
function cancelBtn(page: Page) {
  return page.getByRole("button", { name: /^Cancel/ });
}

test.describe("Tier-1 mocked-IPC flows", () => {
  test("happy-path converge: preview -> resolve EditEdit -> apply -> report -> re-preview all Noop", async ({
    page,
  }) => {
    await gotoScenario(page, "converge");
    await openJob(page);

    await compareBtn(page).click();

    // One pair section appears.
    const section = page.locator("[data-pair-id]").first();
    await expect(section).toBeVisible();

    // The EditEdit conflict row preselects its default_resolution (KeepNewer).
    const select = section.getByRole("combobox").first();
    await expect(select).toHaveValue("KeepNewer");
    // Conflict is already resolved by the default -> Apply is enabled.
    await expect(applyBtn(page)).toBeEnabled();

    // Apply runs the (faked) engine; the run report banner appears.
    await applyBtn(page).click();
    await expect(page.getByText(/Synced:/)).toBeVisible();

    // Re-preview converges: every row is Noop, so with "show in-sync" off the
    // grid shows the in-sync empty state and there are no actionable rows.
    await compareBtn(page).click();
    await expect(page.getByText(/Everything is in sync/i)).toBeVisible();
    // Apply has nothing applicable -> disabled.
    await expect(applyBtn(page)).toBeDisabled();
  });

  test("mirror mode shows DeleteB rows colored via ACTION_MEANING", async ({ page }) => {
    await gotoScenario(page, "mirror");
    await openJob(page);
    await compareBtn(page).click();

    const section = page.locator("[data-pair-id]").first();
    await expect(section).toBeVisible();

    // ACTION_MEANING.DeleteB.label === "del B" — rendered by ActionBadge. The
    // label comes ONLY from meaning.ts, so this pins the map too.
    await expect(section.getByText("del B").first()).toBeVisible();
    // The dir column uses ACTION_MEANING fg via a CSS var; assert the row exists
    // by its data-action class (set from actionClass(action)).
    await expect(section.locator('[data-action="del"]').first()).toBeVisible();

    // No conflicts in a clean mirror -> Apply enabled immediately.
    await expect(applyBtn(page)).toBeEnabled();
  });

  test("big-delete gate blocks apply until confirmed", async ({ page }) => {
    await gotoScenario(page, "big-delete");
    await openJob(page);
    await compareBtn(page).click();

    const section = page.locator("[data-pair-id]").first();
    await expect(section).toBeVisible();

    // The large-deletion guard banner is present and Apply is blocked.
    await expect(page.getByText(/Large deletion guard/i)).toBeVisible();
    await expect(applyBtn(page)).toBeDisabled();

    // Confirm the deletions -> Apply unlocks.
    await section.getByRole("checkbox", { name: /allow the deletions/i }).check();
    await expect(applyBtn(page)).toBeEnabled();
  });

  test("first-sync banner: union only, no delete rows", async ({ page }) => {
    await gotoScenario(page, "first-sync");
    await openJob(page);
    await compareBtn(page).click();

    const section = page.locator("[data-pair-id]").first();
    await expect(section).toBeVisible();

    // BASELINE_MEANING.FirstSync.label — the union-only trust banner copy.
    await expect(section.getByText(/First sync/i)).toBeVisible();
    await expect(section.getByText(/union only/i)).toBeVisible();
    // Union-only: there are copies but NO delete rows.
    await expect(section.locator('[data-action="del"]')).toHaveCount(0);
  });

  test("corrupt-baseline banner: safe union fallback, no delete rows", async ({ page }) => {
    await gotoScenario(page, "corrupt-baseline");
    await openJob(page);
    await compareBtn(page).click();

    const section = page.locator("[data-pair-id]").first();
    await expect(section).toBeVisible();
    // BASELINE_MEANING.Corrupt.label.
    await expect(section.getByText(/Baseline unreadable/i)).toBeVisible();
    await expect(section.locator('[data-action="del"]')).toHaveCount(0);
  });

  test("scan-error suppression surfaces a warning, sync continues", async ({ page }) => {
    await gotoScenario(page, "scan-error");
    await openJob(page);
    await compareBtn(page).click();

    const section = page.locator("[data-pair-id]").first();
    await expect(section).toBeVisible();
    // The suppressed scan error is surfaced as a plan warning banner...
    await expect(page.getByText(/permission denied/i)).toBeVisible();
    // ...and the actionable row is still there + appliable.
    await expect(applyBtn(page)).toBeEnabled();
  });

  test("cancel during apply returns the run mirror to idle", async ({ page }) => {
    await gotoScenario(page, "cancel");
    await openJob(page);
    await compareBtn(page).click();

    await expect(applyBtn(page)).toBeEnabled();
    await applyBtn(page).click();

    // The apply hangs in "applying": the live run strip is visible and Cancel is
    // enabled.
    await expect(page.getByLabel("run progress")).toBeVisible();
    await expect(cancelBtn(page)).toBeEnabled();

    // Cancel -> the fake emits run://finished, returning the mirror to idle: the
    // strip disappears and Compare is usable again.
    await cancelBtn(page).click();
    await expect(page.getByLabel("run progress")).toHaveCount(0);
    await expect(compareBtn(page)).toBeEnabled();
    // The store's active run cleared (mirror back to idle).
    await expect
      .poll(() =>
        page.evaluate(() => {
          // The strip is the UI proxy for an active run; gone => idle.
          return document.querySelector('[aria-label="run progress"]') === null;
        }),
      )
      .toBe(true);
  });
});
