# Server Maintenance Commands

## 1. Investigate Zombie Processes (CRITICAL - 3300 zombies)

```bash
# Find processes with zombie children
ps aux | awk '$8 ~ /^Z/ { print $2, $11 }' | head -20

# Find parent processes that are creating zombies
ps aux | awk '$8 ~ /^Z/ { print $3 }' | sort | uniq -c | sort -rn | head -10

# Check for specific problematic processes
ps auxf | grep -E 'Z|defunct'

# Check systemd services that might be spawning zombies
systemctl status | grep -i failed
systemctl list-units --type=service --state=failed
```

## 2. Identify the Root Cause (Git Processes Detected)

Based on initial investigation, zombies are `[git]` processes. Run these commands:

```bash
# Check all git processes (including zombies)
ps aux | grep -E 'git|\[git\]' | head -30

# Find what's spawning git processes
ps auxf | grep -B 5 -A 5 git | head -50

# Check for web server processes that might spawn git
ps aux | grep -E 'node|nginx|apache|php-fpm|plesk' | head -20

# Check system logs for git-related errors
journalctl -p err -n 100 | grep -i git
journalctl -u nginx -n 50
journalctl -u apache2 -n 50

# Check for processes with many children (potential zombie creators)
ps aux --sort=-%cpu | head -20
ps aux --sort=-%mem | head -20

# Monitor zombie creation in real-time (run for 30 seconds)
watch -n 1 'ps aux | awk '\''$8 ~ /^Z/ { count++ } END { print "Zombies:", count+0 }'\'''

# Check if it's a GitRepublic application issue
ps aux | grep -E 'node.*gitrepublic|gitrepublic.*node'
systemctl status | grep -i gitrepublic
```

## 3. Apply Security Updates

```bash
# Update package lists
apt update

# See what security updates are available
apt list --upgradable | grep -i security

# Apply security updates
apt upgrade -y

# Or apply all updates (after investigating zombies)
apt upgrade
```

## 4. System Health Check

```bash
# Check disk space
df -h

# Check memory usage
free -h

# Check system load
uptime
top -bn1 | head -20

# Check for failed services
systemctl list-units --type=service --state=failed

# Check system logs
journalctl -p err -n 50
```

## 5. Plan System Restart

```bash
# Check what requires restart
cat /var/run/reboot-required.pkgs 2>/dev/null || echo "No reboot required file found"

# Schedule maintenance window and restart
# (Only after fixing zombie issue)
# reboot
```

## 6. Plesk-Specific Checks

```bash
# Check Plesk services
plesk repair all -y

# Check Plesk logs
tail -100 /var/log/plesk/panel.log

# Check for Plesk-related zombie processes
ps aux | grep -i plesk | grep -i defunct
```

## Root Cause Identified ✅

**Problem**: Node.js GitRepublic process (PID 330225, `node build`) is spawning git processes that aren't being properly reaped, creating zombies.

**Evidence**:
- All zombie processes are `[git] <defunct>` children of the Node.js process
- Active git process: `git remote set-head remote-0 -a` (from `git-remote-sync.ts`)
- Git spawns subprocesses like `git-remote-https` that can become zombies if not properly waited for

**Code Fix**: Updated `src/lib/services/git/git-remote-sync.ts` to:
- Add timeout handling (30 minutes)
- Properly clean up processes on exit
- Handle signals correctly
- Prevent zombie processes

## Immediate Server Fix

**Option 1: Restart the GitRepublic service (RECOMMENDED)**
```bash
# Find the service/container
docker ps | grep gitrepublic
# or
systemctl list-units | grep -i gitrepublic

# Restart it (this will clean up zombies temporarily)
docker restart <container-id>
# or
systemctl restart <service-name>
```

**Option 2: Kill and let it restart (if managed by systemd/docker)**
```bash
# Find the process
ps aux | grep "node build" | grep -v grep

# Kill it (systemd/docker will restart it)
kill -TERM 330225

# Wait a moment, then check if it restarted
ps aux | grep "node build" | grep -v grep
```

**Option 3: Clean up zombies manually (temporary fix)**
```bash
# This won't fix the root cause but will clean up existing zombies
# The zombies will come back until the code is fixed
# Note: You can't kill zombies directly, but killing the parent will clean them up
```

## Recommended Action Plan

1. **IMMEDIATE**: Restart GitRepublic service to clean up existing zombies
2. **URGENT**: Deploy the code fix (updated `git-remote-sync.ts`)
3. **HIGH PRIORITY**: Apply security updates (section 3)
4. **MONITOR**: Watch for zombie process count after restart
5. **MAINTENANCE WINDOW**: Schedule system restart after deploying fix

## Common Causes of Zombie Processes

- Process spawning children without proper signal handling
- Systemd service not properly configured
- Application bugs (especially Node.js, Python, or long-running processes)
- Resource exhaustion causing process management issues
- Plesk or web server processes not reaping children

## Git-Specific Zombie Issues

Since zombies are `[git]` processes, likely causes:
- **Git operations not being properly waited for** - parent process exits before git finishes
- **Git HTTP backend issues** - web server spawning git processes that aren't reaped
- **GitRepublic application** - Node.js app spawning git commands without proper signal handling
- **Plesk Git integration** - Plesk's git features not properly managing child processes
- **Git hooks** - hooks spawning processes that become zombies

### Quick Fixes to Try

```bash
# Restart web server (if using nginx/apache)
systemctl restart nginx
# or
systemctl restart apache2

# Restart GitRepublic application (if running as service)
systemctl restart gitrepublic-web
# or find and restart the Node.js process
ps aux | grep node | grep gitrepublic
# Then restart it

# Check git-http-backend processes
ps aux | grep git-http-backend

# Kill any stuck git processes (CAREFUL - only if safe)
# pkill -9 git  # Only if you're sure no important operations are running
```
