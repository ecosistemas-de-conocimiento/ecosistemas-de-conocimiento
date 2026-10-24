import * as migration_20260908_092211_baseline from './20260908_092211_baseline';
import * as migration_20261017_231817_documents_uploaded_in_session from './20261017_231817_documents_uploaded_in_session';
import * as migration_20261020_193707_ratings_fk_cascade from './20261020_193707_ratings_fk_cascade';
import * as migration_20261024_201817_graph_entities_public_figure from './20261024_201817_graph_entities_public_figure';

export const migrations = [
  {
    up: migration_20260908_092211_baseline.up,
    down: migration_20260908_092211_baseline.down,
    name: '20260908_092211_baseline',
  },
  {
    up: migration_20261017_231817_documents_uploaded_in_session.up,
    down: migration_20261017_231817_documents_uploaded_in_session.down,
    name: '20261017_231817_documents_uploaded_in_session',
  },
  {
    up: migration_20261020_193707_ratings_fk_cascade.up,
    down: migration_20261020_193707_ratings_fk_cascade.down,
    name: '20261020_193707_ratings_fk_cascade',
  },
  {
    up: migration_20261024_201817_graph_entities_public_figure.up,
    down: migration_20261024_201817_graph_entities_public_figure.down,
    name: '20261024_201817_graph_entities_public_figure'
  },
];
