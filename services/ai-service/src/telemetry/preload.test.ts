// LOG↔TRACE CORRELATION, AS A MEASUREMENT RATHER THAN A HOPE.
//
// THE DEFECT THIS CLOSES: `@opentelemetry/instrumentation-pino` is in the
// instrumentation list to stamp `trace_id` onto every log line — that is its
// only job — and under plain ESM it patches NOTHING, silently. Measured on this
// tree, node 26.7.0, with `OTEL_EXPORTER_OTLP_ENDPOINT` set and a real
// collector listening:
//
//   node …            probe.ts   → span exported; pino line has NO trace_id
//   node --import preload.js probe.ts
//                                → span exported; pino line HAS trace_id
//
// Both of those are asserted below, in that order, so "correlation works" can
// never pass by accident: the second is the claim, the first is the contrast
// that proves the second is about the preload and not about something ambient.
//
// The flag is only useful if the thing that BOOTS carries it, so the first test
// reads the two files that actually start the service in production —
// package.json's `start` script and the Dockerfile's CMD — rather than trusting
// that someone kept them in step.
//
// SABOTAGE (all measured):
//   drop `--import` from the `start` script      → RED, and not only in the
//                                                  start-path test: every
//                                                  spawned probe below derives
//                                                  its argv from that script
//   move `--import` after `dist/index.js`        → RED (node ignores a flag
//                                                  past the entry script; a
//                                                  substring check would not
//                                                  have noticed)
//   drop it from the Dockerfile CMD              → RED (start-path test)
//   remove the `register()` call from preload.ts → RED (no trace_id)
//   remove the `telemetryEnabled()` guard        → RED (inert-when-off test:
//                                                  import-in-the-middle loads
//                                                  with no endpoint set)
//   `disableLogSending: false` in otel.ts        → RED (/v1/logs is hit)

import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import http from 'node:http';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

// Resolved through Node's module lookup, not a cwd-relative path: a nested
// worktree has no node_modules of its own and finds tsx in a parent directory.
const TSX_CLI = createRequire(import.meta.url).resolve('tsx/cli');

const run = promisify(execFile);

// ---------------------------------------------------------------------------
// 1. The production start path carries the flag — as ARGV, not as a substring
// ---------------------------------------------------------------------------

/**
 * The node argv inside a command line: everything from the `node` word on.
 *
 * Both start paths wrap node in something — npm in one case, `sh -c` and a
 * migration in the other — so the interesting part has to be cut out before it
 * can be reasoned about as arguments. Throws rather than returning empty: a
 * command with no `node` in it is a broken start path, not a passing test.
 */
export function nodeArgv(command: string): string[] {
  const words = command.trim().split(/\s+/);
  const at = words.indexOf('node');
  if (at === -1) throw new Error(`no \`node\` in command: ${command}`);
  return words.slice(at + 1);
}

/** The `["sh","-c","…"]` (or plain) exec form of the Dockerfile's CMD, as one
 *  command line. */
export function dockerfileCommand(dockerfile: string): string {
  const line = dockerfile
    .split('\n')
    .map((l) => l.trim())
    .findLast((l) => l.startsWith('CMD '));
  if (!line) throw new Error('Dockerfile has no CMD line');
  const argv = JSON.parse(line.slice('CMD '.length)) as string[];
  // Shell form (`CMD ["sh","-c","…"]`) hides the real command in the last
  // element; exec form is already the command.
  return argv[0] === 'sh' || argv[0] === '/bin/sh' ? (argv.at(-1) as string) : argv.join(' ');
}

/**
 * The module the `--import` flag loads, ONLY if the flag is positioned where
 * node will honour it — before the entry script. Everything after the entry
 * script is `process.argv` for the app, not an option for the runtime, so a
 * flag that drifts past it is inert while still reading correctly to a grep.
 * That distinction is the whole reason this is a parse and not a `toContain`.
 */
