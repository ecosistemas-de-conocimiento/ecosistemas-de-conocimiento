import * as migration_20260908_092211_baseline from './20260908_092211_baseline';
import * as migration_20261017_231817_documents_uploaded_in_session from './20261017_231817_documents_uploaded_in_session';
import * as migration_20261020_193707_ratings_fk_cascade from './20261020_193707_ratings_fk_cascade';
import * as migration_20261024_201817_graph_entities_public_figure from './20261024_201817_graph_entities_public_figure';
import * as migration_20261024_230631_documents_testimonio_title from './20261024_230631_documents_testimonio_title';
import * as migration_20261026_160000_documents_anonymise from './20261026_160000_documents_anonymise';
import * as migration_20261026_200000_documents_kind_tabular_html from './20261026_200000_documents_kind_tabular_html';
import * as migration_20261027_002257_sessions_kind from './20261027_002257_sessions_kind';
import * as migration_20261027_020102_feature_switches from './20261027_020102_feature_switches';
import * as migration_20261027_053737_memberships_role_estudiante from './20261027_053737_memberships_role_estudiante';
import * as migration_20261027_053800_student_view from './20261027_053800_student_view';
import * as migration_20261027_061014_student_view_fk_cascade from './20261027_061014_student_view_fk_cascade';
import * as migration_20261027_225429_documents_public_figures from './20261027_225429_documents_public_figures';
import * as migration_20261028_054402_student_testimonio_consent from './20261028_054402_student_testimonio_consent';
import * as migration_20261028_083327_student_testimonio_consent_version from './20261028_083327_student_testimonio_consent_version';
import * as migration_20261028_162050_organizations_answer_style from './20261028_162050_organizations_answer_style';
import * as migration_20261028_170129_documents_wiki_links from './20261028_170129_documents_wiki_links';
import * as migration_20261028_225918_documents_authors_kept from './20261028_225918_documents_authors_kept';
import * as migration_20261028_231948_documents_note_revisions from './20261028_231948_documents_note_revisions';
import * as migration_20261028_235647_documents_kind_xls from './20261028_235647_documents_kind_xls';
import * as migration_20261029_042255_documents_held_text_hash from './20261029_042255_documents_held_text_hash';
import * as migration_20261029_060304_evals from './20261029_060304_evals';

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
    name: '20261024_201817_graph_entities_public_figure',
  },
  {
    up: migration_20261024_230631_documents_testimonio_title.up,
    down: migration_20261024_230631_documents_testimonio_title.down,
    name: '20261024_230631_documents_testimonio_title',
  },
  {
    up: migration_20261026_160000_documents_anonymise.up,
    down: migration_20261026_160000_documents_anonymise.down,
    name: '20261026_160000_documents_anonymise',
  },
  {
    up: migration_20261026_200000_documents_kind_tabular_html.up,
    down: migration_20261026_200000_documents_kind_tabular_html.down,
    name: '20261026_200000_documents_kind_tabular_html',
  },
  {
    up: migration_20261027_002257_sessions_kind.up,
    down: migration_20261027_002257_sessions_kind.down,
    name: '20261027_002257_sessions_kind',
  },
  {
    up: migration_20261027_020102_feature_switches.up,
    down: migration_20261027_020102_feature_switches.down,
    name: '20261027_020102_feature_switches',
  },
  {
    up: migration_20261027_053737_memberships_role_estudiante.up,
    down: migration_20261027_053737_memberships_role_estudiante.down,
    name: '20261027_053737_memberships_role_estudiante',
  },
  {
    up: migration_20261027_053800_student_view.up,
    down: migration_20261027_053800_student_view.down,
    name: '20261027_053800_student_view',
  },
  {
    up: migration_20261027_061014_student_view_fk_cascade.up,
    down: migration_20261027_061014_student_view_fk_cascade.down,
    name: '20261027_061014_student_view_fk_cascade',
  },
  {
    up: migration_20261027_225429_documents_public_figures.up,
    down: migration_20261027_225429_documents_public_figures.down,
    name: '20261027_225429_documents_public_figures',
  },
  {
    up: migration_20261028_054402_student_testimonio_consent.up,
    down: migration_20261028_054402_student_testimonio_consent.down,
    name: '20261028_054402_student_testimonio_consent',
  },
  {
    up: migration_20261028_083327_student_testimonio_consent_version.up,
    down: migration_20261028_083327_student_testimonio_consent_version.down,
    name: '20261028_083327_student_testimonio_consent_version',
  },
  {
    up: migration_20261028_162050_organizations_answer_style.up,
    down: migration_20261028_162050_organizations_answer_style.down,
    name: '20261028_162050_organizations_answer_style',
  },
  {
    up: migration_20261028_170129_documents_wiki_links.up,
    down: migration_20261028_170129_documents_wiki_links.down,
    name: '20261028_170129_documents_wiki_links',
  },
  {
    up: migration_20261028_225918_documents_authors_kept.up,
    down: migration_20261028_225918_documents_authors_kept.down,
    name: '20261028_225918_documents_authors_kept'
  },
  {
    up: migration_20261028_231948_documents_note_revisions.up,
    down: migration_20261028_231948_documents_note_revisions.down,
    name: '20261028_231948_documents_note_revisions',
  },
  {
    up: migration_20261028_235647_documents_kind_xls.up,
    down: migration_20261028_235647_documents_kind_xls.down,
    name: '20261028_235647_documents_kind_xls',
  },
  {
    up: migration_20261029_042255_documents_held_text_hash.up,
    down: migration_20261029_042255_documents_held_text_hash.down,
    name: '20261029_042255_documents_held_text_hash',
  },
  {
    up: migration_20261029_060304_evals.up,
    down: migration_20261029_060304_evals.down,
    name: '20261029_060304_evals'
  },
];
