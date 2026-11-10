import { existsSync, readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { parseConsentIdsFile } from './consentHold'

/** The workshop list kept outside the repo (2026-11-10); checked only where it exists. */
const WORKSHOP_LIST = '~/chamba/cide/plan/orchestration/taller-2026-11-10/consent-ids.txt'

describe('parseConsentIdsFile', () => {
  it('reads the first column, skips comments and blanks, leaves out EXTRA-NO-TALLER', () => {
    const text = [
      '# header, even one that says EXTRA-NO-TALLER',
      '1178\tcasos\t',
      '',
      '788\textra-788-796-799\t',
      '823\tEXTRA-NO-TALLER\tnot workshop material',
      '1178\tcasos\tduplicate',
    ].join('\n')
    expect(parseConsentIdsFile(text)).toEqual(['1178', '788'])
  })

  it('refuses a line whose first column is not an id', () => {
    expect(() => parseConsentIdsFile('12a\tcasos\n')).toThrow(/line 1/)
  })

  it.skipIf(!existsSync(WORKSHOP_LIST))('the workshop list gives 184 ids, none of the 3 extras', () => {
    const ids = parseConsentIdsFile(readFileSync(WORKSHOP_LIST, 'utf8'))
    expect(ids).toHaveLength(184)
    for (const extra of ['823', '824', '1425']) expect(ids).not.toContain(extra)
  })
})
