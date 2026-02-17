/**
 * Audit logging service
 * Logs all security-relevant events for monitoring and compliance
 * 
 * Storage:
 * - Console: Always logs to console (stdout) in JSON format
 * - File: Optional file logging with rotation (if AUDIT_LOG_FILE is set)
 * 
 * Retention:
 * - Configurable via AUDIT_LOG_RETENTION_DAYS (default: 90 days)
 * - Old log files are automatically cleaned up
 */

import { appendFile, mkdir, readdir, unlink, stat } from 'fs/promises';
import { join, dirname } from 'path';
import { existsSync } from 'fs';
import { truncatePubkey, sanitizeError, redactSensitiveData } from '../../utils/security.js';
import logger from '../logger.js';

export interface AuditLogEntry {
  timestamp: string;
  user?: string; // pubkey (hex or npub)
  ip?: string;
  action: string;
  resource?: string; // repo path, file path, etc.
  result: 'success' | 'failure' | 'denied';
  error?: string;
  metadata?: Record<string, any>;
}

export class AuditLogger {
  private enabled: boolean;
  private logFile?: string;
  private logDir?: string;
  private retentionDays: number;
  private currentLogFile?: string;
  private logRotationInterval?: NodeJS.Timeout;
  private cleanupInterval?: NodeJS.Timeout;
  private writeQueue: string[] = [];
  private writing = false;

  constructor() {
    this.enabled = process.env.AUDIT_LOGGING_ENABLED !== 'false';
    this.logFile = process.env.AUDIT_LOG_FILE;
    this.retentionDays = parseInt(process.env.AUDIT_LOG_RETENTION_DAYS || '90', 10);
    
    if (this.logFile) {
      this.logDir = dirname(this.logFile);
      this.currentLogFile = this.getCurrentLogFile();
      this.ensureLogDirectory();
      this.startLogRotation();
      this.startCleanup();
    }
  }

  /**
   * Get current log file name with date suffix
   */
  private getCurrentLogFile(): string {
    if (!this.logFile) return '';
    const date = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    const baseName = this.logFile.replace(/\.log$/, '') || 'audit';
    return `${baseName}-${date}.log`;
  }

  /**
   * Ensure log directory exists
   */
  private async ensureLogDirectory(): Promise<void> {
    if (!this.logDir) return;
    try {
      if (!existsSync(this.logDir)) {
        await mkdir(this.logDir, { recursive: true });
      }
    } catch (error) {
      logger.error({ error }, '[AUDIT] Failed to create log directory');
    }
  }

  /**
   * Start log rotation (check daily for new log file)
   */
  private startLogRotation(): void {
    // Check every hour if we need to rotate
    this.logRotationInterval = setInterval(() => {
      const newLogFile = this.getCurrentLogFile();
      if (newLogFile !== this.currentLogFile) {
        this.currentLogFile = newLogFile;
        // Flush any pending writes before rotating
        this.flushQueue();
      }
    }, 60 * 60 * 1000); // 1 hour
  }

  /**
   * Start cleanup of old log files
   */
  private startCleanup(): void {
    // Run cleanup daily
    this.cleanupInterval = setInterval(() => {
      this.cleanupOldLogs().catch(err => {
        logger.error({ error: err }, '[AUDIT] Failed to cleanup old logs');
      });
    }, 24 * 60 * 60 * 1000); // 24 hours
    
    // Run initial cleanup
    this.cleanupOldLogs().catch(err => {
      logger.error({ error: err }, '[AUDIT] Failed to cleanup old logs');
    });
  }

