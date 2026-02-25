# Working with GRASP Servers

GitRepublic provides minimal GRASP (Git Repository Announcement and Synchronization Protocol) interoperability for seamless compatibility with GRASP servers.

## What is GRASP?

GRASP is a protocol specification for decentralized git hosting that combines git smart HTTP with Nostr relays. GRASP servers provide git repository hosting with Nostr-based announcements and state management.

## GitRepublic GRASP Support

### What We Support

1. **GRASP Server Detection**
   - Automatically identifies GRASP servers from repository announcements
   - Uses GRASP-01 identification (clone URL pattern + matching `relays` tag)
   - Displays GRASP server status in clone URL reachability

2. **Clone URL Reachability**
   - Tests and displays reachability status for all clone URLs
   - Shows which remotes (including GRASP servers) are accessible
   - Indicates server type (Git, GRASP)

3. **Multi-Remote Synchronization**
   - When you push, automatically syncs to all remotes listed in announcement
   - Includes GRASP servers in sync operations
   - Handles sync failures gracefully

4. **Local Pull Command**
   - Use `gitrep pull-all --merge` to fetch and merge from all remotes
   - Checks reachability first, only pulls from accessible remotes
   - Detects conflicts before merging (aborts unless `--allow-conflicts`)
   - Works with GRASP servers seamlessly

5. **Standard Git Operations**
   - Full compatibility with GRASP servers for clone, push, pull
   - Uses standard git smart HTTP protocol
   - No special configuration needed

### What We Don't Support (By Design)

- **Full GRASP-01 server compliance**: We're not a full GRASP server
- **GRASP-02 proactive sync**: No server-side hourly pulls (user-controlled via CLI)
- **GRASP-05 archive mode**: Not implemented

## Using GRASP Servers

### Cloning from GRASP Servers

```bash
# Clone from a GRASP server (works just like any git server)
gitrep clone https://grasp.example.com/npub1.../repo.git
```

### Pushing to Multiple Remotes

When your repository has both GitRepublic and GRASP servers in clone URLs:

```bash
# Push to your repo (automatically syncs to all remotes including GRASP)
gitrep push origin main
```

GitRepublic will:
1. Push to the primary server
2. Automatically sync to all other remotes (including GRASP servers)
3. Handle sync failures gracefully

### Pulling from Multiple Remotes

```bash
# Pull from all remotes including GRASP servers
gitrep pull-all --merge
```

This command:
- Checks reachability of all remotes
- Fetches from accessible remotes
- Merges changes into your current branch
- Detects conflicts before merging

### Clone URL Reachability

View which remotes (including GRASP servers) are accessible:

- **Web Interface**: Repository page shows reachability status
- **API**: `GET /api/repos/{npub}/{repo}/clone-urls/reachability`
- **CLI**: `gitrep repos get <npub> <repo>` shows reachability

## GRASP Server Identification

GRASP servers are identified by:
- Clone URL pattern matching GRASP conventions
- Matching `relays` tag in repository announcement
- Server response indicating GRASP support

GitRepublic automatically detects GRASP servers and displays them appropriately.

## Best Practices

1. **Add GRASP servers to clone URLs**: Include GRASP server URLs in your repository announcement
2. **Test reachability**: Check that all remotes (including GRASP) are reachable
3. **Use pull-all**: Regularly pull from all remotes to stay in sync
4. **Handle conflicts**: Use `--allow-conflicts` if you need to proceed despite conflicts

## Next Steps

- [REST API and CLI](./api-and-cli.md) - Multi-remote operations
- [Specs used](./specs.md) - GRASP documentation links
