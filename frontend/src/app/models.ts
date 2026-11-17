export interface Order { id: string; customerId: string; currency: string; amount: number }
export interface Log { id: number; timestamp: string; stage: string; level: string; message: string; attempt: number }
export interface Execution {
  id: string; orderId: string; status: string; environment: string; attempts: number;
  createdAt: string; startedAt?: string; endedAt?: string; durationMs?: number;
  errorClass?: string; troubleshooting?: string; receiptId?: string; mappedPayload?: string;
  retryCount: number; logs: Log[];
}
export interface Metrics {
  total: number; completed: number; failed: number; successRate: number; averageDurationMs: number;
  statuses: { status: string; count: number }[];
}
export interface Job { id: string; name: string; environment: string; status: string; startedAt: string; endedAt: string; details: string }
export interface ExecutionPage { items: Execution[]; total: number; page: number; pageSize: number }
