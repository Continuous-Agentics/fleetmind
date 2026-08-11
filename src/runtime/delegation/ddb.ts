/**
 * Compatibility facade for FleetMind's delegation ledger.
 *
 * The implementation lives in @continuous-agentics/delegation-core so the
 * fleet operator and OpenClaw plugin share one versioned lifecycle runtime.
 */
export {
  TaskConditionError,
  TaskLedger,
  type DelegationDDBConfig,
} from "@continuous-agentics/delegation-core";
