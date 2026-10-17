// Entry for the preload probes: prints what `fixtures/load-counter.ts`
// recorded, as `{"packages":[…]}`. Run as
//   node tsx --import load-counter.ts --import ../preload.ts loaded-report.ts
// so the report is taken AFTER the preload has done whatever it does.

const seen = (globalThis as unknown as { __loadedModules?: Set<string> }).__loadedModules;
const packages = [
  ...new Set(
    [...(seen ?? [])].map((u) =>
      u.replace(/^.*\/node_modules\//, '').split('/').slice(0, 2).join('/'),
    ),
  ),
]
  .map((p) => (p.startsWith('import-in-the-middle') ? 'import-in-the-middle' : p))
  .sort();

process.stdout.write(`${JSON.stringify({ packages })}\n`);
// The SDK's batch processor holds a live timer with the endpoint set; nothing
// here needs a clean shutdown, only the list.
process.exit(0);
