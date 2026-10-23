// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RunOutputPage } from '@shared/records'

const ipcInvoke = vi.hoisted(() => vi.fn())
vi.mock('@renderer/ipc/client', () => ({ ipcInvoke }))
import { PagedRunOutput } from '@renderer/records/PagedRunOutput'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root
let host: HTMLDivElement
const base = { kind: 'ytdlp-run' as const, id: 4, stream: 'stdout' as const, label: 'Output', initial: { text: 'first page', more: true } }

beforeEach(() => {
  ipcInvoke.mockReset()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})
const button = (text: string): HTMLButtonElement => [...host.querySelectorAll('button')].find((item) => item.textContent === text)!
async function click(text: string) { await act(async () => button(text).click()) }
function pending() {
  let resolve!: (page: RunOutputPage) => void
  const promise = new Promise<RunOutputPage>((done) => { resolve = done })
  ipcInvoke.mockReturnValueOnce(promise)
  return (page: RunOutputPage) => act(async () => { resolve(page) })
}

describe('bounded run output component', () => {
  it('shows small initial output without another read and hides empty or whitespace-only output', async () => {
    await act(async () => root.render(createElement(PagedRunOutput, { ...base, initial: { text: 'small output', more: false } })))
    expect(host.querySelector('pre')?.textContent).toBe('small output')
    expect(host.querySelector('button')).toBeNull()
    expect(ipcInvoke).not.toHaveBeenCalled()
    await act(async () => root.render(createElement(PagedRunOutput, { ...base, id: 5, initial: { text: ' \n', more: false } })))
    expect(host.querySelector('section')).toBeNull()
  })

  it('retains only the selected page and rereads previous pages', async () => {
    await act(async () => root.render(createElement(PagedRunOutput, base)))
    expect(button('Previous').disabled).toBe(true)
    const second = pending()
    await click('Next')
    expect(host.textContent).not.toContain('first page')
    expect(host.textContent).toContain('Loading')
    expect(button('Next').disabled).toBe(true)
    await second({ text: 'second page', more: true })
    expect(ipcInvoke).toHaveBeenLastCalledWith('records:output', { kind: 'ytdlp-run', id: 4, stream: 'stdout', page: 1 })
    const last = pending()
    await click('Next')
    await last({ text: 'last page', more: false })
    expect(host.querySelector('pre')?.textContent).toBe('last page')
    expect(host.textContent).not.toContain('second page')
    expect(button('Next').disabled).toBe(true)
    const previous = pending()
    await click('Previous')
    await previous({ text: 'reread second page', more: true })
    expect(ipcInvoke).toHaveBeenLastCalledWith('records:output', { kind: 'ytdlp-run', id: 4, stream: 'stdout', page: 1 })
    expect(host.querySelector('pre')?.textContent).toBe('reread second page')
  })

  it.each(['record', 'stream'] as const)('ignores an old request after selecting another %s', async (changed) => {
    await act(async () => root.render(createElement(PagedRunOutput, base)))
    const old = pending()
    await click('Next')
    await act(async () => root.render(createElement(PagedRunOutput, {
      ...base, id: changed === 'record' ? 5 : 4, stream: changed === 'stream' ? 'stderr' : 'stdout', initial: { text: 'new initial page', more: false },
    })))
    await old({ text: 'stale result', more: true })
    expect(host.querySelector('pre')?.textContent).toBe('new initial page')
    expect(host.textContent).not.toContain('stale result')
    expect(host.querySelector('button')).toBeNull()
  })

  it('presents a safe failure and retries the same page', async () => {
    await act(async () => root.render(createElement(PagedRunOutput, base)))
    ipcInvoke.mockRejectedValueOnce(new Error('private raw database detail'))
    await click('Next')
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('This output could not be read.')
    expect(host.textContent).not.toContain('private raw')
    const retried = pending()
    await click('Try again')
    await retried({ text: 'recovered second page', more: false })
    expect(ipcInvoke).toHaveBeenLastCalledWith('records:output', { kind: 'ytdlp-run', id: 4, stream: 'stdout', page: 1 })
    expect(host.querySelector('pre')?.textContent).toBe('recovered second page')
  })
})
