import { describe, expect, it } from 'vitest'
import { tagType, templateTags } from '#src/core/metabase/index.ts'

describe('templateTags', () => {
  it('finds each variable once, guesses its type and marks optional ones', () => {
    const tags = templateTags(
      `SELECT * FROM invoices
       WHERE created_at BETWEEN {{start_date}} AND {{ end_date }}
       [[AND account_id = {{account_id}}]]
       [[AND status = {{status}}]] AND created_at >= {{start_date}}
       -- {{snippet: active}} and {{#12}} are not variables`,
    )
    expect(Object.keys(tags)).toEqual(['start_date', 'end_date', 'account_id', 'status'])
    expect(tags['start_date']).toMatchObject({
      name: 'start_date',
      'display-name': 'Start date',
      type: 'date',
      required: true,
    })
    expect(tags['account_id']).toMatchObject({ type: 'number', required: false })
    expect(tags['status']).toMatchObject({ type: 'text', required: false })
    expect(tags['start_date']?.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    )
    expect(templateTags('{{start_date}}')['start_date']?.id).toBe(tags['start_date']?.id)
  })

  it('guesses types from common names', () => {
    expect(['fecha_inicio', 'desde', 'paid_at', 'day'].map(tagType)).toEqual([
      'date',
      'date',
      'date',
      'date',
    ])
    expect(['customer_id', 'limit', 'monto', 'year'].map(tagType)).toEqual([
      'number',
      'number',
      'number',
      'number',
    ])
    expect(['email', 'status', 'total', 'todo'].map(tagType)).toEqual([
      'text',
      'text',
      'text',
      'text',
    ])
  })
})
