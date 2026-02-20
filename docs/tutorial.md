# GitRepublic Tutorial & Walkthrough

Welcome to GitRepublic! This comprehensive guide will walk you through everything you need to know to get started with decentralized git hosting on Nostr.

## Table of Contents

1. [What is GitRepublic?](#what-is-gitrepublic)
2. [Getting Started](#getting-started)
3. [Creating Your First Repository](#creating-your-first-repository)
4. [Cloning Repositories](#cloning-repositories)
5. [Making Changes and Pushing](#making-changes-and-pushing)
6. [Pull Requests](#pull-requests)
7. [Issues](#issues)
8. [Forking Repositories](#forking-repositories)
9. [Updating Repository Information](#updating-repository-information)
10. [Collaboration Features](#collaboration-features)
11. [Best Practices](#best-practices)
12. [Troubleshooting](#troubleshooting)

---

## What is GitRepublic?

GitRepublic is a decentralized git hosting platform built on Nostr. Unlike traditional git hosting services, GitRepublic:

- **No central authority**: Your repositories are announced on Nostr relays, making them truly decentralized
- **Nostr-based authentication**: Uses NIP-07 (browser extensions) and NIP-98 (HTTP authentication) for secure access
- **Full control**: You own your repositories and can transfer ownership, manage maintainers, and control access
- **Open collaboration**: Create pull requests, issues, and collaborate with others using Nostr events

### Key Concepts

- **NIP-34**: The Nostr Improvement Proposal that defines how repositories are announced and managed
- **NIP-07**: Browser extension authentication (like Alby or nos2x)
- **NIP-98**: HTTP authentication for git operations (clone, push, pull)
- **Repository Announcements**: Nostr events (kind 30617) that announce your repository to the network
- **Ownership Transfer**: Chain of ownership events (kind 1641) that prove repository ownership

---

## Getting Started

### Prerequisites

Before you begin, you'll need:

1. **A Nostr key pair**: You can generate one using a NIP-07 browser extension
2. **NIP-07 Extension**: Install [Alby](https://getalby.com/) or [nos2x](https://github.com/fiatjaf/nos2x) in your browser
3. **Git installed**: Make sure you have git installed on your system
4. **Access to GitRepublic**: Visit the GitRepublic instance you want to use

### Step 1: Install NIP-07 Extension

1. Install a Nostr browser extension:
   - **Alby**: [getalby.com](https://getalby.com/)
   - **nos2x**: Available for Chrome/Firefox
   
2. Create or import your Nostr key pair in the extension

3. Make sure the extension is active and unlocked

### Step 2: Connect to GitRepublic

1. Visit the GitRepublic homepage
2. Click the **Login** button in the top right
3. Approve the connection request in your NIP-07 extension
4. You should now see your user badge in the header

---

## Creating Your First Repository

### Using the Web Interface

1. **Navigate to Sign Up**: Click "Sign Up" in the navigation menu

2. **Fill in Repository Details**:
   - **Repository Name**: Choose a unique name (e.g., `my-awesome-project`)
   - **Description**: Add a description of what your repository does
   - **Clone URLs** (optional): If you're migrating from another git host, add the clone URLs here
   - **Private** (optional): Check this if you want a private repository

3. **Create Repository**: Click the create button

4. **What Happens Next**:
   - GitRepublic creates a Nostr event announcing your repository
   - A bare git repository is automatically provisioned
   - You'll be redirected to your new repository page

### Repository URL Structure

Your repository will be accessible at:
```
https://{domain}/repos/{your-npub}/{repository-name}
```

For git operations, you can use any of these paths:
```
https://{domain}/api/git/{your-npub}/{repository-name}.git  # Recommended
https://{domain}/repos/{your-npub}/{repository-name}.git
https://{domain}/{your-npub}/{repository-name}.git
```

**Note**: The `/api/git/` path is recommended for best compatibility with commit signing hooks.

### Initial Setup

After creating your repository, you can:

1. **Clone it locally**:
   ```bash
   git clone https://{domain}/api/git/{your-npub}/{repository-name}.git
   cd {repository-name}
   ```

2. **Add your first files**:
   ```bash
   echo "# My Awesome Project" > README.md
   git add README.md
   git commit -m "Initial commit"
   git push origin main
   ```

---

## Cloning Repositories

### Public Repositories

Anyone can clone public repositories without authentication:

```bash
git clone https://{domain}/api/git/{owner-npub}/{repository-name}.git
cd {repository-name}
```

### Private Repositories

Private repositories require authentication. You'll need to set up NIP-98 authentication.

#### Setting Up NIP-98 Authentication

For command-line git operations, you need to install the [GitRepublic CLI](https://github.com/your-org/gitrepublic-cli) which provides:

1. **Credential Helper**: Automatically generates NIP-98 authentication tokens for git operations
2. **Commit Signing Hook**: Automatically signs commits for GitRepublic repositories

**Quick Setup**:

1. Install the CLI:
   ```bash
   npm install -g gitrepublic-cli
   ```

2. Set your Nostr private key:
   ```bash
   export NOSTRGIT_SECRET_KEY="nsec1..."
   ```

3. Run the setup script:
   ```bash
   gitrepublic-setup
   ```

This automatically configures the credential helper and commit signing hook. See the README for complete setup instructions.

3. **Clone the private repository**:
   ```bash
   git clone https://{domain}/api/git/{owner-npub}/{repository-name}.git
   ```

   When prompted, the credential helper will automatically generate and use a NIP-98 authentication token.

**Note**: For command-line git operations, you'll need to install the [GitRepublic CLI](https://github.com/your-org/gitrepublic-cli) and set up the credential helper. See the README for complete setup instructions.

### Cloning from Multiple Remotes

If a repository has multiple clone URLs configured, GitRepublic will automatically sync changes to all remotes when you push. You can see all clone URLs on the repository page.

---

## Making Changes and Pushing

### Basic Workflow

1. **Make changes to your files**:
   ```bash
   echo "New feature" >> README.md
   ```

2. **Stage your changes**:
   ```bash
   git add README.md
   ```

3. **Commit your changes**:
   ```bash
   git commit -m "Add new feature"
   ```

4. **Push to GitRepublic**:
   ```bash
   git push origin main
   ```

### Authentication for Push

When you push, GitRepublic will:

1. Verify your NIP-98 authentication token
2. Check that you're the repository owner or a maintainer
3. Verify the repository size limit (2 GB maximum)
4. Process your push
5. Automatically sync to other remotes (if configured)

### Branch Management

#### Creating a New Branch

```bash
git checkout -b feature/new-feature
# Make changes
git add .
git commit -m "Add new feature"
git push origin feature/new-feature
```

#### Viewing Branches

You can view all branches:
- On the repository web page
- Using the API: `GET /api/repos/{npub}/{repo}/branches`

#### Creating Branches via Web UI

1. Navigate to your repository
2. Click "Create Branch"
3. Enter branch name and select the source branch
4. Click "Create"

### Tags

#### Creating a Tag

```bash
git tag -a v1.0.0 -m "Release version 1.0.0"
git push origin v1.0.0
```

#### Creating Tags via Web UI

1. Navigate to your repository
2. Click "Create Tag"
3. Enter tag name, select commit, and add a message
4. Click "Create"

---

## Pull Requests

Pull requests (PRs) allow you to propose changes to a repository. They're created as Nostr events (kind 1618) and can be reviewed, commented on, and merged.

### Creating a Pull Request

#### Method 1: Via Web Interface

1. **Fork the repository** (if you don't have write access)
2. **Make your changes** in your fork
3. **Push your changes** to a branch
4. **Navigate to the original repository**
5. **Click "Create Pull Request"**
6. **Fill in the details**:
   - Source repository and branch
   - Target repository and branch
   - Title and description
7. **Submit the PR**

#### Method 2: Using Git and Nostr

1. **Fork and clone the repository**:
   ```bash
   git clone https://{domain}/api/git/{owner-npub}/{repo}.git
   cd {repo}
   ```

2. **Create a feature branch**:
   ```bash
   git checkout -b feature/my-feature
   ```

3. **Make your changes and push**:
   ```bash
   # Make changes
   git add .
   git commit -m "Add new feature"
   git push origin feature/my-feature
   ```

4. **Create a PR event** using a Nostr client or the web interface

### Reviewing Pull Requests

1. **Navigate to the repository**
2. **Click on "Pull Requests"**
3. **Select a PR to review**
4. **Review the changes** in the diff view
5. **Add comments** on specific lines or sections
6. **Approve or request changes**

### PR Status

Pull requests can have the following statuses:

- **Open**: The PR is active and ready for review
- **Applied/Merged**: The PR has been merged into the target branch
- **Closed**: The PR was closed without merging
- **Draft**: The PR is still a work in progress

### Merging Pull Requests

Only repository owners and maintainers can merge PRs:

1. **Review the PR** and ensure all checks pass
2. **Click "Merge"** or change the status to "Applied"
3. **The changes will be merged** into the target branch

---

## Issues

Issues (kind 1621) allow you to track bugs, feature requests, and other tasks related to your repository.

### Creating an Issue

1. **Navigate to your repository**
2. **Click "Issues"** in the repository menu
3. **Click "Create Issue"**
4. **Fill in the details**:
   - Title
   - Description
   - Labels (optional)
5. **Submit the issue**

### Issue Status

Issues can have the following statuses:

- **Open**: The issue is active and needs attention
- **Resolved**: The issue has been fixed or addressed
- **Closed**: The issue was closed (e.g., duplicate, won't fix)
- **Draft**: The issue is still being written

### Managing Issues

- **Assign issues** to maintainers
- **Add comments** to discuss solutions
- **Link issues to PRs** by referencing them in PR descriptions
- **Close issues** when they're resolved

---

## Forking Repositories

Forking creates your own copy of a repository that you can modify independently.

### How to Fork

1. **Navigate to the repository** you want to fork
2. **Click the "Fork" button**
3. **GitRepublic will**:
   - Create a copy of the repository under your account
   - Create a new NIP-34 announcement for your fork
   - Set you as the owner of the fork
   - Add a reference to the original repository

### Working with Forks

After forking:

1. **Clone your fork**:
   ```bash
   git clone https://{domain}/api/git/{your-npub}/{fork-name}.git
   ```

2. **Make changes** in your fork

3. **Push changes**:
   ```bash
   git push origin main
   ```

4. **Create a pull request** back to the original repository (if you want to contribute)

### Syncing with Upstream

To keep your fork up to date with the original repository:

1. **Add the original as a remote**:
   ```bash
   git remote add upstream https://{domain}/api/git/{original-npub}/{original-repo}.git
   ```

2. **Fetch and merge**:
   ```bash
   git fetch upstream
   git merge upstream/main
   git push origin main
   ```

---

## Updating Repository Information

To update your repository information, navigate to the signup page with your repository details pre-filled.

### Accessing the Update Form

1. Navigate to your repository page
2. Click "Settings" (if you're the owner or a maintainer)
3. You'll be redirected to the signup page with all current repository information pre-filled

### Privacy Settings

- **Public**: Anyone can view and clone your repository
- **Private**: Only owners and maintainers can access

You can change the privacy setting by checking or unchecking the "Private Repository" option in the update form.

### Maintainer Management

Add maintainers who can:
- Push to the repository
- Merge pull requests
- Manage issues
- Update repository information

**To add a maintainer**:
1. Access the update form (via Settings link)
2. Enter the maintainer's npub in the maintainers field
3. Click "Add Maintainer" to add additional maintainer fields
4. Save changes

**To remove a maintainer**:
1. Access the update form
2. Remove the maintainer's npub from the maintainers field
3. Save changes

### Repository Description

Update your repository description:
1. Access the update form
2. Edit the description field
3. Save changes

### Clone URLs

Add multiple clone URLs to sync your repository to other git hosts:
1. Access the update form
2. Add clone URLs (one per field)
3. Save changes

When you push, GitRepublic will automatically sync to all configured remotes.

### Ownership Transfer

Transfer repository ownership to another user using the transfer workflow:

1. **Initiate Transfer**: On your repository page, click "Transfer Ownership"
2. **Enter New Owner**: Provide the new owner's npub
3. **Sign and Publish**: The transfer event (kind 1641) is signed and published to Nostr relays
4. **Save to Repository**: The transfer event is saved to `nostr/repo-events.jsonl` in your repository for offline papertrail
5. **New Owner Notification**: The new owner will be notified when they log into GitRepublic web
6. **Complete Transfer**: The new owner completes the transfer by publishing a new repository announcement (kind 30617)
7. **Verification**: The new announcement is saved to the repository, and the transfer is complete

**Important**: Ownership transfers are permanent and create a chain of ownership events. The new owner will have full control. Both the transfer event and the new repository announcement are published to relays and saved to `nostr/repo-events.jsonl` in the repository for both online and offline papertrail.

---

## Collaboration Features

### Code Highlights

Highlight specific code sections in pull requests:

1. **Select code** in the PR diff view
2. **Click "Highlight"**
3. **Add a comment** explaining the highlight
4. **Others can comment** on your highlights

### Comments

Comment on:
- Pull requests
- Issues
- Code highlights
- Specific lines in diffs

Comments are threaded and use Nostr events (kind 1111) for persistence.

### Notifications

GitRepublic uses Nostr events for notifications. You can:
- Subscribe to repository events
- Get notified of new PRs, issues, and comments
- Track changes using your Nostr client

---

## Best Practices

### Repository Organization

1. **Use descriptive names**: Choose clear, descriptive repository names
2. **Write good READMEs**: Include installation instructions, usage examples, and contribution guidelines
3. **Use tags for releases**: Tag important versions (e.g., `v1.0.0`)
4. **Keep repositories focused**: One repository per project or component

### Commit Messages

Write clear, descriptive commit messages:

```bash
# Good
git commit -m "Add user authentication feature"

# Better
git commit -m "Add user authentication with NIP-07 support

- Implement NIP-07 browser extension authentication
- Add login/logout functionality
- Update UI to show user badge when logged in"
```

### Branch Strategy

- **main/master**: Production-ready code
- **feature/**: New features
- **bugfix/**: Bug fixes
- **hotfix/**: Urgent production fixes

### Pull Request Guidelines

1. **Keep PRs focused**: One feature or fix per PR
2. **Write clear descriptions**: Explain what and why, not just what
3. **Link related issues**: Reference issues in PR descriptions
4. **Request reviews**: Ask maintainers to review your PRs
5. **Respond to feedback**: Address review comments promptly

### Security

1. **Keep your keys secure**: Never share your nsec (private key)
2. **Use NIP-07 extensions**: Don't enter keys directly in web forms
3. **Review maintainers**: Only add trusted users as maintainers
4. **Monitor your repositories**: Check for unexpected changes

---

## Troubleshooting

### Authentication Issues

**Problem**: Can't push to repository

**Solutions**:
- Verify you're logged in with NIP-07
- Check that you're the owner or a maintainer
- Ensure your NIP-98 authentication is configured correctly
- Check repository privacy settings

### Clone Fails

**Problem**: Can't clone a repository

**Solutions**:
- Verify the repository URL is correct
- Check if the repository is private (requires authentication)
- Ensure you have network access to the GitRepublic instance
- Try cloning with verbose output: `git clone -v {url}`

### Push Fails

**Problem**: Push is rejected

**Solutions**:
- Check repository size limit (2 GB maximum)
- Verify you have write permissions
- Ensure your branch is up to date: `git pull origin main`
- Check for branch protection rules

### Repository Not Found

**Problem**: Repository doesn't appear after creation

**Solutions**:
- Wait a few moments for auto-provisioning
- Refresh the page
- Check that the NIP-34 announcement was published
- Verify you're looking at the correct domain

### Sync Issues

**Problem**: Changes not syncing to other remotes

**Solutions**:
- Verify clone URLs are correct in repository settings
- Check network connectivity to remote git hosts
- Review server logs for sync errors
- Manually push to remotes if needed

---

## Advanced Topics

### NIP-34 Specification

GitRepublic implements NIP-34 for repository announcements. Key event types:

- **Kind 30617**: Repository announcement
- **Kind 30618**: Repository state
- **Kind 1617**: Git patch
- **Kind 1618**: Pull request
- **Kind 1619**: Pull request update
- **Kind 1621**: Issue
- **Kind 1630-1633**: Status events (open, applied/merged, closed, draft)
- **Kind 1641**: Ownership transfer

See the [NIP-34 documentation](/docs/nip34) for full details.

### GRASP Protocol Support

GitRepublic supports the [GRASP (Git Repository Announcement and Synchronization Protocol)](https://gitworkshop.dev/npub15qydau2hjma6ngxkl2cyar74wzyjshvl65za5k5rl69264ar2exs5cyejr/grasp) for interoperability with other git hosting services built on Nostr.

**What is GRASP?**

GRASP is a protocol that extends NIP-34 to provide a standardized way for git repositories to be announced, synchronized, and managed across different hosting providers. GRASP servers implement additional NIP-34 event kinds (such as patches, pull request updates, repository state tracking, and user grasp lists) that enable more advanced collaboration features.

**How GitRepublic Supports GRASP:**

While GitRepublic is directly git-based and doesn't require all NIP-34 features to function, we fully support repositories hosted on GRASP servers:

1. **Multi-Remote Synchronization**: When you create a repository announcement with multiple `clone` URLs (including GRASP server URLs), GitRepublic automatically:
   - Syncs from GRASP servers when provisioning new repositories
   - Pushes changes to all configured remotes (including GRASP servers) after each push
   - Keeps your repository synchronized across all hosting providers

2. **On-Demand Repository Fetching**: If a repository is announced on Nostr but not yet provisioned locally, GitRepublic can:
   - Automatically fetch the repository from any configured clone URL (including GRASP servers)
   - Display and serve repositories hosted entirely on GRASP servers
   - Clone repositories from GRASP servers when users access them

3. **Interoperability**: You can:
   - Use GitRepublic as your primary git host while syncing to GRASP servers
   - Host repositories on GRASP servers and have them accessible through GitRepublic
   - Migrate repositories between GRASP servers and GitRepublic seamlessly

**Example: Using GRASP Servers**

When creating a repository, you can add GRASP server URLs as clone URLs:

```
https://grasp.example.com/user/repo.git
```

GitRepublic will automatically:
- Clone from the GRASP server if the repo doesn't exist locally
- Push all changes to the GRASP server after each push
- Keep both repositories in sync

This means you can use GitRepublic's direct git-based workflow while maintaining compatibility with GRASP-based services that use patches, PR updates, and other advanced NIP-34 features.

For more information about the GRASP protocol, see the [GRASP Protocol Documentation](https://gitworkshop.dev/npub15qydau2hjma6ngxkl2cyar74wzyjshvl65za5k5rl69264ar2exs5cyejr/grasp).

### NIP-98 HTTP Authentication

Git operations use NIP-98 for authentication:

1. Client creates an ephemeral event (kind 27235)
2. Event includes request URL, method, and payload hash
3. Client signs event and includes in `Authorization` header
4. Server verifies signature and permissions

### Relay Configuration

GitRepublic uses Nostr relays to:
- Publish repository announcements
- Fetch repository metadata
- Sync pull requests and issues
- Track ownership transfers

Default relays are configured, but you can use custom relays if needed.

---

## Getting Help

- **Documentation**: Check this tutorial and the NIP-34 specification
- **Issues**: Report bugs or request features via GitHub issues (if the instance has a GitHub repo)
- **Community**: Join Nostr communities to discuss GitRepublic
- **Support**: Contact the GitRepublic instance administrator

---

## Conclusion

Congratulations! You now know how to use GitRepublic for decentralized git hosting. Remember:

- GitRepublic is built on Nostr, making it truly decentralized
- You have full control over your repositories
- Collaboration happens through Nostr events
- Security is handled via NIP-07 and NIP-98

Happy coding!
