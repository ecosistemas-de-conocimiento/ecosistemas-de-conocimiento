// Test-only helper: start a throwaway Redis container on an EPHEMERAL host
// port and tell the caller which port it landed on.
//
// Sibling of `docker-pg.ts`, and it exists for the same reason. The integration
// suite used to default to `redis://localhost:56379`, which on this workstation
// is the LIVE fleet Redis (`edc-local-ai-redis-1`). Nothing in the suite
// issues FLUSHDB, so the blast radius was smaller than the Postgres case — but
// BullMQ still enqueues jobs into whatever Redis it is handed, so a test run
// could push work into the live fleet's queue namespace and be consumed by a
// real worker. "Smaller blast radius" is not "safe".
//
// Same mechanism as the Postgres helper: `-p 127.0.0.1::6379` asks the Docker
// daemon to allocate and bind a free host port itself, which is race-free in a
// way "probe a port, then bind it later" is not, then we read the assignment
// back with `docker port`. Binding to 127.0.0.1 keeps the instance off the
// network for the duration of the run.

import { execFileSync } from 'node:child_process';
import { createConnection } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

import { mappedPort, removeContainer } from './docker-pg.js';

export interface ThrowawayRedisOptions {
  /** `--name` for the container. Must be unique per test process. */
  containerName: string;
  /** Image to run. Defaults to the image `docker-compose.yml` uses. */
  image?: string;
  /**
   * Env var that, when set, forces a specific host port instead of an
   * ephemeral one. Escape hatch for debugging; unset in normal runs.
   */
  portEnvVar?: string;
}

export interface ThrowawayRedis {
  /** The host port Docker actually bound. */
  port: number;
  /** `redis://127.0.0.1:<port>` for the running container. */
  url: string;
  /** Force-remove the container. Safe to call twice. */
  stop: () => void;
}

/**
 * Start the container and return its connection details. The caller is
 * responsible for calling `stop()` when the suite finishes.
 *
 * Throws (rather than returning a broken URL) if the port mapping never shows
 * up — a silent fallback to a default port is exactly the failure mode this
 * helper exists to remove.
 */
export async function startThrowawayRedis(
  opts: ThrowawayRedisOptions,
): Promise<ThrowawayRedis> {
  const { containerName, image = 'redis:7-alpine', portEnvVar } = opts;

  // Kill any stray container from a previous interrupted run.
  removeContainer(containerName);

  const forced = portEnvVar ? Number(process.env[portEnvVar]) : NaN;
  const publish =
    Number.isInteger(forced) && forced > 0 ? `${forced}:6379` : '127.0.0.1::6379';

  execFileSync(
    'docker',
    ['run', '-d', '--rm', '--name', containerName, '-p', publish, image],
    { stdio: 'ignore' },
  );

  // `docker run -d` returns once the container is created; the port table can
  // lag it by a few milliseconds.
  let port: number | null = null;
  for (let i = 0; i < 40 && port === null; i++) {
    port = mappedPort(containerName, 6379);
    if (port === null) await delay(100);
  }
  if (port === null) {
    removeContainer(containerName);
    throw new Error(
      `docker never published a host port for ${containerName}:6379 — cannot reach the test Redis`,
    );
  }

  try {
    await waitForRedis(port);
  } catch (err) {
    removeContainer(containerName);
    throw err;
  }

  return {
    port,
    url: `redis://127.0.0.1:${port}`,
    stop: () => removeContainer(containerName),
  };
}

/**
 * Block until Redis answers `PING`, not merely until the host port exists.
 *
 * Same class of race as `docker-pg.ts`'s `waitForPostgres` (see the long note
 * there): Docker publishes the port the moment the container is created, and a
 * host connection in the gap before the server is listening reaches
 * docker-proxy, which accepts and then resets — `ECONNRESET`, not
 * `ECONNREFUSED`. Redis starts in tens of milliseconds where Postgres spends
 * seconds in `initdb`, so this half of the class has not been observed biting;
 * it is closed here because the two helpers must not drift.
 *
 * `PING` rather than a bare TCP connect, so a reset that arrives AFTER the
 * handshake still counts as not-ready. No client dependency: the inline RESP
 * command is three lines and keeps this helper import-free.
 */
async function waitForRedis(port: number, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'none';
  for (;;) {
    try {
      await pingRedis(port);
      return;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      if (Date.now() >= deadline) {
        throw new Error(
          `Redis at 127.0.0.1:${port} never answered PING within ${timeoutMs}ms. ` +
            `Last error: ${lastError}`,
        );
      }
      await delay(100);
    }
  }
}

function pingRedis(port: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    const done = (err?: Error): void => {
      socket.removeAllListeners();
      socket.destroy();
      if (err) reject(err);
      else resolve();
    };
    socket.setTimeout(2000, () => done(new Error('timeout')));
    socket.on('error', done);
    socket.on('connect', () => socket.write('PING\r\n'));
    socket.on('data', (buf: Buffer) => {
      if (buf.toString('utf8').startsWith('+PONG')) done();
      else done(new Error(`unexpected reply: ${buf.toString('utf8').trim()}`));
    });
  });
}
