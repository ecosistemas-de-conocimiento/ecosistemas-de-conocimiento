// The ONE `z` every wire schema is built from.
//
// 🔴 ORDER IS LOAD-BEARING — this is not a style preference.
//
// `@asteasolutions/zod-to-openapi`'s `extendZodWithOpenApi(z)` adds the
// `.openapi()` method by patching `z.ZodType.prototype`. Under Zod 3 that was
// retroactive: a schema built before the call still picked the method up off
// its prototype chain, so it did not matter where the extension ran.
//
// Under Zod 4 it is NOT retroactive. Zod 4 builds each class's prototype at
// that class's first instantiation, so an instance constructed BEFORE the
// extension has a prototype snapshot without `.openapi` — permanently. Later
// instances of the same class are fine, which is what makes the failure so
// unpleasant: it depends on module evaluation order, and it surfaces far away
// as `TypeError: zodSchema.openapi is not a function` inside
// `OpenAPIRegistry.register`, naming a schema that looks perfectly ordinary.
//
// Measured on zod 4.5.4 / zod-to-openapi 9.1.0:
//     const early = z.string();          // built first
//     extendZodWithOpenApi(z);
//     typeof early.openapi   // 'undefined'
//     typeof z.string().openapi  // 'function'
//
// So: every module that CONSTRUCTS a schema which may end up in the OpenAPI
// document imports `z` from here, never from 'zod' directly. This module runs
// the extension as an import side effect, before it re-exports, which makes
// the ordering a property of the import graph instead of a convention someone
// has to remember.
//
// `src/config/env.ts` is the deliberate exception: its schemas are never
// registered, and it is on the boot path, so it stays on plain zod.
//
// `./zod-import-guard.test.ts` enforces exactly that pair by reading the source
// text. It has to: today `src/openapi/registry.ts` imports this module first, so
// a contract module switching to plain `zod` changes NOTHING observable — not
// tsc, not lint, not the suite, not the served document — until the import graph
// shifts later and the failure surfaces somewhere else entirely.

import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';

extendZodWithOpenApi(z);

export { z };
