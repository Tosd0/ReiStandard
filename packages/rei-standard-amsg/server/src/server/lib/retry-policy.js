import { DeploymentConfigError, isNonRetryableError, isPermanentDeliveryFailure, isTaskCancelledError, readPushStatusCode } from './errors.js';

/** Number of retries after the first attempt when no policy is configured. */
export const DEFAULT_MAX_DELIVERY_RETRIES = 3;

export function resolveMaxDeliveryRetries(ctx) {
  const value = ctx.maxDeliveryRetries;
  return Number.isInteger(value) && value >= 0 ? value : DEFAULT_MAX_DELIVERY_RETRIES;
}

/** Resolve once per attempt, before any generation hook or model request. */
export function resolveMaxGenerationRetries(ctx, safeTask) {
  let value;
  try {
    value = typeof ctx.maxGenerationRetries === 'function'
      ? ctx.maxGenerationRetries(safeTask)
      : ctx.maxGenerationRetries;
  } catch (cause) {
    throw new DeploymentConfigError('maxGenerationRetries callback failed', { code: 'GENERATION_RETRY_POLICY_INVALID', cause });
  }
  if (value === undefined) return resolveMaxDeliveryRetries(ctx);
  if (!Number.isInteger(value) || value < 0) {
    throw new DeploymentConfigError('maxGenerationRetries must return a non-negative integer or undefined', { code: 'GENERATION_RETRY_POLICY_INVALID' });
  }
  return value;
}

/** Shared by fire receipts and both delivery entry points; never alters errors. */
export function failureRetryDecision(state, error) {
  const retryLimit = state.outboxed ? state.deliveryLimit : state.generationLimit;
  const permanent = isPermanentDeliveryFailure({
    permanent: isNonRetryableError(error), errorCode: error?.code,
    pushStatus: readPushStatusCode(error),
  });
  return {
    failureStage: state.outboxed ? 'delivery' : 'generation',
    retryLimit,
    willRetry: !state.isCancelled?.() && !isTaskCancelledError(error) && !permanent && state.retryCount < retryLimit,
  };
}
