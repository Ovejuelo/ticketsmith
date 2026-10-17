import type { Result } from '../kernel/index.ts'
import type { TemplateTag } from './template-tags.ts'

export type MetabaseError =
  | { readonly kind: 'unauthorized'; readonly message: string }
  | { readonly kind: 'forbidden'; readonly message: string }
  | { readonly kind: 'not-found'; readonly message: string }
  | { readonly kind: 'rejected'; readonly message: string }
  | { readonly kind: 'network'; readonly message: string }
  | { readonly kind: 'invalid-response'; readonly message: string }

export type MetabaseDatabase = {
  readonly id: number
  readonly name: string
  readonly engine: string
}

/** A native (SQL) question to create. */
export type NativeCard = {
  readonly name: string
  readonly description: string
  readonly databaseId: number
  readonly collectionId: number | null
  readonly sql: string
  readonly templateTags: Readonly<Record<string, TemplateTag>>
}

/** The Metabase API Ticketsmith uses. Only `metabase publish` creates cards, after a person agrees. */
export interface MetabaseClient {
  currentUser(): Promise<Result<{ readonly name: string }, MetabaseError>>
  databases(): Promise<Result<readonly MetabaseDatabase[], MetabaseError>>
  createCard(
    card: NativeCard,
  ): Promise<Result<{ readonly id: number; readonly url: string }, MetabaseError>>
}

export const describeMetabaseError = (error: MetabaseError): string => {
  switch (error.kind) {
    case 'unauthorized':
      return `Metabase rejected the API key (${error.message}): create one in Admin → Settings → Authentication → API keys.`
    case 'forbidden':
      return `The API key's group may not do this (${error.message}).`
    case 'not-found':
      return `Not found in Metabase: ${error.message}`
    case 'rejected':
      return `Metabase rejected the request: ${error.message}`
    case 'network':
      return `Metabase is unreachable: ${error.message}`
    case 'invalid-response':
      return `Unexpected answer from Metabase: ${error.message}`
  }
}
