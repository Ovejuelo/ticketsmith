import * as clack from '@clack/prompts'
import { fail } from './io.ts'

// Thin wrappers that turn Ctrl+C into a clean CliError instead of a symbol to check everywhere.

const orCancel = <T>(value: T): Exclude<T, symbol> => {
  if (clack.isCancel(value) || typeof value === 'symbol') {
    clack.cancel('Cancelled.')
    fail('Cancelled by the user.')
  }
  return value as Exclude<T, symbol>
}

export const askText = async (options: {
  message: string
  initialValue?: string
  placeholder?: string
  validate?: (value: string) => string | undefined
}): Promise<string> =>
  orCancel(
    await clack.text({
      message: options.message,
      initialValue: options.initialValue ?? '',
      placeholder: options.placeholder ?? '',
      validate: (value) => options.validate?.(value ?? ''),
    }),
  ).trim()

export const askSecret = async (message: string): Promise<string> =>
  orCancel(
    await clack.password({
      message,
      validate: (value) => (value ? undefined : 'Required'),
    }),
  ).trim()

export type Choice<T> = { readonly value: T; readonly label: string; readonly hint?: string }

const toOptions = <T>(choices: readonly Choice<T>[]) =>
  choices.map((choice) =>
    choice.hint === undefined
      ? { value: choice.value, label: choice.label }
      : { value: choice.value, label: choice.label, hint: choice.hint },
  ) as clack.Option<T>[]

// Short lists use a plain select; long ones (projects, fields) get type-to-filter.
export const askChoice = async <T>(
  message: string,
  choices: readonly Choice<T>[],
  initialValue?: T,
): Promise<T> => {
  const options = {
    message,
    options: toOptions(choices),
    maxItems: 12,
    ...(initialValue === undefined ? {} : { initialValue }),
  }
  return orCancel(
    choices.length <= 7 ? await clack.select<T>(options) : await clack.autocomplete<T>(options),
  )
}

export const askChoices = async <T>(
  message: string,
  choices: readonly Choice<T>[],
  initialValues: readonly T[],
): Promise<readonly T[]> =>
  orCancel(
    await clack.autocompleteMultiselect<T>({
      message,
      options: toOptions(choices),
      initialValues: [...initialValues],
      maxItems: 12,
      required: false,
    }),
  )

export const askConfirm = async (message: string, initialValue = true): Promise<boolean> =>
  orCancel(await clack.confirm({ message, initialValue }))

export const { intro, outro, log, spinner, note } = clack