export function preloadModule(argv: string[]): string {
  const entry = argv.findIndex((a) => !a.startsWith('-') && a.endsWith('.js'));
  const flag = argv.findIndex((a) => a === '--import' || a.startsWith('--import='));
  if (flag === -1) throw new Error(`no --import in argv: ${argv.join(' ')}`);
  if (entry === -1) throw new Error(`no entry script in argv: ${argv.join(' ')}`);
  const value = argv[flag] === '--import' ? argv[flag + 1] : argv[flag]?.slice('--import='.length);
  if (!value) throw new Error(`--import has no value: ${argv.join(' ')}`);
  if (flag > entry) {
    throw new Error(`--import comes AFTER the entry script and is inert: ${argv.join(' ')}`);
  }
  return value;
}

/** The `start` script's node argv — the single definition every test below
 *  derives from, so nothing here can pass against a start path that changed. */
function startArgv(): string[] {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as {
    scripts: Record<string, string>;
  };
  const start = pkg.scripts['start'];
  if (!start) throw new Error('package.json has no `start` script');
  return nodeArgv(start);
}

describe('the production start path', () => {
  it('positions the preload before the entry script, in `start` and in the CMD', () => {
    // 🔴 Two files, one flag, no shared definition — `npm start` cannot be the
    // Dockerfile's CMD because npm would sit between PID 1 and node and SIGTERM
    // has to reach node itself (index.ts drains the workers on it). So the
    // duplication is deliberate and this is what keeps it honest: both are
    // parsed into argv, and both must name the SAME preload module in a
    // position node will act on.
    const fromStart = preloadModule(startArgv());
    const fromDockerfile = preloadModule(nodeArgv(dockerfileCommand(readFileSync('Dockerfile', 'utf8'))));
    expect(fromDockerfile, 'the CMD loads a different preload than `npm start`').toBe(fromStart);

    // ...and the module named is a real one. A flag pointing at a path that
    // does not exist is a boot failure, not a preload — and this is also what
    // ties the string to the file the tests below actually exercise.
    expect(existsSync(sourceOf(fromStart)), `${fromStart} maps to no source file`).toBe(true);
  });
});

/**
 * The TypeScript source behind a built `--import` target. The start paths point
 * at `dist/`, which unit runs do not build; every spawned probe below runs the
 * same module through tsx instead. Mapping here (rather than hard-coding
 * `./src/telemetry/preload.ts`) is what makes those probes DERIVE from the
 * production start command: drop the flag from package.json and they throw.
 */
