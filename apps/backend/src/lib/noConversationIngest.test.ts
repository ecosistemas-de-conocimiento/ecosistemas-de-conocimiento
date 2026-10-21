/**
 * 🔴 Chat turns never enter the corpus (owner ruling 2026-10-21): no production
 * file may call the conversation-ingest entry points. The library stays for
 * its id helpers and the erase bookkeeping (`conversationIngest.ts` header).
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const SRC = fileURLToPath(new URL('..', import.meta.url))
const SCRIPTS = fileURLToPath(new URL('../../scripts', import.meta.url))

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return name === 'node_modules' ? [] : sources(path)
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : []
  })
}

describe('🔴 no conversation turn is ever ingested', () => {
  it('nothing outside conversationIngest.ts calls ingestConversationTurns or releaseConversationsWaitingOn', () => {
    const callers = [...sources(SRC), ...sources(SCRIPTS)]
      .filter((path) => !path.endsWith(join('lib', 'conversationIngest.ts')))
      .filter((path) =>
        /\b(ingestConversationTurns|releaseConversationsWaitingOn)\b/.test(readFileSync(path, 'utf8')),
      )
    expect(callers).toEqual([])
  })

  it('the messages collection registers no afterChange hook', async () => {
    const { Messages } = await import('../collections/Messages')
    expect(Messages.hooks?.afterChange ?? []).toHaveLength(0)
  })
})
