import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  loadTicketTypes,
  OTHER,
  saveClassification,
  toClassification,
} from '../classification/index.ts'
import { askChoice, askConfirm, askText, type OpenedProject } from '../cli/index.ts'
import { saveCase } from './cases.ts'

/**
 * After a run, in a terminal only: was the classification right (a correction is saved as the
 * person's decision), and should the ticket become a resolved case in knowledge/cases?
 */
export const reviewRun = async (
  opened: OpenedProject,
  key: string,
  show: (text: string) => void,
): Promise<void> => {
  const { paths, project } = opened
  const saved = await readFile(join(paths.outDir, key, 'classification.json'), 'utf8').catch(
    () => null,
  )
  const types = await loadTicketTypes(paths.knowledgeDir)
  if (saved !== null && types.ok && types.value !== null) {
    const current = JSON.parse(saved) as { type?: string; source?: string }
    if (
      current.source !== 'human' &&
      !(await askConfirm(`Was "${current.type}" the right type for ${key}?`, true))
    ) {
      const choices = [
        ...types.value.types.map((type) => ({ value: type.name, label: type.name })),
        { value: OTHER, label: OTHER },
      ]
      const chosen = await askChoice(`Which type is ${key}?`, choices, current.type)
      await saveClassification(
        paths.outDir,
        key,
        toClassification(
          types.value,
          chosen,
          1,
          `Corrected by a person (was ${current.type}).`,
          'human',
        ),
      )
    }
  }
  if (!(await askConfirm(`Save ${key} as a resolved case in knowledge/cases (masked)?`, false)))
    return
  const note = (
    await askText({ message: 'How was it resolved? (optional, one or two sentences)' })
  ).trim()
  const written = await saveCase(
    paths.knowledgeDir,
    paths.outDir,
    key,
    note === '' ? undefined : note,
    project.masking,
  )
  show(
    written.ok
      ? `Saved knowledge/${written.value}.\n`
      : `Could not save the case: ${written.error}\n`,
  )
}
