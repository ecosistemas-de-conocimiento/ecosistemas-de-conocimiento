import * as migration_20260814_205354_baseline from './20260814_205354_baseline';
import * as migration_20260814_231500_media_prefix from './20260814_231500_media_prefix';
import * as migration_20260822_071001_rating_reason from './20260822_071001_rating_reason';

export const migrations = [
  {
    up: migration_20260814_205354_baseline.up,
    down: migration_20260814_205354_baseline.down,
    name: '20260814_205354_baseline',
  },
  {
    up: migration_20260814_231500_media_prefix.up,
    down: migration_20260814_231500_media_prefix.down,
    name: '20260814_231500_media_prefix',
  },
  {
    up: migration_20260822_071001_rating_reason.up,
    down: migration_20260822_071001_rating_reason.down,
    name: '20260822_071001_rating_reason'
  },
];
