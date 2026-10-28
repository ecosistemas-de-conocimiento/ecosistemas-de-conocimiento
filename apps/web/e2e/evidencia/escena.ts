import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { historia } from './historias';

/**
 * Helpers for the evidence videos: accounts, the caption bar and the pacing.
 *
 * 🔴 Credentials are read at runtime from two gitignored files OUTSIDE the
 * repo, by key name, and never printed:
 *   EVID_ENV_FILE        default ~/chamba/cide/.env
 *                        (EDC_DEV_PARTICIPANT_*, EDC_DEV_SEED_ADMIN_PASSWORD)
 *   EVID_DEMO_USERS_FILE default ~/chamba/cide/.env.demo-users
 *                        (DEMO_ESTUDIANTE1_*, DEMO_INVESTIGADOR_SEMIOSIS_*;
 *                        written by backend `seed/demoUsers.ts`)
 */

export const RUN_ID = `evid-${Date.now()}`;

/** How long a caption stays up before its action starts, and after it ends. */
const HOLD_BEFORE_MS = Number(process.env.EVID_HOLD_MS ?? 2200);
const HOLD_AFTER_MS = Math.round(HOLD_BEFORE_MS * 0.6);

export type Cuenta = 'participante' | 'estudiante' | 'investigador' | 'admin';

