/**
 * Rate limiting service
 * Prevents abuse by limiting requests per user/IP
 */

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

export class RateLimiter {
  private enabled: boolean;
  private windowMs: number;
  private limits: Map<string, Map<string, RateLimitEntry>>; // type -> identifier -> entry
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor() {
    this.enabled = process.env.RATE_LIMIT_ENABLED !== 'false';
    this.windowMs = parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000', 10); // 1 minute default
    this.limits = new Map();

    // Cleanup old entries every 5 minutes
    if (this.enabled) {
      this.cleanupInterval = setInterval(() => this.cleanup(), 5 * 60 * 1000);
    }
  }

  /**
   * Check if a request should be rate limited
   * @param type - Type of operation (e.g., 'git', 'api', 'file')
   * @param identifier - User pubkey or IP address
   * @param maxRequests - Maximum requests allowed in the window
   * @returns true if allowed, false if rate limited
   */
  checkLimit(type: string, identifier: string, maxRequests: number): { allowed: boolean; remaining: number; resetAt: number } {
    if (!this.enabled) {
      return { allowed: true, remaining: Infinity, resetAt: Date.now() + this.windowMs };
    }

    const now = Date.now();
    const key = `${type}:${identifier}`;

    if (!this.limits.has(type)) {
      this.limits.set(type, new Map());
    }

    const typeLimits = this.limits.get(type)!;
    const entry = typeLimits.get(identifier);

    if (!entry || entry.resetAt < now) {
      // Create new entry or reset expired entry
      typeLimits.set(identifier, {
        count: 1,
        resetAt: now + this.windowMs
      });
      return { allowed: true, remaining: maxRequests - 1, resetAt: now + this.windowMs };
    }

    if (entry.count >= maxRequests) {
      return { allowed: false, remaining: 0, resetAt: entry.resetAt };
    }

    entry.count++;
    return { allowed: true, remaining: maxRequests - entry.count, resetAt: entry.resetAt };
  }

  /**
   * Get rate limit configuration for operation type
   */
  private getLimitForType(type: string): number {
    const envKey = `RATE_LIMIT_${type.toUpperCase()}_MAX`;
    const defaultLimits: Record<string, number> = {
      git: 60,      // Git operations: 60/min
      api: 120,     // API requests: 120/min
      file: 30,     // File operations: 30/min
      search: 20    // Search requests: 20/min
    };

    const envValue = process.env[envKey];
    if (envValue) {
      return parseInt(envValue, 10);
    }

    return defaultLimits[type] || 60;
  }

  /**
   * Check rate limit for a specific operation type
   */
  check(type: string, identifier: string): { allowed: boolean; remaining: number; resetAt: number } {
    const maxRequests = this.getLimitForType(type);
    return this.checkLimit(type, identifier, maxRequests);
  }

  /**
   * Clean up expired entries
   */
  private cleanup(): void {
    const now = Date.now();
    for (const [type, typeLimits] of this.limits.entries()) {
      for (const [identifier, entry] of typeLimits.entries()) {
        if (entry.resetAt < now) {
          typeLimits.delete(identifier);
        }
      }
      if (typeLimits.size === 0) {
        this.limits.delete(type);
      }
    }
  }

  /**
   * Cleanup on shutdown
   */
  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    this.limits.clear();
  }
}

// Singleton instance
export const rateLimiter = new RateLimiter();
