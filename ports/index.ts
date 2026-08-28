/**
 * ports/ — barrel export for all port interfaces and shared types.
 */

// Shared data types
export type {
  SourceType,
  RiskGroup,
  SelectedAction,
  ExecutionResult,
  RiskEvent,
  Score,
  Decision,
  PolicyCheckRecord,
  ActionExecution,
  OutboxRow,
  AuditLogEntry,
} from "./types.js";

export { VALID_ACTIONS } from "./types.js";

// Port interfaces
export type {
  EventRepository,
  InsertRiskEvent,
  InsertScore,
  InsertDecision,
  InsertPolicyCheck,
  InsertActionExecution,
  InsertOutboxRow,
  InsertAuditLog,
} from "./event_repository.js";

export type {
  PaymentGateway,
  PaymentActionRequest,
  PaymentActionResponse,
} from "./payment_gateway.js";

export type {
  NotificationGateway,
  NotificationChannel,
  NotificationRequest,
  NotificationResponse,
} from "./notification_gateway.js";

export type {
  LlmClient,
  LlmAnalysisRequest,
  LlmAnalysisResponse,
} from "./llm_client.js";

export type {
  EventBus,
  DomainEvent,
  EventHandler,
} from "./event_bus.js";
