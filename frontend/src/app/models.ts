export interface Order { id: string; customerId: string; currency: string; amount: number }
export interface Log { id: number; timestamp: string; stage: string; level: string; message: string; attempt: number }
export interface Execution {
  kind?: string; sourceId?: string | null; sourceVersion?: number | null; sourcePayload?: string | null; scenario?: string; target?: string;
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
// ---- Portfolio lab ----
export interface CrmCustomer { customerId: string; customerName: string; email?: string | null; phone?: string | null; status: string; version: number; updatedAt?: string }
export interface CustomerRevision { id: number; customerId: string; version: number; snapshot: string; changedAt: string }
export interface CrmOrder { id: string; customerId: string; currency: string; amount: number }
export interface ErpCustomer {
  accountCode: string; displayName: string; emailAddress: string; contactNumber?: string | null; accountStatus: string;
  origin: 'Fixture' | 'Import'; sourceSystem?: string; sourceReference?: string; sourceVersion?: number | null;
  createdAt: string; updatedAt: string; lastExecutionId?: string | null; lastSyncedAt?: string | null;
}
export interface ErpHistory {
  id: number; accountCode: string; action: string; executionId?: string | null; sourceVersion?: number | null;
  changedFields: string; before?: string | null; after: string; note?: string | null; actor: string; at: string;
}
export interface ErpOrder {
  externalOrderId: string; receiptId: string; acceptedAt: string; accountCode?: string | null; currencyCode?: string | null;
  totalMinorUnits?: number | null; executionId?: string | null; sourceSystem?: string | null;
}
export interface FieldMapping { sourceField: string; sourceType: string; sourceRequired: boolean; rule: string; description: string; targetField: string; targetType: string; targetRequired: boolean }
export interface MappingSpec { scenario: string; source: string; target: string; fields: FieldMapping[] }
export interface MappingError { field: string; message: string }
export interface PreviewResult { kind: string; input: any; output: any; errors: MappingError[]; valid: boolean; notes: string[] }
