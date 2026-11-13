import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { adminCredentials } from './env';
import { startRecordingWithConsent } from './consent';

/**
 * Live mic: speak → partial text appears → stop → the recording uploads.
 *
 * The "speaker" is a FILE: Chrome's fake capture device plays a WAV into
 * getUserMedia at real-time pace, so MediaRecorder, the slices and the live
 * route run exactly as with a person talking.
 *
 * Needs ffmpeg on PATH (the m4a → wav conversion) and a stack whose
 * audio-service runs WHISPER_BACKEND=remote.
 *
 * Optional, for a host without the backend route deployed yet:
 *   LIVE_AUDIO_URL / LIVE_AUDIO_KEY — the browser's `/api/live/*` calls are
 *   routed straight to that audio-service. Only for local checks.
 *   LIVE_EXPECT_UPLOAD=0 — do not require the final upload to succeed (a
 *   local stack without audio-service cannot accept audio).
 */

const SIM_REL = 'media/voces/SIM_0015_traduccion_testimonio_media.m4a';

/** `media/` is untracked, so from a worktree it only exists in the main checkout. */
function simFile(): string | null {
  const here = import.meta.dirname;
  const candidates = [process.env.LIVE_SIM_FILE, resolve(here, '../../..', SIM_REL)];
  try {
    const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      cwd: here,
      encoding: 'utf8',
    }).trim();
    candidates.push(resolve(common, '..', SIM_REL));
  } catch {
    /* not a git checkout */
  }
  return candidates.find((c): c is string => !!c && existsSync(c)) ?? null;
}

const SIM = simFile();
const WAV = resolve(import.meta.dirname, '.artifacts/live-mic/SIM_0015.wav');

if (SIM && !existsSync(WAV)) {
  mkdirSync(resolve(WAV, '..'), { recursive: true });
  execFileSync('ffmpeg', ['-nostdin', '-loglevel', 'error', '-y', '-i', SIM, '-ac', '1', '-ar', '48000', WAV]);
}

test.use({
  permissions: ['microphone'],
  launchOptions: {
    slowMo: 350,
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-audio-capture=${WAV}%noloop`,
    ],
  },
});


async function setUp(page: Page, path = '/'): Promise<void> {
  const liveUrl = process.env.LIVE_AUDIO_URL;
  const liveKey = process.env.LIVE_AUDIO_KEY;
  if (liveUrl && liveKey) {
    await page.route('**/api/live/**', async (route) => {
      const req = route.request();
      const url = new URL(req.url());
      const sid = url.pathname.split('/').pop()!;
      const target =
        req.method() === 'DELETE'
          ? `${liveUrl}/v1/live/e2e.${sid}`
          : `${liveUrl}/v1/live/e2e.${sid}/chunk${url.search}`;
      const res = await fetch(target, {
        method: req.method(),
        headers: { Authorization: `Bearer ${liveKey}` },
        body: req.method() === 'POST' ? req.postDataBuffer() : undefined,
      });
      await route.fulfill({ status: res.status, body: Buffer.from(await res.arrayBuffer()) });
    });
  }

  const { email, password } = adminCredentials();
  await page.goto('/sign-in');
  await page.locator('input[name="email"]').fill(email);
  await page.locator('input[name="password"]').fill(password);
  await page.getByRole('button', { name: 'Entrar' }).click();
  await page
    .locator('input[name="password"]')
    .evaluate((el) => ((el as HTMLInputElement).value = ''))
    .catch(() => {});
  await page.waitForURL('**/');
  // Full load: client-side sign-in can leave the app unhydrated (journey.spec.ts).
  await page.goto(path);
  await expect(page.getByRole('heading', { name: 'Conversaciones' })).toBeVisible();
}

async function stopAndExpectUpload(page: Page): Promise<void> {
  const upload = page.waitForResponse(
    (r) => /\/api\/sessions\/[^/]+\/documents$/.test(r.url()) && r.request().method() === 'POST',
  );
  await page.getByTestId('mic-stop').click();
  await expect(page.getByTestId('live-text')).toHaveCount(0);
  // 🔴 Raw live text never lands in the input (C-13).
  await expect(page.getByTestId('composer-input')).toHaveValue('');
  const res = await upload;
  // A request in flight at Stop must not bring the text back.
  await page.waitForTimeout(3_000);
  await expect(page.getByTestId('live-text')).toHaveCount(0);
  expect(res.request().postDataBuffer()?.includes(Buffer.from('audio/webm'))).toBe(true);
  if (process.env.LIVE_EXPECT_UPLOAD !== '0') expect(res.ok()).toBe(true);
}

test('live mic shows partial text while recording, then uploads the recording', async ({ page }) => {
  test.skip(!SIM, `${SIM_REL} not found (set LIVE_SIM_FILE)`);
  await setUp(page);

  await startRecordingWithConsent(page);
  await expect(page.getByTestId('mic-clock')).toBeVisible();

  // SIM_0015 opens "Nací hace 76 años en Juchitán, Oaxaca".
  const live = page.getByTestId('live-text');
  await expect(live).toContainText(/Juchit/i, { timeout: 20_000 });
  // Let it run past one commit (audio-service COMMIT_AFTER_S = 12 s).
  await page.waitForTimeout(16_000);
  await expect(live).toContainText(/zapoteco/i);

  await stopAndExpectUpload(page);
});

test('?simvoz=1 feeds a picked file through the same path', async ({ page }) => {
  test.skip(!SIM, `${SIM_REL} not found (set LIVE_SIM_FILE)`);
  await setUp(page, '/?simvoz=1');

  const chooser = page.waitForEvent('filechooser');
  await startRecordingWithConsent(page);
  // WAV, not the m4a: Playwright's Chromium has no AAC decoder.
  await (await chooser).setFiles(WAV);

  await expect(page.getByTestId('live-text')).toContainText(/Juchit/i, { timeout: 20_000 });
  await stopAndExpectUpload(page);
});
