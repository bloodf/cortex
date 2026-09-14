import { deriveBankId } from './workspace.js';

export interface HindsightEnv {
  baseUrl: string;
  apiKey?: string;
  cwd: string;
}

interface HindsightMemoryItem {
  content: string;
  context?: string;
  document_id?: string;
  timestamp?: string;
}

interface HindsightStoreResponse {
  success?: boolean;
  items_count?: number;
  [key: string]: unknown;
}

interface HindsightListItem {
  id?: string;
  content?: string;
  context?: string;
  created_at?: string;
  state?: string;
  [key: string]: unknown;
}

interface HindsightListResponse {
  items?: HindsightListItem[];
  total?: number;
  [key: string]: unknown;
}

interface HindsightRecallResult {
  content?: string;
  id?: string;
  score?: number;
  [key: string]: unknown;
}

interface HindsightRecallResponse {
  results?: HindsightRecallResult[];
  answer?: string;
  [key: string]: unknown;
}

export class HindsightMemoryStore {
  private baseUrl: string;

  private apiKey?: string;

  readonly bankId: string;

  private bankEnsured = false;

  constructor(env: HindsightEnv) {
    this.baseUrl = env.baseUrl.replace(/\/+$/, '');
    this.apiKey = env.apiKey;
    this.bankId = deriveBankId(env.cwd);
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'content-type': 'application/json' };
    if (this.apiKey) h.authorization = `Bearer ${this.apiKey}`;
    return h;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: this.headers(),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(
        `Hindsight ${method} ${path} failed: ${res.status} ${res.statusText}: ${text}`,
      );
    }
    const ct = res.headers.get('content-type') ?? '';
    if (ct.includes('application/json')) {
      return (await res.json()) as T;
    }
    return (await res.text()) as unknown as T;
  }

  async ensureBank(): Promise<void> {
    if (this.bankEnsured) return;
    await this.request('PUT', `/v1/default/banks/${this.bankId}`, {});
    this.bankEnsured = true;
  }

  async store(content: string, context?: string): Promise<HindsightStoreResponse> {
    await this.ensureBank();
    const item: HindsightMemoryItem = { content };
    if (context !== undefined) item.context = context;
    return this.request<HindsightStoreResponse>(
      'POST',
      `/v1/default/banks/${this.bankId}/memories`,
      { async: false, items: [item] },
    );
  }

  async recall(
    query: string,
    _topK?: number,
  ): Promise<HindsightRecallResponse> {
    await this.ensureBank();
    return this.request<HindsightRecallResponse>(
      'POST',
      `/v1/default/banks/${this.bankId}/memories/recall`,
      { query, budget: 'mid', max_tokens: 4096 },
    );
  }

  async reflect(query: string): Promise<HindsightRecallResponse> {
    await this.ensureBank();
    return this.request<HindsightRecallResponse>(
      'POST',
      `/v1/default/banks/${this.bankId}/reflect`,
      { query },
    );
  }

  async list(limit = 50, offset = 0): Promise<HindsightListResponse> {
    await this.ensureBank();
    return this.request<HindsightListResponse>(
      'GET',
      `/v1/default/banks/${this.bankId}/memories/list?limit=${limit}&offset=${offset}`,
    );
  }

  async forget(memoryId: string): Promise<void> {
    await this.request(
      'PATCH',
      `/v1/default/banks/${this.bankId}/memories/${memoryId}`,
      { state: 'invalidated' },
    );
  }
}
