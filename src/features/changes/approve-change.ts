import { createHash } from 'node:crypto'
import { userInfo } from 'node:os'
import { join } from 'node:path'
import type { OpenedProject } from '../../core/cli/index.ts'
import {
  type ApprovedChange,
  type ChangeRequest,
  ChangeStore,
  DATABASE_CATALOG,
  describeChangeError,
  type GuardedChange,
  guardChange,
  insertRollback,
  isExpired,
  preflightChange,
  TableInfoSchema,
} from '../../core/database/index.ts'
import { err, ok, type Result } from '../../core/kernel/index.ts'
import { describeOutputError, ticketOutputDir, writeOutputFiles } from '../../core/output/index.ts'
import { DatabaseConnections, type Services } from '../../core/services/index.ts'
import { describeStorageError, withProjectDatabase } from '../../core/storage/index.ts'
import { TicketKeySchema } from '../../core/tickets/index.ts'
import { renderChange } from './render-change.ts'

/** The only place an ApprovedChange is made: after the human typed the database name. */
const markApproved = (change: GuardedChange, expectedRows: number): ApprovedChange =>
  ({ change, expectedRows }) as unknown as ApprovedChange

export type ApprovalIo = {
  /** Shows text to the approver. */
  show(text: string): void
  /** Asks the approver to type the database name; resolves with what they typed. */
  confirm(message: string): Promise<string>
}

export type ApprovalOutcome = {
  readonly change: ChangeRequest
  readonly files: readonly string[]
}

const tablesOf = async (opened: OpenedProject, target: string) => {
  const read = await withProjectDatabase(opened.paths.sqlite, (db) =>
    db.catalog(DATABASE_CATALOG.integration, DATABASE_CATALOG.tableKind(target), TableInfoSchema),
  )
  if (!read.ok) return err(describeStorageError(read.error))
  return read.value.ok
    ? ok(read.value.value.map((entry) => entry.data))
    : err(describeStorageError(read.value.error))
}

/**
 * Human approval of a proposed change: re-validate the SQL, re-run the read-only preflight (the
 * data may have moved since it was proposed), show everything with real values, require the
 * database name typed back, then run it in a transaction that commits only if the affected rows
 * match. The outcome, the SQL and the rollback script go to out/ and the audit log.
 */
