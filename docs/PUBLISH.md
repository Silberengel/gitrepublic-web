# Publishing GitRepublic CLI to npm

## Prerequisites

1. **Create npm account** (if you don't have one):
   - Visit https://www.npmjs.com/signup
   - Or run: `npm adduser`

2. **Login to npm**:
   ```bash
   npm login
   ```
   Enter your username, password, and email.

3. **Check if package name is available**:
   ```bash
   npm view gitrepublic-cli
   ```
   If it returns 404, the name is available. If it shows package info, the name is taken.

## Publishing Steps

### 1. Update version (if needed)

```bash
# Patch version (1.0.0 -> 1.0.1)
npm version patch

# Minor version (1.0.0 -> 1.1.0)
npm version minor

# Major version (1.0.0 -> 2.0.0)
npm version major
```

Or manually edit `package.json` and update the version field.

### 2. Verify package contents

```bash
# See what will be published
npm pack --dry-run
```

This shows the files that will be included (based on `files` field in package.json).

### 3. Test the package locally

```bash
# Pack the package
npm pack

# Install it locally to test
npm install -g ./gitrepublic-cli-1.0.0.tgz

# Test the commands
gitrepublic-path --credential
gitrepublic-path --hook
```

### 4. Publish to npm

```bash
cd gitrepublic-cli
npm publish
```

For scoped packages (if you want `@your-org/gitrepublic-cli`):
```bash
npm publish --access public
```

### 5. Verify publication

```bash
# Check on npm website
# Visit: https://www.npmjs.com/package/gitrepublic-cli

# Or via command line
npm view gitrepublic-cli
```

## After Publishing

Users can now install via:
```bash
npm install -g gitrepublic-cli
```

## Updating the Package

1. Make your changes
2. Update version: `npm version patch` (or minor/major)
3. Publish: `npm publish`

## Important Notes

- **Package name**: `gitrepublic-cli` must be unique on npm. If taken, use a scoped name like `@your-org/gitrepublic-cli`
- **Version**: Follow semantic versioning (semver)
- **Files**: Only files listed in `files` array (or not in `.npmignore`) will be published
- **Unpublishing**: You can unpublish within 72 hours, but it's discouraged. Use deprecation instead:
  ```bash
  npm deprecate gitrepublic-cli@1.0.0 "Use version 1.0.1 instead"
  ```

## Troubleshooting

### "Package name already exists"
- The name `gitrepublic-cli` is taken
- Options:
  1. Use a scoped package: Change name to `@your-org/gitrepublic-cli` in package.json
  2. Choose a different name
  3. Contact the owner of the existing package

### "You do not have permission"
- Make sure you're logged in: `npm whoami`
- If using scoped package, add `--access public` flag

### "Invalid package name"
- Package names must be lowercase
- Can contain hyphens and underscores
- Cannot start with dot or underscore
- Max 214 characters
