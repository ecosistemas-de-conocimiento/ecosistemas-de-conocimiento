import * as migration_20260814_205354_baseline from './20260814_205354_baseline';
import * as migration_20260814_231500_media_prefix from './20260814_231500_media_prefix';
import * as migration_20260822_071001_rating_reason from './20260822_071001_rating_reason';
import * as migration_20260828_080049_documents_session_hasmany from './20260828_080049_documents_session_hasmany';
import * as migration_20260828_081504_voces_and_anonymisation from './20260828_081504_voces_and_anonymisation';
import * as migration_20260828_191401_anonymisation_review from './20260828_191401_anonymisation_review';

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
    name: '20260822_071001_rating_reason',
  },
  {
    up: migration_20260828_080049_documents_session_hasmany.up,
    down: migration_20260828_080049_documents_session_hasmany.down,
    name: '20260828_080049_documents_session_hasmany',
  },
  {
    up: migration_20260828_081504_voces_and_anonymisation.up,
    down: migration_20260828_081504_voces_and_anonymisation.down,
    name: '20260828_081504_voces_and_anonymisation',
  },
  {
    up: migration_20260828_191401_anonymisation_review.up,
    down: migration_20260828_191401_anonymisation_review.down,
    name: '20260828_191401_anonymisation_review'
  },
];
