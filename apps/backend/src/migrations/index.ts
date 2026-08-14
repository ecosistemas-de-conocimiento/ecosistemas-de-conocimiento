import * as migration_20260814_205354_baseline from './20260814_205354_baseline';

export const migrations = [
  {
    up: migration_20260814_205354_baseline.up,
    down: migration_20260814_205354_baseline.down,
    name: '20260814_205354_baseline'
  },
];
