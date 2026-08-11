/**
 * Compatibility facade for FleetMind's versioned delegation contracts.
 *
 * New code may import these values and types directly from
 * @continuous-agentics/delegation-core.
 */
export {
  DEFAULT_S3_KEY_TEMPLATE,
  DeliveryContextSchema,
  LifecycleSchema,
  TaskEventSchema,
  TaskStatusSchema,
  TaskRecordSchema,
  allTaskEventsSubject,
  delegationSubject,
  gsi1pk,
  gsi2pk,
  renderS3Key,
  taskPK,
  taskSubject,
  type CreateTaskInput,
  type DeliveryContext,
  type Lifecycle,
  type S3KeyContext,
  type TaskEvent,
  type TaskEventType,
  type TaskRecord,
  type TaskStatus,
  type TaskSummary,
} from "@continuous-agentics/delegation-core";
