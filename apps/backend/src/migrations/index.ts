import * as migration_20260908_092211_baseline from './20260908_092211_baseline';

export const migrations = [
  {
    up: migration_20260908_092211_baseline.up,
    down: migration_20260908_092211_baseline.down,
    name: '20260908_092211_baseline'
  },
];
