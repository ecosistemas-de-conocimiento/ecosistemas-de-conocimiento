import * as migration_20260908_092211_baseline from './20260908_092211_baseline';
import * as migration_20261017_231817_documents_uploaded_in_session from './20261017_231817_documents_uploaded_in_session';

export const migrations = [
  {
    up: migration_20260908_092211_baseline.up,
    down: migration_20260908_092211_baseline.down,
    name: '20260908_092211_baseline',
  },
  {
    up: migration_20261017_231817_documents_uploaded_in_session.up,
    down: migration_20261017_231817_documents_uploaded_in_session.down,
    name: '20261017_231817_documents_uploaded_in_session'
  },
];