function sourceOf(distPath: string): string {
  return distPath.replace(/^\.\/dist\//, './src/').replace(/\.js$/, '.ts');
}

// ---------------------------------------------------------------------------
// 2. With the endpoint set: log lines carry trace_id, and logs never leave
// ---------------------------------------------------------------------------

interface ProbeResult {
  logged: string;
  telemetryStarted: boolean;
  hits: string[];
}

/**
 * Run `fixtures/start-path-probe.ts` in a child against a throwaway collector
 * in THIS process, and report both what the child logged and what the collector
 * was asked for.
 *
 * `preload` selects the `--import` module: the real one under test, or
 * `bootstrap.ts` — which starts the very same SDK but installs no loader hook —
 * as the contrast.
 */
async function probe(preload: 'preload' | 'bootstrap'): Promise<ProbeResult> {
  const hits: string[] = [];
  const server = http.createServer((req, res) => {
    req.on('data', () => undefined);
    req.on('end', () => {
      hits.push(req.url ?? '');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };

  try {
    const { stdout } = await run(
      process.execPath,
      [
        TSX_CLI,
        '--import',
        // 🔴 DERIVED, NOT LITERAL. The claim of this file is about the
        // command production boots with, so the module under test is read out
        // of that command: `preloadModule(startArgv())` throws if the flag is
        // gone or has drifted past the entry script, and this whole probe
        // fails with it. A literal path here would keep measuring a module
        // nothing launches.
        preload === 'preload' ? sourceOf(preloadModule(startArgv())) : './src/telemetry/bootstrap.ts',
        'src/telemetry/fixtures/start-path-probe.ts',
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${port}`,
          OTEL_SERVICE_NAME: 'start-path-probe',
        },
        timeout: 60_000,
      },
    );
    const last = stdout.trim().split('\n').at(-1);
    if (!last) throw new Error(`probe produced no output; stdout=${JSON.stringify(stdout)}`);
    const parsed = JSON.parse(last) as Omit<ProbeResult, 'hits'>;
    return { ...parsed, hits };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe('with OTEL_EXPORTER_OTLP_ENDPOINT set', () => {
  it('stamps trace_id on pino lines and still ships no logs off the box', async () => {
    const { logged, telemetryStarted, hits } = await probe('preload');

    expect(telemetryStarted, 'the preload did not start the SDK').toBe(true);
    expect(logged, 'probe emitted no pino line').toContain('"msg":"probe line"');

    // ── THE CLAIM ────────────────────────────────────────────────────────
    expect(logged, 'pino was NOT patched — log↔trace correlation is dead').toContain('trace_id');

    // The pipeline is live: spans really did reach the collector...
    expect(hits, `collector saw: ${hits.join(', ')}`).toContain('/v1/traces');
    // ...and `disableLogSending: true` (otel.ts) still holds under the hook,
    // which is the configuration in which it can fail. Turning correlation on
    // is exactly the change that would otherwise have turned log egress on too.
    expect(hits, `collector saw: ${hits.join(', ')}`).not.toContain('/v1/logs');
    expect(logged).toContain('SHOULD-NOT-LEAVE-THE-BOX');
  }, 90_000);

  it('does NOT stamp trace_id without the preload — the flag is what does it', async () => {
    // ANTI-VACUITY. Same SDK, same endpoint, same probe; only the loader hook
    // is missing. This is the state production was in before this change.
    const { logged, telemetryStarted, hits } = await probe('bootstrap');

    expect(telemetryStarted, 'contrast run must still start the SDK').toBe(true);
    expect(hits, 'contrast run must still export spans').toContain('/v1/traces');
    expect(logged).toContain('"msg":"probe line"');
    expect(logged, 'a pino line carried trace_id with no loader hook installed').not.toContain(
      'trace_id',
    );
  }, 90_000);
});

// ---------------------------------------------------------------------------
// 3. With the endpoint unset: the flag must change nothing at all
// ---------------------------------------------------------------------------

/**
 * Boot the preload in a child and report every `@opentelemetry/*` package —
 * plus `import-in-the-middle`, the loader hook's implementation — that was
 * loaded.
 *
 * The counter has to be its own `--import` module loaded BEFORE the preload:
 * a hook installed by the entry file would be installed too late to see
 * anything the preload itself pulled in, which is the entire question.
 */
async function loadedModules(endpoint?: string): Promise<string[]> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (endpoint === undefined) delete env['OTEL_EXPORTER_OTLP_ENDPOINT'];
  else env['OTEL_EXPORTER_OTLP_ENDPOINT'] = endpoint;
  const { stdout } = await run(
    process.execPath,
    [
      TSX_CLI,
      '--import',
      './src/telemetry/fixtures/load-counter.ts',
      '--import',
      sourceOf(preloadModule(startArgv())),
      'src/telemetry/fixtures/loaded-report.ts',
    ],
    { cwd: process.cwd(), env, timeout: 60_000 },
  );
  const last = stdout.trim().split('\n').at(-1);
  if (!last) throw new Error(`probe produced no output; stdout=${JSON.stringify(stdout)}`);
  return (JSON.parse(last) as { packages: string[] }).packages;
}

describe('with OTEL_EXPORTER_OTLP_ENDPOINT unset', () => {
  it('installs no loader hook and loads no SDK, flag present', async () => {
    // 🔴 THIS IS `otel.test.ts`'s "loads ONLY @opentelemetry/api" claim,
    // re-measured through the production start command rather than through a
    // bare `import bootstrap`. The flag is now on every production boot, so the
    // claim has to hold WITH the flag or it is a claim about a configuration
    // nobody runs. `import-in-the-middle` absent is the extra half: the loader
    // hook is not merely idle, it was never registered, so module loading is
    // not routed through it and costs nothing.
    const packages = await loadedModules(undefined);
    expect(packages).toEqual(['@opentelemetry/api']);
  }, 90_000);

  it('arms the hook once an endpoint IS set', async () => {
    // The other half — without it, the test above passes just as well against a
    // preload that is broken and registers nothing ever.
    const packages = await loadedModules('http://127.0.0.1:14318');
    expect(packages).toContain('import-in-the-middle');
    expect(packages).toContain('@opentelemetry/sdk-node');
    expect(packages).toContain('@opentelemetry/instrumentation-pino');
  }, 90_000);
});
