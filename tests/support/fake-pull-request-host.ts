import { err, ok, type Result } from '#src/core/kernel/index.ts'
import type {
  HostType,
  PullRequestError,
  PullRequestHost,
  PullRequestInput,
} from '#src/core/repos/index.ts'

/** Records pull requests instead of calling a host. */
export class FakePullRequestHosts {
  readonly created: { type: string; input: PullRequestInput; token: string }[] = []
  failure: PullRequestError | null = null

  host(type: Exclude<HostType, 'none'>): PullRequestHost {
    return {
      type,
      create: async (input, token): Promise<Result<{ url: string }, PullRequestError>> => {
        if (this.failure !== null) return err(this.failure)
        this.created.push({ type, input, token })
        return ok({
          url: `https://${type}.example/${input.owner}/${input.repo}/pull/${this.created.length}`,
        })
      },
    }
  }
}
