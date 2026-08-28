/**
 * adapters/mock/ — barrel export for all mock adapters.
 *
 * Every port has a corresponding in-memory mock with:
 *   - Full port interface compliance
 *   - Configurable failure injection via forceFailureFor(eventId, times)
 *   - Call logging for test assertions
 *   - reset() to clear all state between tests
 */

export { MockEventRepository } from "./mock_event_repository.js";
export { MockPaymentGateway } from "./mock_payment_gateway.js";
export { MockNotificationGateway } from "./mock_notification_gateway.js";
export { MockLlmClient } from "./mock_llm_client.js";
export { MockEventBus } from "./mock_event_bus.js";
