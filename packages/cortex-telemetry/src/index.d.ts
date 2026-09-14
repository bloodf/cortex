export interface InstrumentOptions {
  service: string;
  env?: string;
}

export interface InstrumentResult {
  enabled: boolean;
  service: string;
  env?: string;
}

export interface TraceOptions {
  name: string;
  model?: string;
  input?: unknown;
  metadata?: Record<string, unknown>;
}

export function instrument(options: InstrumentOptions): InstrumentResult;
export function traceLLMCall<T>(options: TraceOptions, handler: () => Promise<T>): Promise<T>;
export function shutdown(): Promise<void>;
