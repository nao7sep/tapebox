/** The environment variable that overrides a stored API key (api-key-storage-
 * conventions), named from the key id: `openai` → `OPENAI_API_KEY`. Settings shows
 * the same name in its hint, so both read it here. */
export function apiKeyEnvVar(id: string): string {
  return `${id.toUpperCase().replaceAll('.', '_')}_API_KEY`
}
