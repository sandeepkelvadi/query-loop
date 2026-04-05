export type PermissionDecision =
  | { allowed: true }
  | { allowed: false; reason: string }

export type PermissionContext = {
  userId?: string
  sessionId?: string
  workingDirectory?: string
}

export type ToolPermission = {
  toolName: string
  allowed: boolean
  reason?: string
}

export type PermissionRule = {
  pattern: RegExp
  allow: boolean
  reason?: string
}

export type PermissionConfig = {
  defaultAllow: boolean
  rules: PermissionRule[]
  perToolOverrides?: Record<string, boolean>
}

export class PermissionSystem {
  private config: PermissionConfig

  constructor(config: Partial<PermissionConfig> = {}) {
    this.config = {
      defaultAllow: config.defaultAllow ?? false,
      rules: config.rules ?? [],
      perToolOverrides: config.perToolOverrides,
    }
  }

  checkPermission(
    toolName: string,
    _input: Record<string, unknown>,
    _context?: PermissionContext
  ): PermissionDecision {
    if (this.config.perToolOverrides?.[toolName] !== undefined) {
      const allowed = this.config.perToolOverrides[toolName]
      return allowed
        ? { allowed: true }
        : { allowed: false, reason: `Tool '${toolName}' is explicitly ${allowed ? 'allowed' : 'denied'}` }
    }

    for (const rule of this.config.rules) {
      if (rule.pattern.test(toolName)) {
        return rule.allow
          ? { allowed: true }
          : { allowed: false, reason: rule.reason ?? `Tool '${toolName}' matched deny rule` }
      }
    }

    return this.config.defaultAllow
      ? { allowed: true }
      : { allowed: false, reason: `Tool '${toolName}' is not allowed by default` }
  }

  setToolOverride(toolName: string, allowed: boolean): void {
    if (!this.config.perToolOverrides) {
      this.config.perToolOverrides = {}
    }
    this.config.perToolOverrides[toolName] = allowed
  }

  removeToolOverride(toolName: string): void {
    delete this.config.perToolOverrides?.[toolName]
  }

  addRule(pattern: string | RegExp, allow: boolean, reason?: string): void {
    const regex = typeof pattern === 'string' ? new RegExp(pattern) : pattern
    this.config.rules.push({ pattern: regex, allow, reason })
  }

  clearRules(): void {
    this.config.rules = []
  }
}

export function createPermissionSystem(config?: Partial<PermissionConfig>): PermissionSystem {
  return new PermissionSystem(config)
}

export const DANGEROUS_TOOLS: PermissionRule[] = [
  { pattern: /^Bash$/, allow: false, reason: 'Bash tool requires explicit permission' },
  { pattern: /^Write$/, allow: false, reason: 'Write tool requires explicit permission' },
  { pattern: /^Delete$/, allow: false, reason: 'Delete tool requires explicit permission' },
]

export const SAFE_TOOLS: PermissionRule[] = [
  { pattern: /^Read$/, allow: true, reason: 'Read is safe' },
  { pattern: /^Glob$/, allow: true, reason: 'Glob is safe' },
  { pattern: /^Grep$/, allow: true, reason: 'Grep is safe' },
  { pattern: /^WebFetch$/, allow: true, reason: 'WebFetch is safe' },
]

export function createSecurePermissionSystem(): PermissionSystem {
  return new PermissionSystem({
    defaultAllow: false,
    rules: [
      ...SAFE_TOOLS,
      ...DANGEROUS_TOOLS,
    ],
  })
}