function parseDotenv(path: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const raw of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    const eq = line.indexOf('=');
    if (!line || line.startsWith('#') || eq <= 0) continue;
    out.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim().replace(/^(["'])(.*)\1$/, '$2'));
  }
  return out;
}

const KEYS: Record<Cuenta, { file: 'env' | 'demo'; email: string; password: string }> = {
  participante: { file: 'env', email: 'EDC_DEV_PARTICIPANT_EMAIL', password: 'EDC_DEV_PARTICIPANT_PASSWORD' },
  estudiante: { file: 'demo', email: 'DEMO_ESTUDIANTE1_EMAIL', password: 'DEMO_ESTUDIANTE1_PASSWORD' },
  investigador: {
    file: 'demo',
    email: 'DEMO_INVESTIGADOR_SEMIOSIS_EMAIL',
    password: 'DEMO_INVESTIGADOR_SEMIOSIS_PASSWORD',
  },
  // The seeded platform admin; owner (responsable) of ecosistemas 1, 3, 6 and 7 on dev.
  // ⚠ Its address is the dev backend container's SEED_ADMIN_EMAIL, which cide/.env
  // does not carry: `correr.sh` passes it in as EVID_ADMIN_EMAIL.
  admin: { file: 'env', email: 'EVID_ADMIN_EMAIL', password: 'EDC_DEV_SEED_ADMIN_PASSWORD' },
};

export function credenciales(cuenta: Cuenta): { email: string; password: string } {
  const k = KEYS[cuenta];
  const file =
    k.file === 'env'
      ? (process.env.EVID_ENV_FILE ?? '~/chamba/cide/.env')
      : (process.env.EVID_DEMO_USERS_FILE ?? '~/chamba/cide/.env.demo-users');
  const vars = parseDotenv(file);
  const email = process.env[k.email] ?? vars.get(k.email);
  const password = process.env[k.password] ?? vars.get(k.password);
  // Names the keys, never the values.
  if (!email || !password) throw new Error(`${file} no tiene ${k.email} / ${k.password}`);
  return { email, password };
}

/**
 * The caption bar, installed on every document the page loads. The text lives
 * on the Node side (`captions`) and the page asks for it on each load, so a
 * full navigation keeps the caption that was showing.
 */
const captions = new WeakMap<Page, string>();

export async function instalarSubtitulos(page: Page, rol: string): Promise<void> {
  await page.exposeFunction('__evidCaptionText', () => captions.get(page) ?? '');
  await page.addInitScript(({ rolLabel, BAR_PX }: { rolLabel: string; BAR_PX: number }) => {
    const w = window as unknown as { __evidPaint: (t: string) => void; __evidCaptionText: () => Promise<string> };
    w.__evidPaint = (text: string) => {
      let bar = document.getElementById('evid-caption');
      if (!bar) {
        bar = document.createElement('div');
        bar.id = 'evid-caption';
        bar.setAttribute('aria-hidden', 'true');
        bar.style.cssText =
          'position:fixed;left:0;right:0;bottom:0;z-index:2147483647;pointer-events:none;' +
          `height:${BAR_PX}px;box-sizing:border-box;gap:16px;align-items:center;justify-content:center;padding:0 24px;` +
          'background:rgba(17,17,27,.86);color:#fff;font:600 26px/1.25 system-ui,sans-serif;';
        document.documentElement.appendChild(bar);
        // Reserve the bar's strip so it never covers the composer: the app
        // shell is `height: 100dvh` (routes/+layout.svelte).
        const style = document.createElement('style');
        style.textContent = `.app-shell{height:calc(100dvh - ${BAR_PX}px)!important}body{padding-bottom:${BAR_PX}px}`;
        document.documentElement.appendChild(style);
      }
      bar.style.display = text ? 'flex' : 'none';
      bar.replaceChildren();
      const who = document.createElement('span');
      who.textContent = rolLabel;
      who.style.cssText = 'font-size:16px;font-weight:500;opacity:.7;text-transform:uppercase;letter-spacing:.08em';
      const what = document.createElement('span');
      what.textContent = text;
      bar.append(who, what);
    };
    const paint = () => void w.__evidCaptionText().then(w.__evidPaint);
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', paint);
    else paint();
  }, { rolLabel: rol, BAR_PX: 64 });
}

async function subtitular(page: Page, texto: string): Promise<void> {
  captions.set(page, texto);
  await page.evaluate((t) => (window as unknown as { __evidPaint?: (t: string) => void }).__evidPaint?.(t), texto);
}

/**
 * One story on screen: caption up, a pause to read it, the action, a pause to
 * see the result. A `test.step` per story so the report reads as the map.
 *
 * ⚠ The pauses are deliberate `waitForTimeout`s: they pace the VIDEO, not the
 * app. `slowMo` in the config paces each action; this paces each story.
 */
export async function escena(page: Page, id: string, accion: () => Promise<void>): Promise<void> {
  const { texto } = historia(id);
  await test.step(`${id} ${texto}`, async () => {
    await subtitular(page, texto);
    await page.waitForTimeout(HOLD_BEFORE_MS);
    await accion();
    await page.waitForTimeout(HOLD_AFTER_MS);
  });
}

export async function iniciarSesion(page: Page, cuenta: Cuenta): Promise<void> {
  const { email, password } = credenciales(cuenta);
  await escena(page, 'A1.1', async () => {
    await page.goto('/sign-in');
    // Known dev bug: a form filled before hydration submits as a GET with the
    // credentials in the URL. Wait for the client to take over first.
    await page.waitForLoadState('networkidle');
    await page.getByLabel('Correo electrónico').fill(email);
    await page.getByLabel('Contraseña').fill(password);
    await page.getByRole('button', { name: 'Entrar' }).click();
    await page.waitForURL((u) => !u.pathname.startsWith('/sign-in'));
    await expect(page.getByTestId('primary-nav')).toBeVisible();
  });
}

export async function cerrarSesion(page: Page): Promise<void> {
  await escena(page, 'A1.2', async () => {
    await page.getByTestId('nav-logout').or(page.getByTestId('inicio-logout')).or(page.getByRole('button', { name: 'Cerrar sesión' })).first().click();
    await page.waitForURL('**/sign-in');
  });
}

/** Click a primary-nav entry and wait for the page under it. */
export async function ir(page: Page, seccion: string): Promise<void> {
  const enlace = page.getByTestId(`nav-${seccion}`);
  const destino = new URL((await enlace.getAttribute('href')) ?? '/', page.url()).pathname;
  await enlace.click();
  // Some sections load slowly on dev (the graph): wait for the address, not just the click.
  await page.waitForURL((u) => u.pathname === destino, { timeout: 90_000 });
  await page.waitForLoadState('networkidle');
}

/** A small text file to upload, named with the run id so cleanup can find it. */
export function archivoDePrueba(nombre: string): { name: string; mimeType: string; buffer: Buffer } {
  return {
    name: `${RUN_ID}-${nombre}.md`,
    mimeType: 'text/markdown',
    // The run id goes in the BODY too: the backend refuses a byte-identical
    // re-upload (`refuseDuplicate`), and every run would otherwise send the same bytes.
    buffer: Buffer.from(
      `# ${RUN_ID}\n\nNota de prueba para el video de evidencia. En la colonia organizamos un círculo ` +
        'de lectura los sábados en la biblioteca comunitaria.\n',
    ),
  };
}
