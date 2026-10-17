export { describeSecretError } from './describe-error.ts'
export { type FoundSecret, firstAvailable } from './first-available.ts'
export {
  ANTHROPIC_API_KEY,
  databaseSecret,
  gitHostSecret,
  type SecretKey,
  type SecretName,
  type SecretStore,
  type SecretStoreError,
  secretEnvVariable,
} from './secret-store.port.ts'
