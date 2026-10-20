/**
 * 统一错误模型。
 *
 * 设计约束（重构要求）：
 * - 错误必须可编程识别：`code` 是稳定字符串，不依赖 message 文案；
 * - 每个错误携带 `recoverable`，调用方据此决定重试/暂停/失败；
 * - 拒绝类错误必须能区分"策略拒绝"与"程序错误"，避免把安全拒绝当成 bug 重试。
 */

export const ERROR_CODES = {
  CONFIG_INVALID: 'CONFIG_INVALID',
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  STORAGE_ERROR: 'STORAGE_ERROR',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  POLICY_DENIED: 'POLICY_DENIED',
  APPROVAL_REQUIRED: 'APPROVAL_REQUIRED',
  BUDGET_EXCEEDED: 'BUDGET_EXCEEDED',
  NETWORK_DENIED: 'NETWORK_DENIED',
  PATH_DENIED: 'PATH_DENIED',
  SECRET_DETECTED: 'SECRET_DETECTED',
  VERIFICATION_FAILED: 'VERIFICATION_FAILED',
  INVALID_STATE: 'INVALID_STATE',
  TASK_FAILED: 'TASK_FAILED',
  UNSUPPORTED: 'UNSUPPORTED',
  INTERNAL: 'INTERNAL',
} as const

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES]

export interface AutolearnErrorOptions {
  code?: ErrorCode
  recoverable?: boolean
  details?: Record<string, unknown>
  cause?: unknown
}

export class AutolearnError extends Error {
  readonly code: ErrorCode
  readonly recoverable: boolean
  readonly details: Record<string, unknown>

  constructor(message: string, options: AutolearnErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'AutolearnError'
    this.code = options.code ?? ERROR_CODES.INTERNAL
    this.recoverable = options.recoverable ?? false
    this.details = options.details ?? {}
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      recoverable: this.recoverable,
      details: this.details,
    }
  }
}

/** 策略拒绝：安全边界，永远不可通过重试绕过。 */
export class PolicyDeniedError extends AutolearnError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super(message, { code: ERROR_CODES.POLICY_DENIED, recoverable: false, details })
    this.name = 'PolicyDeniedError'
  }
}

export class ValidationError extends AutolearnError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super(message, { code: ERROR_CODES.VALIDATION_FAILED, recoverable: false, details })
    this.name = 'ValidationError'
  }
}

export class NotFoundError extends AutolearnError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super(message, { code: ERROR_CODES.NOT_FOUND, recoverable: false, details })
    this.name = 'NotFoundError'
  }
}

export class BudgetExceededError extends AutolearnError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super(message, { code: ERROR_CODES.BUDGET_EXCEEDED, recoverable: true, details })
    this.name = 'BudgetExceededError'
  }
}

export class StorageError extends AutolearnError {
  constructor(message: string, options: AutolearnErrorOptions = {}) {
    super(message, { code: ERROR_CODES.STORAGE_ERROR, ...options })
    this.name = 'StorageError'
  }
}

export class InvalidStateError extends AutolearnError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super(message, { code: ERROR_CODES.INVALID_STATE, recoverable: false, details })
    this.name = 'InvalidStateError'
  }
}

/** 把任意抛出物转成可序列化结果，供工具层返回。 */
export function describeError(error: unknown): { ok: false; error: { code: string; message: string; recoverable: boolean; details: Record<string, unknown> } } {
  if (error instanceof AutolearnError) {
    return { ok: false, error: { code: error.code, message: error.message, recoverable: error.recoverable, details: error.details } }
  }
  const message = error instanceof Error ? error.message : String(error)
  return { ok: false, error: { code: ERROR_CODES.INTERNAL, message, recoverable: false, details: {} } }
}
