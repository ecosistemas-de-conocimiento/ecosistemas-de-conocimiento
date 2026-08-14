// Registry sub-API — read + admin-write surface.
//
// Mirrors `src/routes/registry.ts` on the server. The handler unwraps the
// `{ config }` / `{ entry }` / `{ versions }` / `{ unitTypes }` envelopes so
// the typed-client return value is the bare value the consumer cares about.

import type { HttpClient } from './http.js';
import type {
  ProjectConfigPatch,
  ProjectConfigResponse,
  RegistryEntry,
  RegistryEntryCreate,
  UnitTypeSummary,
} from './types.js';

export class RegistryAPI {
  constructor(private readonly http: HttpClient) {}

  async getConfig(): Promise<ProjectConfigResponse | null> {
    const res = await this.http.json<{ config: ProjectConfigResponse | null }>({
      method: 'GET',
      path: '/v1/registry/config',
    });
    return res.config;
  }

  async putConfig(patch: ProjectConfigPatch): Promise<ProjectConfigResponse> {
    const res = await this.http.json<{ config: ProjectConfigResponse }>({
      method: 'PUT',
      path: '/v1/registry/config',
      body: patch,
    });
    return res.config;
  }

  async listUnitTypes(): Promise<UnitTypeSummary[]> {
    const res = await this.http.json<{ unitTypes: UnitTypeSummary[] }>({
      method: 'GET',
      path: '/v1/registry/unit-types',
    });
    return res.unitTypes;
  }

  async listVersions(unitType: string): Promise<RegistryEntry[]> {
    const res = await this.http.json<{ versions: RegistryEntry[] }>({
      method: 'GET',
      path: `/v1/registry/unit-types/${encodeURIComponent(unitType)}/versions`,
    });
    return res.versions;
  }

  async getVersion(unitType: string, version: string): Promise<RegistryEntry> {
    const res = await this.http.json<{ entry: RegistryEntry }>({
      method: 'GET',
      path: `/v1/registry/unit-types/${encodeURIComponent(unitType)}/versions/${encodeURIComponent(version)}`,
    });
    return res.entry;
  }

  async createVersion(unitType: string, body: RegistryEntryCreate): Promise<RegistryEntry> {
    const res = await this.http.json<{ entry: RegistryEntry }>({
      method: 'POST',
      path: `/v1/registry/unit-types/${encodeURIComponent(unitType)}/versions`,
      body,
    });
    return res.entry;
  }

  async activateVersion(unitType: string, version: string): Promise<RegistryEntry> {
    const res = await this.http.json<{ entry: RegistryEntry }>({
      method: 'POST',
      path: `/v1/registry/unit-types/${encodeURIComponent(unitType)}/versions/${encodeURIComponent(version)}/activate`,
    });
    return res.entry;
  }
}
