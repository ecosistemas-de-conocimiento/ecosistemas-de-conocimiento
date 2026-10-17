// The ONE `OpenAPIRegistry` instance, in its own module.
//
// `components.ts` registers schemas onto it, `route-table.ts` reads those
// registered handles, and `registry.ts` registers the paths and generates the
// document. Splitting the instance out is what keeps that chain acyclic —
// components would otherwise have to import the module that imports it.

import { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';

export const registry = new OpenAPIRegistry();
