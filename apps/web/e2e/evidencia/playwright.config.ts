import { resolve } from 'node:path';
import { defineConfig, devices } from '@playwright/test';

/**
 * What the participante's fake microphone "says" (B3.1). Built ON THE HOST by
 * `correr.sh` with ffmpeg (the Playwright image has none, checked 2026-10-28)
 * from media/voces/SIM_0017: 25 s, mono, 48 kHz.
 */
const DICTADO_WAV = process.env.EVID_DICTADO_WAV ?? resolve(import.meta.dirname, '.videos/_audio/SIM_0017.wav');

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
        deviceScaleFactor: 2,
        // 🔴 Video size = viewport. Playwright's screencast is in CSS pixels and is
        // NOT scaled up to a larger video size: at 780x1688 the page filled only
        // the top-left 390x844 and the rest was grey canvas (V2, caught by the
        // owner 2026-10-28). Measure with the margin check before trusting a video.
        video: { mode: 'on', size: { width: 390, height: 844 } },
        // The mic stories (B3.1): Chromium's fake capture device plays the WAV
        // into getUserMedia at real-time pace, like a person talking.
        // ⚠ A project's launchOptions REPLACES the top-level one: slowMo again.
        permissions: ['microphone'],
        launchOptions: {
          slowMo: 350,
          args: [
            '--use-fake-ui-for-media-stream',
            '--use-fake-device-for-media-stream',
            `--use-file-for-fake-audio-capture=${DICTADO_WAV}%noloop`,
          ],
        },
      },
    },
  ],
});
