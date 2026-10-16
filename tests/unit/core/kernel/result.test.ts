import { describe, expect, it } from 'vitest'
import { err, mapResult, ok, type Result } from '#src/core/kernel/result.ts'

describe('Result', () => {
  it('maps only the success value', () => {
    const double = (r: Result<number, string>) => mapResult(r, (n) => n * 2)
    expect(double(ok(2))).toEqual(ok(4))
    expect(double(err('failed'))).toEqual(err('failed'))
  })
})
