import { describe, expect, it } from 'vitest'
import { ALL_MASK_KINDS, maskSensitiveData } from '#src/core/security/mask-sensitive-data.ts'

const mask = (text: string) =>
  maskSensitiveData(text, { detectors: ALL_MASK_KINDS, custom: [], keepEmailDomains: false })

describe('maskSensitiveData', () => {
  it.each([
    ['email', 'write to ana.lopez+ops@cliente.com.mx today', 'write to [EMAIL_1] today'],
    ['curp', 'CURP: GODE561231HDFRRN09.', 'CURP: [CURP_1].'],
    ['rfc (company)', 'RFC ABC680524P76 registrado', 'RFC [RFC_1] registrado'],
    ['rfc (person)', 'rfc: GODE561231GR8', 'rfc: [RFC_1]'],
    ['clabe', 'CLABE 002010077777777771 del cliente', 'CLABE [CLABE_1] del cliente'],
    ['card', 'tarjeta 4111 1111 1111 1111 rechazada', 'tarjeta [CARD_1] rechazada'],
    ['card (no spaces)', 'card=5555555555554444', 'card=[CARD_1]'],
    ['phone (+52)', 'llamar al +52 55 1234 5678', 'llamar al [PHONE_1]'],
    ['phone (local)', 'tel (55) 1234-5678 o 55-8765-4321', 'tel [PHONE_1] o [PHONE_2]'],
    ['phone (same number, other format)', '(55) 1234-5678 = 55 1234 5678', '[PHONE_1] = [PHONE_1]'],
    ['jwt', 'token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.abcdefghijk', 'token [SECRET_1]'],
    ['bearer', 'Authorization: Bearer abcdef0123456789abcdef', 'Authorization: Bearer [SECRET_1]'],
    ['stripe key', 'usa sk_live_51HxYzAbCdEfGh123', 'usa [SECRET_1]'],
    ['aws key', 'AKIAIOSFODNN7EXAMPLE', '[SECRET_1]'],
    ['atlassian token', 'ATATT3xFfGF0aBcDeFgHiJkLmNoPqRsT', '[SECRET_1]'],
    [
      'key = value',
      'api_key: abc123secret, password="hunter22"',
      'api_key: [SECRET_1], password="[SECRET_2]"',
    ],
    [
      'url credentials',
      'mysql://app:s3cr3t@db.internal:3306/x',
      'mysql://app:[SECRET_1]@db.internal:3306/x',
    ],
  ])('masks %s', (_, input, expected) => {
    expect(mask(input).text).toBe(expected)
  })

  it.each([
    ['ticket keys', 'Ver OPS-2403 y OPS-42'],
    ['dates and times', '2026-09-30T16:17:59.704Z, 30/09/2026, 2026-10-15'],
    ['amounts', 'Monto $12,345.67 MXN y 1234567.89'],
    ['uuids', 'id 3f2b8c1e-9a4d-4e2b-8f3c-1a2b3c4d5e6f'],
    ['long ids without a valid checksum', 'folio 123456789012345678 y pedido 4111111111111112'],
    ['plain 10-digit numbers', 'contrato 5512345678'],
    ['mentions and customer names', '@Ana Pérez revisa NORTHWIND | Contoso Payments'],
    ['urls without credentials', 'https://example.atlassian.net/browse/OPS-2403'],
    ['rfc-like codes with impossible dates', 'codigo ABC991399XYZ'],
    ["SAT's generic RFCs", 'RFC genérico XAXX010101000 y extranjero XEXX010101000'],
  ])('leaves %s untouched', (_, input) => {
    expect(mask(input)).toEqual({ text: input, counts: {} })
  })

  it('reuses the placeholder for repeated values and counts occurrences', () => {
    const result = mask('a@x.com, b@x.com, a@x.com')
    expect(result.text).toBe('[EMAIL_1], [EMAIL_2], [EMAIL_1]')
    expect(result.counts).toEqual({ email: 3 })
  })

  it('treats emails case-insensitively for consistency', () => {
    expect(mask('Ana@X.com y ana@x.com').text).toBe('[EMAIL_1] y [EMAIL_1]')
  })

  it('keeps corporate email domains visible but hides public providers', () => {
    const result = maskSensitiveData(
      'ana@contoso.com.mx, ANA@Contoso.com.mx, juan.perez@gmail.com, x@Hotmail.com',
      { detectors: ['email'], custom: [], keepEmailDomains: true },
    )
    expect(result.text).toBe(
      '[EMAIL_1]@contoso.com.mx, [EMAIL_1]@contoso.com.mx, [EMAIL_2], [EMAIL_3]',
    )
  })

  // Regression: repository maps and repo_list showed ssh clone URLs as [EMAIL_1]@bitbucket.org.
  it('leaves git remote URLs alone but still masks addresses next to punctuation', () => {
    const remotes =
      'git@bitbucket.org:acme/billing-backend.git ssh://git@git.acme.dev:7999/acme/tools.git ssh://git@github.com/acme/web'
    expect(mask(remotes).text).toBe(remotes)
    expect(
      mask('Write to ana@northwind.mx: urgent (cc juan@contoso.com). Thanks, ana@northwind.mx.')
        .text,
    ).toBe('Write to [EMAIL_1]: urgent (cc [EMAIL_2]). Thanks, [EMAIL_1].')
  })

  it.each([
    ['password=abc[12345', 'password=[SECRET_1]'],
    ['token: s3cr[et-value', 'token: [SECRET_1]'],
    ['mysql://u:pa[ss@host/db', 'mysql://u:[SECRET_1]@host/db'],
  ])('masks secrets that contain "[" (%s)', (text, expected) => {
    expect(mask(text).text).toBe(expected)
  })

  it('leaves values that already hold a placeholder alone', () => {
    expect(mask('password=[SECRET_7] Bearer [SECRET_8]').text).toBe(
      'password=[SECRET_7] Bearer [SECRET_8]',
    )
  })

  it('only runs the enabled detectors', () => {
    const result = maskSensitiveData('a@x.com +52 55 1234 5678', {
      detectors: ['phone'],
      custom: [],
      keepEmailDomains: false,
    })
    expect(result.text).toBe('a@x.com [PHONE_1]')
  })

  it('applies custom rules after the built-in ones, without touching placeholders', () => {
    const result = maskSensitiveData('cliente ACME-0042 escribió desde a@x.com', {
      detectors: ['email'],
      keepEmailDomains: false,
      custom: [
        { label: 'customer id', pattern: 'ACME-\\d+' },
        { label: 'greedy', pattern: '\\[[A-Z]+_\\d+\\]' },
      ],
    })
    expect(result.text).toBe('cliente [CUSTOMER_ID_1] escribió desde [EMAIL_1]')
    expect(result.counts).toEqual({ email: 1, customer_id: 1 })
  })
})
