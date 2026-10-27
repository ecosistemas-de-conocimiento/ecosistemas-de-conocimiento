/**
 * The Miembros screen's pure half: role names, which roles a caller may hand
 * out, and parsing the backend's list. The backend (`/api/miembros` and
 * `collections/Memberships.ts`) is the control; this only decides what to show.
 */

import { ROLE_RANK } from './roles';

/** Backend role ranks, least → most (`$lib/roles` mirrors the backend ladder). */
const RANK: Record<string, number | undefined> = ROLE_RANK;

/** `admin` and up hold `members:manage`. */
const MANAGER_RANK = ROLE_RANK.admin;

/** The roles the screen offers, in the owner's words, least → most. */
export const ROLE_OPTIONS = [
  { value: 'estudiante', label: 'estudiante' },
  { value: 'member', label: 'participante' },
  { value: 'investigador', label: 'investigador' },
  { value: 'owner', label: 'responsable' },
] as const;

export type MemberRole = 'estudiante' | 'member' | 'investigador' | 'admin' | 'owner';

export function roleLabel(role: string): string {
  if (role === 'admin') return 'administra';
  return ROLE_OPTIONS.find((o) => o.value === role)?.label ?? role;
}

/** `true` when `role` ranks above `than`. Unknown roles rank nowhere. */
export function outranks(role: string, than: string): boolean {
  return (RANK[role] ?? -1) > (RANK[than] ?? -1);
}

/** Nothing above the caller's own role; nothing at all for a non-manager. */
export function assignableRoles(myRole: string): Array<(typeof ROLE_OPTIONS)[number]> {
  const mine = RANK[myRole];
  if (mine === undefined || mine < MANAGER_RANK) return [];
  return ROLE_OPTIONS.filter((o) => (RANK[o.value] ?? Infinity) <= mine);
}

export interface Member {
  id: string;
  email: string;
  name: string | null;
  role: MemberRole;
}

export function parseMembers(raw: unknown): Member[] {
  if (!Array.isArray(raw)) return [];
  const out: Member[] = [];
  for (const row of raw) {
    if (!row || typeof row !== 'object') continue;
    const r = row as Record<string, unknown>;
    const id = typeof r.id === 'number' || typeof r.id === 'string' ? String(r.id) : '';
    if (!id || typeof r.email !== 'string' || !(String(r.role) in RANK)) continue;
    out.push({
      id,
      email: r.email,
      name: typeof r.name === 'string' && r.name ? r.name : null,
      role: r.role as MemberRole,
    });
  }
  return out;
}
