# Publishing GitRepublic CLI to npm

## Prerequisites

1. **Create npm account** (if you don't have one):
   - Visit https://www.npmjs.com/signup
   - Or run: `npm adduser`

2. **Enable Two-Factor Authentication (2FA) or Create Access Token**:
   
   npm requires either TOTP/SMS 2FA or a granular access token to publish packages. Biometric authentication (fingerprint) alone is not sufficient for CLI publishing.
   
   **Option A: Enable TOTP/SMS 2FA** (Recommended for regular use):
   - Go to https://www.npmjs.com/settings/[your-username]/security
   - Look for "Two-factor authentication" section
   - If you only see biometric options, you may need to:
     1. Check if there's an "Advanced" or "More options" link
     2. Look for "Authenticator app" or "SMS" options
     3. Some accounts may need to disable biometric first to see other options
   - **If using TOTP app** (recommended):
     - You'll see a QR code on your computer screen
     - Scan it with your phone's authenticator app (Google Authenticator, Authy, 1Password, etc.)
     - The app will generate 6-digit codes that you'll use when logging in
   - **If using SMS**:
     - Enter your phone number
     - You'll receive codes via text message
   - Follow the setup instructions to complete the setup
   
   **Option B: Create Granular Access Token** (Alternative if 2FA setup is difficult):
   - Go to https://www.npmjs.com/settings/[your-username]/tokens
   - Click "Generate New Token"
   - Choose "Granular Access Token"
   - Set permissions: Select "Publish" for the package(s) you want to publish
   - Enable "Bypass 2FA" option (this is required for publishing)
   - Copy the token (you'll only see it once!)
   - Use it for authentication:
     ```bash
     npm config set //registry.npmjs.org/:_authToken YOUR_TOKEN_HERE
     ```
   - Or set it as an environment variable:
     ```bash
     export NPM_TOKEN=YOUR_TOKEN_HERE
     ```

3. **Login to npm from your computer** (if using Option A):
   ```bash
   npm logout  # Log out first if already logged in
   npm login
   ```
   - Enter your username, password, and email
   - If 2FA is enabled, you'll be prompted for the authentication code
   - **Get the code from your phone's authenticator app** (if using TOTP) or check your SMS (if using SMS)
   - Enter the 6-digit code when prompted

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

### "Access token expired or revoked"
- Your npm login session has expired
- Solution: Run `npm login` again to authenticate
- Verify you're logged in: `npm whoami`

### "403 Forbidden - Two-factor authentication or granular access token with bypass 2fa enabled is required"
- npm requires 2FA (TOTP/SMS) or a granular access token to publish packages
- Biometric authentication (fingerprint) alone is not sufficient for CLI publishing
- **Solution Option 1: Enable TOTP/SMS 2FA**
  1. Visit: https://www.npmjs.com/settings/[your-username]/security
  2. Look for "Two-factor authentication" section
  3. If you only see biometric options:
     - Check for "Advanced" or "More options" links
     - Look for "Authenticator app" or "SMS" options
     - You may need to disable biometric first to see other options
  4. Enable TOTP app (recommended) or SMS
  5. Follow setup instructions
  6. After enabling, log out and log back in: `npm logout` then `npm login`
- **Solution Option 2: Use Granular Access Token** (if 2FA setup is difficult)
  1. Visit: https://www.npmjs.com/settings/[your-username]/tokens
  2. Click "Generate New Token" → "Granular Access Token"
  3. Set permissions: Select "Publish" for your package(s)
  4. **Important**: Enable "Bypass 2FA" option
  5. Copy the token (save it securely - you'll only see it once!)
  6. Use it for authentication:
     ```bash
     npm config set //registry.npmjs.org/:_authToken YOUR_TOKEN_HERE
     ```
  7. Or set as environment variable:
     ```bash
     export NPM_TOKEN=YOUR_TOKEN_HERE
     ```
  8. Now you can publish: `npm publish`

### "404 Not Found - PUT https://registry.npmjs.org/gitrepublic-cli"
- This is normal for a first publish (package doesn't exist yet)
- Make sure you're logged in: `npm login`
- Check if package name is available: `npm view gitrepublic-cli` (should return 404)

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

### npm warnings about package.json
- If you see warnings about `bin` script names being "cleaned", this is usually fine - npm normalizes them
- If you see warnings about `repositories` field, remove it and use only the `repository` field (single object, not array)
