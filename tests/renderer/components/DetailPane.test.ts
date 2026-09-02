import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('DetailPane result layout', () => {
  const source = readFileSync(resolve('src/renderer/components/DetailPane.tsx'), 'utf8')

  it('keeps the shared result shelf clear of the action-row divider', () => {
    const shelf = /className="detail-result-shelf ([^"]+)"/.exec(source)?.[1]

    expect(shelf).toContain('border-t')
    expect(shelf).toContain('py-3')
    expect(shelf).toContain('empty:hidden')
    expect(shelf).not.toContain('pt-3')
  })
})