  /**
   * Clean up log files older than retention period
   */
  private async cleanupOldLogs(): Promise<void> {
    if (!this.logDir || !existsSync(this.logDir)) return;

    try {
      const files = await readdir(this.logDir);
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - this.retentionDays);
      const cutoffTime = cutoffDate.getTime();

      for (const file of files) {
        if (!file.endsWith('.log')) continue;
        
        const filePath = join(this.logDir, file);
        try {
          const stats = await stat(filePath);
          if (stats.mtime.getTime() < cutoffTime) {
            await unlink(filePath);
            logger.info({ file }, '[AUDIT] Deleted old log file');
          }
        } catch (err) {
          // Ignore errors for individual files
        }
      }
    } catch (error) {
      logger.error({ error }, '[AUDIT] Error during log cleanup');
    }
  }

  /**
   * Write log entry to file (async, non-blocking)
   */
  private async writeToFile(logLine: string): Promise<void> {
    if (!this.currentLogFile || !this.logDir) return;

    this.writeQueue.push(logLine);
    
    if (this.writing) return; // Already writing, queue will be processed
    
    this.writing = true;
    
    try {
      while (this.writeQueue.length > 0) {
        const batch = this.writeQueue.splice(0, 100); // Process in batches
        const content = batch.join('\n') + '\n';
        await appendFile(join(this.logDir, this.currentLogFile), content, 'utf8');
      }
    } catch (error) {
      logger.error({ error }, '[AUDIT] Failed to write to log file');
      // Put items back in queue (but limit queue size to prevent memory issues)
      this.writeQueue = [...this.writeQueue, ...this.writeQueue].slice(0, 1000);
    } finally {
      this.writing = false;
    }
  }

  /**
   * Flush pending writes
   */
  private async flushQueue(): Promise<void> {
    if (this.writeQueue.length > 0 && !this.writing) {
      await this.writeToFile('');
    }
  }

  /**
   * Log an audit event
   * Automatically truncates pubkeys and redacts sensitive data
   */
  log(entry: Omit<AuditLogEntry, 'timestamp'>): void {
    if (!this.enabled) return;

    // Sanitize entry: truncate pubkeys, redact sensitive data
    const sanitizedEntry: AuditLogEntry = {
      ...entry,
      user: entry.user ? truncatePubkey(entry.user) : undefined,
      error: entry.error ? sanitizeError(entry.error) : undefined,
      metadata: entry.metadata ? redactSensitiveData(entry.metadata) : undefined,
      timestamp: new Date().toISOString()
    };

    // Log using pino (structured JSON)
    const logLine = JSON.stringify(sanitizedEntry);
    logger.info(sanitizedEntry, '[AUDIT]');

    // Write to file if configured (async, non-blocking)
    if (this.logFile) {
      this.writeToFile(logLine).catch(err => {
        logger.error({ error: sanitizeError(err) }, '[AUDIT] Failed to write log entry');
      });
    }
  }

  /**
   * Cleanup on shutdown
   */
  destroy(): void {
    if (this.logRotationInterval) {
      clearInterval(this.logRotationInterval);
    }
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
    this.flushQueue();
  }

  /**
   * Log repository access
   */
  logRepoAccess(
    user: string | null,
    ip: string | null,
    action: 'clone' | 'fetch' | 'push' | 'view' | 'list',
    repo: string,
    result: 'success' | 'failure' | 'denied',
    error?: string
  ): void {
    this.log({
      user: user || undefined,
      ip: ip || undefined,
      action: `repo.${action}`,
      resource: repo,
      result,
      error
    });
  }

  /**
   * Log file operation
   */
  logFileOperation(
    user: string | null,
    ip: string | null,
    action: 'read' | 'write' | 'delete' | 'create',
    repo: string,
    filePath: string,
    result: 'success' | 'failure' | 'denied',
    error?: string
  ): void {
    this.log({
      user: user || undefined,
      ip: ip || undefined,
      action: `file.${action}`,
      resource: `${repo}:${filePath}`,
      result,
      error,
      metadata: { filePath }
    });
  }

  /**
   * Log authentication attempt
   */
  logAuth(
    user: string | null,
    ip: string | null,
    method: 'NIP-07' | 'NIP-98' | 'none',
    result: 'success' | 'failure',
    error?: string
  ): void {
    this.log({
      user: user || undefined,
      ip: ip || undefined,
      action: `auth.${method.toLowerCase()}`,
      result,
      error
    });
  }

  /**
   * Log ownership transfer
   */
  logOwnershipTransfer(
    fromUser: string,
    toUser: string,
    repo: string,
    result: 'success' | 'failure',
    error?: string
  ): void {
    this.log({
      user: fromUser,
      action: 'ownership.transfer',
      resource: repo,
      result,
      error,
      metadata: { toUser }
    });
  }

  /**
   * Log repository creation
   */
  logRepoCreate(
    user: string,
    repo: string,
    result: 'success' | 'failure',
    error?: string
  ): void {
    this.log({
      user,
      action: 'repo.create',
      resource: repo,
      result,
      error
    });
  }

  /**
   * Log repository fork
   */
  logRepoFork(
    user: string,
    originalRepo: string,
    forkRepo: string,
    result: 'success' | 'failure',
    error?: string
  ): void {
    this.log({
      user,
      action: 'repo.fork',
      resource: forkRepo,
      result,
      error,
      metadata: { originalRepo }
    });
  }
}

// Singleton instance
export const auditLogger = new AuditLogger();
