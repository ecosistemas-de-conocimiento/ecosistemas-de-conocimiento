import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end config for `@edc/web`, driving the LIVE local stack.
 *
 * ⚠ There is NO `webServer` block on purpose. These tests talk to the running
 * docker-compose stack (`infra/`), because the things they exercise — ingest,
 * transcription, publication, RAG retrieval — only exist when the backend,
 * ai-service and audio-service are all up. A Playwright-managed `vite dev`
 * would boot the UI and none of the pipeline behind it.
 *
 * 🔴 `slowMo: 350` is a REQUIREMENT, not a debugging leftover. The run is
 * recorded, and 350 ms between actions is what makes the recording legible to
 * a human watching it. Do not "optimise" it away, and do not simulate it with
 * scattered `waitForTimeout` calls — `slowMo` paces every action uniformly,
 * including the ones inside `expect` polling.
 *
 * Videos land at `e2e/.artifacts/<test-dir>/video.webm`, one per test, kept
 * regardless of pass/fail (`video: 'on'`).
 */
export default defineConfig({
  testDir: './e2e',

  // Predictable, easy to find, and gitignored. `video: 'on'` writes
  // `<outputDir>/<file>-<title>-<project>/video.webm`.
  outputDir: './e2e/.artifacts',

  // One browser, one worker, no retries. The suite mutates a shared live stack
  // and a second concurrent run would interleave rows in the same database.
  // A retry would also throw away the first attempt's video, which is the
  // artefact this suite exists to produce.
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,

  // Generous: the journey uploads audio and waits for a real transcription
  // (~9 s) plus ingest and publication polling on top.
  timeout: 15 * 60 * 1000,
  expect: { timeout: 20_000 },

  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: './e2e/.report' }],
  ],

  use: {
    baseURL: process.env.EDC_WEB_URL ?? 'http://localhost:45400',

    // 🔴 The user asked for a video of the run, pass or fail.
    video: 'on',
    trace: 'on',
    screenshot: 'only-on-failure',

    actionTimeout: 30_000,
    navigationTimeout: 45_000,

    // Spanish UI, and the browser locale leaks into `Intl` formatting.
    locale: 'es-MX',
    timezoneId: 'America/Mexico_City',

    launchOptions: {
      // 🔴 350 ms between every action — see the note above.
      slowMo: 350,
    },
  },

  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        // AFTER the spread: `devices` carries its own 1280×720 viewport, and
        // the video is recorded at the viewport size. The three-pane layout
        // (sidebar · chat · documents) needs the width to be readable.
        viewport: { width: 1440, height: 900 },
      },
    },
  ],
});
