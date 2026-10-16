import { describe, expect, it } from 'vitest'
import { ALL_MASK_KINDS } from '#src/core/security/mask-sensitive-data.ts'
import { PlaceholderVault } from '#src/core/security/placeholder-vault.ts'

const options = { detectors: ALL_MASK_KINDS, custom: [], keepEmailDomains: true }

describe('PlaceholderVault', () => {
  it('keeps placeholders consistent across calls', () => {
    const vault = new PlaceholderVault()
    expect(vault.mask('de ana@contoso.mx', options).text).toBe('de [EMAIL_1]@contoso.mx')
    expect(vault.mask('para luis@northwind.mx y ana@contoso.mx', options).text).toBe(
      'para [EMAIL_2]@northwind.mx y [EMAIL_1]@contoso.mx',
    )
  })

  it('re-masks values it has seen even where no detector would match', () => {
    const vault = new PlaceholderVault()
    vault.mask('RFC GODE561231GR8', options)
    // e.g. JIRA echoing a value inside an error message, glued to other text
    expect(vault.mask('valor invalido:GODE561231GR8x', options).text).toBe(
      'valor invalido:[RFC_1]x',
    )
  })

  it('resolves placeholders with or without the visible domain', () => {
    const vault = new PlaceholderVault()
    vault.mask('ana@contoso.mx y 002010077777777771', options)

    expect(
      vault.resolve(
        'reporter = "[EMAIL_1]@contoso.mx" OR text ~ "[EMAIL_1]" OR text ~ "[CLABE_1]"',
      ),
    ).toEqual({
      ok: true,
      value:
        'reporter = "ana@contoso.mx" OR text ~ "ana@contoso.mx" OR text ~ "002010077777777771"',
    })
  })

  it('rejects placeholders it never issued', () => {
    const vault = new PlaceholderVault()
    vault.mask('ana@contoso.mx', options)
    expect(vault.resolve('text ~ "[EMAIL_7]" OR text ~ "[PHONE_1]"')).toEqual({
      ok: false,
      error: ['[EMAIL_7]', '[PHONE_1]'],
    })
  })

  it('leaves text without placeholders untouched', () => {
    expect(
      new PlaceholderVault().resolve('project = OPS AND text ~ "[attachment: a.png]"'),
    ).toEqual({
      ok: true,
      value: 'project = OPS AND text ~ "[attachment: a.png]"',
    })
  })

  it('reveals real values for local files, except secrets and placeholders it never issued', () => {
    const vault = new PlaceholderVault()
    const masked = vault.mask(
      'ana@contoso.mx, tel +52 55 1234 5678, token=ghp_abcdefghijklmnopqrstuvwxyz0123456789',
      options,
    ).text
    expect(masked).toBe('[EMAIL_1]@contoso.mx, tel [PHONE_1], token=[SECRET_1]')

    const answer = `Contact [EMAIL_1]@contoso.mx or [EMAIL_1] at [PHONE_1]; key [SECRET_1]; also [EMAIL_9].`
    expect(vault.reveal(answer)).toBe(
      'Contact ana@contoso.mx or ana@contoso.mx at +52 55 1234 5678; key [SECRET_1]; also [EMAIL_9].',
    )
  })
})
