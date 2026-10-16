import { type SecretStoreError, secretEnvVariable } from './secret-store.port.ts'

export const describeSecretError = (error: SecretStoreError): string => {
  switch (error.kind) {
    case 'read-only':
      return `The ${error.source} secret store is read-only.`
    case 'unavailable':
      return `The ${error.source} is not available (${error.message}). You can set ${secretEnvVariable('jira-token')} instead.`
  }
}
