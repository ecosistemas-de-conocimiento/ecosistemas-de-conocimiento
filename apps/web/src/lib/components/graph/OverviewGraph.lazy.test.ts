/**
 * 🔴 THE 3D LIBRARY IS NOT ON THE 2D PATH, AND NEITHER LIBRARY IS ON THE SERVER.
 *
 * `3d-force-graph` is ~382 KB gzip with three.js; `force-graph` touches
 * `window` when imported. So both arrive through a dynamic `import()` after
 * mount, and `3d-force-graph` only when 3D is switched on. A static import
 * anywhere on the 2D path would ship 3D to every visitor (or crash the server
 * render), and nothing would fail until someone read the bundle. This reads
 * the sources instead; `vite build` confirms the split (lane report).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const read = (file: string) => readFileSync(join(here, file), 'utf8');

/** `import x from '…'` / `import '…'` / `export … from '…'` — never `import type`. */
function staticImports(source: string): string[] {
  const out: string[] = [];
  const re = /^\s*(?:import|export)\s+(?!type\b)(?:[^'"]*?\sfrom\s+)?['"]([^'"]+)['"]/gm;
  for (const m of source.matchAll(re)) out.push(m[1]!);
  return out;
}

/** Every module the 2D path loads statically. */
const twoDPath = ['OverviewGraph.svelte', 'mapModel.ts', 'mapTheme.ts', 'viewMode.ts', 'selection.ts', 'overviewLabels.ts'];

describe('lazy renderers', () => {
  it('OverviewGraph loads both renderers only with import()', () => {
    const source = read('OverviewGraph.svelte');
    expect(source).toContain("import('./graph2d')");
    expect(source).toContain("import('./graph3d')");
    const imports = staticImports(source);
    for (const lib of ['force-graph', '3d-force-graph', './graph2d', './graph3d']) {
      expect(imports).not.toContain(lib);
    }
  });

  it('nothing on the 2D path imports the 3D library or its module statically', () => {
    for (const file of [...twoDPath, 'graph2d.ts']) {
      const imports = staticImports(read(file));
      expect(imports, file).not.toContain('3d-force-graph');
      expect(imports, file).not.toContain('./graph3d');
      expect(imports, file).not.toContain('three');
    }
  });

  it('only the renderer modules import the libraries', () => {
    expect(staticImports(read('graph2d.ts'))).toContain('force-graph');
    expect(staticImports(read('graph3d.ts'))).toContain('3d-force-graph');
  });

  it('the type-only imports are erased (and so do not count)', () => {
    expect(staticImports("import type { Graph3D } from './graph3d';")).toEqual([]);
    expect(staticImports("import X from './graph3d';")).toEqual(['./graph3d']);
  });
});
