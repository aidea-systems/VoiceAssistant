import { describe, expect, it } from 'vitest'

import { MailboxGate } from './mailbox-gate.js'

const tick = () => new Promise((r) => setTimeout(r, 0))

describe('MailboxGate', () => {
  it('G-1: at most the limit per user, the rest queue in arrival order; other users are not held', async () => {
    const gate = new MailboxGate(2)
    const a = await gate.acquire('u1')
    const b = await gate.acquire('u1')
    const order: string[] = []
    const c = gate.acquire('u1').then((r) => (order.push('c'), r))
    const d = gate.acquire('u1').then((r) => (order.push('d'), r))
    expect(await gate.acquire('u2')).toBeTypeOf('function')
    await tick()
    expect(order).toEqual([])
    expect(gate.inUse('u1')).toBe(2)
    a()
    await tick()
    expect(order).toEqual(['c'])
    b()
    await tick()
    expect(order).toEqual(['c', 'd'])
    expect(gate.inUse('u1')).toBe(2)
    ;(await c)()
    ;(await d)()
    expect(gate.inUse('u1')).toBe(0)
  })

  it('G-2: an abort while waiting leaves the queue; a second release frees nothing more', async () => {
    const gate = new MailboxGate(1)
    const held = await gate.acquire('u1')
    const ac = new AbortController()
    const waiting = gate.acquire('u1', ac.signal)
    ac.abort(new Error('stop'))
    await expect(waiting).rejects.toThrow('stop')
    const next = gate.acquire('u1')
    held()
    held()
    const release = await next
    expect(gate.inUse('u1')).toBe(1)
    release()
    expect(gate.inUse('u1')).toBe(0)
    await expect(gate.acquire('u1', AbortSignal.abort())).rejects.toBeDefined()
    expect(gate.inUse('u1')).toBe(0)
  })
})
