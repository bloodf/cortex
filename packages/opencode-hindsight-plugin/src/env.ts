/** Centralised environment-variable access for the OpenCode Hindsight plugin. */
export function getHindsightApiUrl(): string {
  return (process.env['HINDSIGHT_API_URL'] ?? 'http://127.0.0.1:8888').replace(/\/+$/, '');
}

export function getHindsightApiKey(): string | undefined {
  return process.env['HINDSIGHT_API_KEY'];
}

export function getHindsightCwd(): string {
  return process.env['CORTEX_HINDSIGHT_CWD'] ?? process.cwd();
}
