/**
 * Utility functions for safely spawning git processes
 * Prevents zombie processes by ensuring proper cleanup
 */

import { spawn, type ChildProcess } from 'child_process';
import logger from '../services/logger.js';

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

    // Set timeout to prevent hanging processes
    const timeoutId = timeoutMs > 0 ? setTimeout(() => {
      if (!resolved && !gitProcess.killed) {
        resolved = true;
        logger.warn({ args, timeoutMs }, 'Git process timeout, killing process');
        
        // Kill the process tree to prevent zombies
        try {
          gitProcess.kill('SIGTERM');
          // Force kill after grace period
          const forceKillTimeout = setTimeout(() => {
            if (gitProcess.pid && !gitProcess.killed) {
              try {
                gitProcess.kill('SIGKILL');
              } catch (err) {
                logger.warn({ err, pid: gitProcess.pid }, 'Failed to force kill git process');
              }
            }
          }, 5000);
          
          // Clear force kill timeout if process terminates
          gitProcess.once('close', () => {
            clearTimeout(forceKillTimeout);
          });
        } catch (err) {
          logger.warn({ err }, 'Error killing timed out git process');
        }
        
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
      if (timeoutId) clearTimeout(timeoutId);
      
      if (resolved) return;
      resolved = true;
      
      // Ensure process is fully cleaned up
      if (gitProcess.pid) {
        try {
          // Check if process still exists (this helps ensure cleanup)
          process.kill(gitProcess.pid, 0);
        } catch {
          // Process already dead, that's fine
        }
      }
      
      resolve({
        stdout,
        stderr,
        code,
        signal
      });
    });

    // Handle process errors
    gitProcess.on('error', (err) => {
      if (timeoutId) clearTimeout(timeoutId);
      
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
