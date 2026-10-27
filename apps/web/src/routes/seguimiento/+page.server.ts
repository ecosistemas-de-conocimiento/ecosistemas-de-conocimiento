/**
 * `/seguimiento` — the teacher side of the student view: students who share
 * their activity, one student's report, and the ecosistema's suggestions.
 *
 * 🔴 THE CONTROL IS THE BACKEND: reports need canAdminOrg AND the student's
 * consent; suggestions need investigador or responsable. Both refused → 404.
 */

import { notFound } from '$lib/server/deny';
import { resolveEcosystem } from '$lib/server/ecosystem';
import { fetchConsentingStudents, fetchReport, fetchSuggestions } from '$lib/server/estudiante';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, cookies, url }) => {
  if (!locals.user) notFound({ entity: 'page' });
  const eco = await resolveEcosystem(cookies, locals.token);
  if (!eco.selected) notFound({ entity: 'page' });
  const organization = eco.selected!.id;
  const [students, suggestions] = await Promise.all([
    fetchConsentingStudents(locals.token, organization),
    fetchSuggestions(locals.token, organization),
  ]);
  if (!students.ok && !suggestions.ok) notFound({ entity: 'page' });
  const chosen = url.searchParams.get('estudiante');
  const report = students.ok && chosen && /^\d{1,12}$/.test(chosen) ? await fetchReport(locals.token, organization, chosen) : null;
  return {
    estudiantes: students.ok ? students.value.estudiantes : null,
    sugerencias: suggestions.ok ? suggestions.value.sugerencias : [],
    chosen,
    reporte: report && report.ok ? report.value.reporte : null,
  };
};
