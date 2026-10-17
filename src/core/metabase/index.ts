/** Where `process` writes a report query, in the ticket's output folder. */
export const REPORT_FILE = 'report.sql'

export {
  describeMetabaseError,
  type MetabaseClient,
  type MetabaseDatabase,
  type MetabaseError,
  type NativeCard,
} from './metabase-client.port.ts'
export { type TemplateTag, type TemplateTagType, tagType, templateTags } from './template-tags.ts'
