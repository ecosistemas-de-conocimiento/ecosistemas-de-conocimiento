import { defineConfig, devices } from '@playwright/test';

/**
 * The evidence videos: one spec per role, each a walk through every screen
 * that role has, with the user story captioned at the bottom.
 *
 *   EVID_VIDEO=v1 pnpm --filter @edc/web exec playwright test -c e2e/evidencia
 *
 * Runs against DEV by default (`EVID_WEB_URL` overrides): that is where the
 * per-role demo accounts live. Videos land in `e2e/evidencia/.videos/<EVID_VIDEO>/<rol>.webm`.
 *
 * 🔴 Everything a run creates is named `evid-<timestamp>` and deleted by the
 * run's own last stories. It never decides a hold, changes a role, flips a
 * switch or publishes: those stories are shown, not done (`historias.ts`).
 */
export default defineConfig({
  testDir: '.',
  // One folder per recording (`EVID_VIDEO=v1`), so V1, V2 and V3 sit side by side.
  // ⚠ Playwright EMPTIES outputDir at the start of every run, so a re-run of one
  // role would delete the others' videos: runs write to `.corrida/` and
  // `correr.sh` copies each finished video up to `<video>/<rol>.webm`.
  outputDir: `./.videos/${process.env.EVID_VIDEO ?? 'borrador'}/.corrida`,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  timeout: 15 * 60 * 1000,
  expect: { timeout: 20_000 },
  reporter: [['list']],
  use: {
    baseURL: process.env.EVID_WEB_URL ?? 'https://dev.ecosistemasdeconocimiento.com',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    actionTimeout: 30_000,
    navigationTimeout: 45_000,
    locale: 'es-MX',
    timezoneId: 'America/Mexico_City',
    // Same pacing as the journey suite: a human has to follow the recording.
    launchOptions: { slowMo: 350 },
  },
  projects: [
    {
      name: 'chromium',
      // Every role but participante, on a desk.
      testIgnore: /participante\.spec\.ts/,
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1440, height: 900 },
        video: { mode: 'on', size: { width: 1440, height: 900 } },
      },
    },
    {
      // The participante video is recorded on a phone (owner request 2026-10-28):
      // that is the screen participants use. Chromium with Pixel 7's touch and
      // mobile flags, at an iPhone-size 390x844 viewport.
      name: 'movil',
      testMatch: /participante\.spec\.ts/,
      use: {
        ...devices['Pixel 7'],
        viewport: { width: 390, height: 844 },
        // ⚠ The video is twice the viewport, same shape: at 1x the frames are
        // 390px wide and the text is a blur. Chromium hands the screencast over
        // at device pixels, so DPR 2 is what makes the 2x video sharp.
        deviceScaleFactor: 2,
        video: { mode: 'on', size: { width: 780, height: 1688 } },
      },
    },
  ],
});
