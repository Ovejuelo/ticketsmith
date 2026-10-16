import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { err, ok, type Result } from '../kernel/index.ts'
import { BUG_PLAYBOOK } from './playbooks/bug.ts'
import { CLASSIFY_PLAYBOOK } from './playbooks/classify.ts'
import { CODE_FIX_PLAYBOOK } from './playbooks/code-fix.ts'
import { FEATURE_DESIGN_PLAYBOOK } from './playbooks/feature-design.ts'
import { FEATURE_IMPLEMENT_PLAYBOOK } from './playbooks/feature-implement.ts'
import { REPO_ANALYSIS_PLAYBOOK } from './playbooks/repo-analysis.ts'
import { REPORT_PLAYBOOK } from './playbooks/report.ts'
import { SERVICE_REQUEST_PLAYBOOK } from './playbooks/service-request.ts'

export const BUILT_IN_PLAYBOOKS: Readonly<Record<string, string>> = {
  bug: BUG_PLAYBOOK,
  classify: CLASSIFY_PLAYBOOK,
  'code-fix': CODE_FIX_PLAYBOOK,
  'feature-design': FEATURE_DESIGN_PLAYBOOK,
  'feature-implement': FEATURE_IMPLEMENT_PLAYBOOK,
  'repo-analysis': REPO_ANALYSIS_PLAYBOOK,
  report: REPORT_PLAYBOOK,
  'service-request': SERVICE_REQUEST_PLAYBOOK,
}

export type Playbook = {
  readonly name: string
  readonly text: string
  /** Where it came from: the project's knowledge or the built-in default. */
  readonly source: 'project' | 'built-in'
}

/** The project's knowledge/playbooks/<name>.md, or the built-in playbook with that name. */
export const loadPlaybook = async (
  knowledgeDir: string,
  name: string,
): Promise<Result<Playbook, string>> => {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) {
    return err(`Invalid playbook name "${name}": use lowercase letters, digits and "-"`)
  }
  try {
    const text = await readFile(join(knowledgeDir, 'playbooks', `${name}.md`), 'utf8')
    if (text.trim() !== '') return ok({ name, text, source: 'project' })
  } catch {
    // No project playbook: fall back to the built-in one.
  }
  const builtIn = BUILT_IN_PLAYBOOKS[name]
  return builtIn === undefined
    ? err(
        `No playbook "${name}": add knowledge/playbooks/${name}.md or use one of ${Object.keys(BUILT_IN_PLAYBOOKS).join(', ')}.`,
      )
    : ok({ name, text: builtIn, source: 'built-in' })
}