export const approveAndExecute = async (
  services: Services,
  opened: OpenedProject,
  id: string,
  io: ApprovalIo,
  now: () => Date = () => new Date(),
): Promise<Result<ApprovalOutcome, string>> => {
  const store = new ChangeStore(opened.paths.changesDir)
  const loaded = await store.load(id)
  if (!loaded.ok) return loaded
  const change = loaded.value
  if (change.status !== 'proposed')
    return err(`Change ${id} is ${change.status}; only proposed changes can be approved.`)
  if (isExpired(change, now()))
    return err(`Change ${id} expired at ${change.expiresAt}; ask the agent to propose it again.`)
  // The key names the output folder, so it must be a plain key (never a path).
  if (change.ticket !== null && !TicketKeySchema.safeParse(change.ticket).success)
    return err(`Change ${id} names an invalid ticket "${change.ticket}"; reject it.`)

  const config = opened.project.integrations.databases?.find((db) => db.name === change.database)
  if (config === undefined) return err(`Database "${change.database}" is no longer configured.`)
  if (!config.allowChanges)
    return err(`Database "${change.database}" no longer allows changes (allowChanges is off).`)

  const tables = await tablesOf(opened, config.group ?? config.name)
  if (!tables.ok) return tables
  const guarded = guardChange(change.sql, { dialect: config.type, tables: tables.value })
  if (!guarded.ok)
    return err(`The change no longer passes the write guard: ${guarded.error.reason}`)

  const connections = new DatabaseConnections(services, opened.project)
  try {
    const adapter = await connections.connect(change.database)
    if (!adapter.ok) return adapter
    const preflight = await preflightChange(adapter.value, guarded.value, {
      maxRows: opened.project.changes.maxRows,
      changeId: change.id,
    })
    if (!preflight.ok) return err(`The preflight failed again: ${preflight.error}`)
    if (preflight.value.rows !== change.preflight.rows) {
      return err(
        `The data moved: the change now affects ${preflight.value.rows} rows instead of ${change.preflight.rows}. Nothing ran; ask the agent to propose it again.`,
      )
    }
    const current: ChangeRequest = {
      ...change,
      preflight: {
        rows: preflight.value.rows,
        sample: [...preflight.value.sample],
        usesIndex: preflight.value.usesIndex,
      },
      rollbackSql: preflight.value.rollbackSql,
    }
    io.show(renderChange(current, now()))
    const typed = await io.confirm(
      `Type the database name (${change.database}) to run this change, or anything else to cancel`,
    )
    if (typed.trim() !== change.database) return err('Not approved: nothing ran.')
    // The prompt may have stayed open past the expiry.
    if (isExpired(change, now()))
      return err(`Change ${id} expired at ${change.expiresAt} while waiting: nothing ran.`)

    const by = userInfo().username
    const started = Date.now()
    const executed = await adapter.value.executeChange(
      markApproved(guarded.value, preflight.value.rows),
    )
    const audit = services.openAuditLog(opened.project.name, opened.paths, 'changes')
    const sqlSha256 = createHash('sha256').update(change.sql).digest('hex')
    await audit.record({
      tool: 'change_execute',
      input: {
        id: change.id,
        database: change.database,
        kind: change.kind,
        table: change.table,
        rows: preflight.value.rows,
        sqlSha256,
        approvedBy: by,
      },
      ok: executed.ok,
      ...(executed.ok ? {} : { error: describeChangeError(executed.error) }),
      durationMs: Date.now() - started,
    })

    const decided: ChangeRequest = {
      ...current,
      status: executed.ok ? 'executed' : 'failed',
      decision: { at: now().toISOString(), by },
      result: executed.ok
        ? { affectedRows: executed.value.affectedRows, insertId: executed.value.insertId }
        : { error: describeChangeError(executed.error) },
      ...(executed.ok && change.kind === 'insert'
        ? {
            rollbackSql: insertRollback(
              guarded.value,
              executed.value.insertedKeys ??
                guarded.value.listedKeys ??
                insertedKeys(guarded.value, executed.value.insertId, preflight.value.rows),
              change.id,
            ),
          }
        : {}),
    }
    const saved = await store.save(decided)
    if (!saved.ok) return saved

    const dir =
      change.ticket === null
        ? join(opened.paths.outDir, 'changes', change.id)
        : join(ticketOutputDir(opened.paths.outDir, change.ticket), `change-${change.id}`)
    const written = await writeOutputFiles(dir, {
      'change.sql': `-- ${change.id} on ${change.database}, approved by ${by}\n${change.sql};\n`,
      ...(decided.rollbackSql === null ? {} : { 'rollback.sql': decided.rollbackSql }),
      'preflight.json': `${JSON.stringify(current.preflight, null, 2)}\n`,
      'result.json': `${JSON.stringify({ status: decided.status, ...decided.result, decision: decided.decision }, null, 2)}\n`,
    })
    if (!written.ok) return err(describeOutputError(written.error))
    if (!executed.ok) return err(describeChangeError(executed.error))
    return ok({ change: decided, files: written.value })
  } finally {
    await connections[Symbol.asyncDispose]()
  }
}

/** The keys an INSERT created: consecutive AUTO_INCREMENT ids for a one-column primary key. */
const insertedKeys = (
  change: GuardedChange,
  insertId: number | null,
  rows: number,
): readonly Record<string, unknown>[] | null => {
  const [key] = change.primaryKey
  if (
    insertId === null ||
    key === undefined ||
    change.primaryKey.length !== 1 ||
    change.columns.includes(key)
  ) {
    return null
  }
  return Array.from({ length: rows }, (_, index) => ({ [key]: insertId + index }))
}

export const rejectChange = async (
  opened: OpenedProject,
  id: string,
  reason: string | undefined,
  now: () => Date = () => new Date(),
): Promise<Result<ChangeRequest, string>> => {
  const store = new ChangeStore(opened.paths.changesDir)
  const loaded = await store.load(id)
  if (!loaded.ok) return loaded
  if (loaded.value.status !== 'proposed')
    return err(`Change ${id} is already ${loaded.value.status}.`)
  const rejected: ChangeRequest = {
    ...loaded.value,
    status: 'rejected',
    decision: { at: now().toISOString(), by: userInfo().username, ...(reason ? { reason } : {}) },
  }
  const saved = await store.save(rejected)
  return saved.ok ? ok(rejected) : saved
}
