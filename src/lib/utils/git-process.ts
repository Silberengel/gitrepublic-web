/**
 * Utility functions for safely spawning git processes
 * Prevents zombie processes by ensuring proper cleanup
 */

import { spawn, type ChildProcess } from 'child_process';
import logger from '../services/logger.js';
import { killProcessGroup, forceKillProcessGroup, cleanupProcess, closeProcessStreams } from './process-cleanup.js';

export interface GitProcessOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  stdio?: ('ignore' | 'pipe')[];
}

export interface GitProcessResult {
  stdout: string;
  stderr: string;
  code: number | null;
  signal: NodeJS.Signals | null;
}

/**
 * Safely spawn a git process with proper cleanup to prevent zombies
 * 
 * @param args - Git command arguments
 * @param options - Process options
 * @returns Promise that resolves with process output
 */
export function spawnGitProcess(
  args: string[],
  options: GitProcessOptions = {}
): Promise<GitProcessResult> {
  const {
    cwd,
    env = {},
    timeoutMs = 30 * 60 * 1000, // 30 minutes default
    stdio = ['ignore', 'pipe', 'pipe']
  } = options;

  return new Promise((resolve, reject) => {
    const gitProcess = spawn('git', args, {
      cwd,
      env: Object.keys(env).length > 0 ? env : undefined,
      stdio,
      detached: false // Keep in same process group to prevent zombies
    });

    let stdout = '';
    let stderr = '';
    let resolved = false;

    // Set timeout to prevent hanging processes with aggressive cleanup
    let forceKillTimeout: NodeJS.Timeout | null = null;
    const timeoutId = timeoutMs > 0 ? setTimeout(() => {
      if (!resolved && !gitProcess.killed) {
        resolved = true;
        logger.warn({ args, timeoutMs }, 'Git process timeout, killing process group');
        
        // Kill entire process group to prevent zombies
        killProcessGroup(gitProcess, 'SIGTERM');
        
        // Force kill after grace period
        forceKillTimeout = forceKillProcessGroup(gitProcess, 5000);
        
        // Ensure streams are closed
        closeProcessStreams(gitProcess);
        
        reject(new Error(`Git command timeout after ${timeoutMs}ms: ${args.join(' ')}`));
      }
    }, timeoutMs) : null;

    // Collect stdout
    if (gitProcess.stdout) {
      gitProcess.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
      });
    }

    // Collect stderr
    if (gitProcess.stderr) {
      gitProcess.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });
    }

    // Handle process close (main cleanup point)
    gitProcess.on('close', (code, signal) => {
      // Aggressive cleanup: clear timeouts and ensure streams are closed
      cleanupProcess(gitProcess, [timeoutId, forceKillTimeout]);
      
      if (resolved) return;
      resolved = true;
      
      resolve({
        stdout,
        stderr,
        code,
        signal
      });
    });

    // Handle process errors with aggressive cleanup
    gitProcess.on('error', (err) => {
      // Aggressive cleanup on error
      cleanupProcess(gitProcess, [timeoutId, forceKillTimeout], 'SIGTERM');
      
      if (resolved) return;
      resolved = true;
      
      logger.error({ err, args }, 'Git process error');
      reject(err);
    });

    // Handle process exit (backup cleanup)
    gitProcess.on('exit', (code, signal) => {
      // This is primarily handled by 'close' event
      // But we ensure we catch all cases
      if (!resolved && code !== null && code !== 0) {
        if (timeoutId) clearTimeout(timeoutId);
        resolved = true;
        
        const errorMsg = signal 
          ? `Git command terminated by signal ${signal}: ${stderr || stdout}`
          : `Git command failed with code ${code}: ${stderr || stdout}`;
        
        reject(new Error(errorMsg));
      }
    });
  });
}

/**
 * Safely spawn a git process and throw on non-zero exit code
 * 
 * @param args - Git command arguments
 * @param options - Process options
 * @returns Promise that resolves with stdout/stderr only on success
 */
export async function execGitProcess(
  args: string[],
  options: GitProcessOptions = {}
): Promise<{ stdout: string; stderr: string }> {
  const result = await spawnGitProcess(args, options);
  
  if (result.code !== 0) {
    const errorMsg = result.signal 
      ? `Git command terminated by signal ${result.signal}: ${result.stderr || result.stdout}`
      : `Git command failed with code ${result.code}: ${result.stderr || result.stdout}`;
    throw new Error(errorMsg);
  }
  
  return {
    stdout: result.stdout,
    stderr: result.stderr
  };
}
