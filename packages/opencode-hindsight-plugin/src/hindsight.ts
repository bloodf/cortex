import deriveBankId from './bank.js';

export interface HindsightPluginEnv {
  baseUrl: string;
  apiKey?: string;
  cwd: string;
}

interface MemoryItem {
  content: string;
  context?: string;
  document_id?: string;
}

interface RecallResult {
  content?: string;
  [key: string]: unknown;
}

export class HindsightClient {
  private baseUrl: string;

  private apiKey?: string;

  readonly bankId: string;

  private bankEnsured = false;

  constructor(env: HindsightPluginEnv) {
    this.baseUrl = env.baseUrl.replace(/\/+$/, '');
    this.apiKey = env.apiKey;
    this.bankId = deriveBankId(env.cwd);
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'content-type': 'application/json' };
    if (this.apiKey) h.authorization = `Bearer ${this.apiKey}`;
    return h;
  }

  private async request<T>(method: string, urlPath: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${urlPath}`, {
      method,
      headers: this.headers(),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Hindsight ${method} ${urlPath} failed: ${res.status}: ${text}`);
    }
    const ct = res.headers.get('content-type') ?? '';
    return ct.includes('application/json') ? (await res.json()) as T : (await res.text()) as unknown as T;
  }

  async ensureBank(): Promise<void> {
    if (this.bankEnsured) return;
    await this.request('PUT', `/v1/default/banks/${this.bankId}`, {});
    this.bankEnsured = true;
  }

  async retain(content: string, context?: string): Promise<void> {
    await this.ensureBank();
    const item: MemoryItem = { content };
    if (context !== undefined) item.context = context;
    await this.request('POST', `/v1/default/banks/${this.bankId}/memories`, {
      async: false,
      items: [item],
    });
  }

  async recall(query: string): Promise<RecallResult[]> {
    await this.ensureBank();
    const response = await this.request<{ results?: RecallResult[] }>(
      'POST',
      `/v1/default/banks/${this.bankId}/memories/recall`,
      { query, budget: 'mid', max_tokens: 4096 },
    );
    return response.results ?? [];
  }
}
