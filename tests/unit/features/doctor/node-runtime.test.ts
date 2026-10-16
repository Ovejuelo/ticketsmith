import { describe, expect, it } from 'vitest'
import { checkNodeRuntime } from '#src/features/doctor/node-runtime.ts'

describe('checkNodeRuntime', () => {
  const installed = ['14.21.3', '20.11.1', '24.20.0']

  it('accepts a major, minor or exact version that is installed', () => {
    expect(checkNodeRuntime('20', installed)).toEqual({
      status: 'ok',
      detail: 'Node 20 installed (20.11.1)',
    })
    expect(checkNodeRuntime('14.21.3', installed).status).toBe('ok')
    expect(checkNodeRuntime('2', installed).status).toBe('warn') // not a prefix of 20.x
  })

  it('warns with the install command when the version is missing', () => {
    expect(checkNodeRuntime('18', installed)).toEqual({
      status: 'warn',
      detail: 'Node 18 is not installed: `fnm install 18`',
    })
  })

  it('skips ranges and machines without fnm', () => {
    expect(checkNodeRuntime('>=18', installed).status).toBe('skip')
    expect(checkNodeRuntime('20', null)).toEqual({
      status: 'skip',
      detail: 'Node 20 (fnm not found, not checked)',
    })
  })
})
