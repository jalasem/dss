# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development Commands

- **Build**: `npm run build` - Compiles TypeScript to JavaScript in the `build/` directory
- **Development**: `npm run dev` - Runs the CLI in development mode using ts-node
- **Start**: `npm run start` - Runs the built CLI from `build/index.js`
- **Lint**: `npm run lint` - Runs ESLint with auto-fix on TypeScript files
- **Test**: `npm test` - Runs Jest test suite with comprehensive coverage
- **Test Watch**: `npm run test:watch` - Runs tests in watch mode
- **Test Coverage**: `npm run test:coverage` - Runs tests with coverage reporting
- **Test CI**: `npm run test:ci` - Runs tests in CI mode without watch

## Architecture Overview

DSS (Dev Spaces Switcher) is a CLI tool for managing isolated development environments with separate SSH keys and Git configurations. The application follows a command-based architecture using Commander.js.

### Core Components

The codebase is layered into `commands/` (thin, prompt-owning command handlers), `core/` (dependency-free domain types and lookups), and `infra/` (filesystem, Git, and SSH side effects):

- **CLI Entry Point** (`src/index.ts`): Defines all CLI commands using Commander.js, wiring them to `commands/`
- **Space Commands** (`src/commands/spaces.ts`): addSpace, listSpaces, switchSpace, removeSpace, modifySpace, testSpace, inspectSpace, onboardUser — also `reapplyActiveIdentity`, the shared helper that re-applies active.gitconfig/ssh-config for an identity when (and only when) it's still the store's active one
- **Batch Commands** (`src/commands/batch.ts`): batchSwitchSpaces, exportSpaceConfiguration, importSpaceConfiguration, bulkUpdateSpaces
- **Key Commands** (`src/commands/keys.ts`): showKey, copyKey, rotateKey, keyCommand — `dss key show|copy|rotate`
- **Repository Binding Commands** (`src/commands/binding.ts`): bindSpaceToRepository, unbindSpaceFromRepository, showRepositoryBindingStatus
- **UI Helper** (`src/commands/ui.ts`): Rich UI components with colored output and formatting
- **Domain Types** (`src/core/types.ts`): ISpace, IConfig, IIdentity, IKeyInfo, IBinding, IStoreV2
- **Identity Lookups** (`src/core/identity.ts`): slugify, findSpace, findIdentity, validateIdentityName — pure, dependency-free helpers
- **Config Store** (`src/infra/store.ts`): Reads/writes `~/.dss/spaces/config.json` (with silent v1→v2 migration), including the shared loadConfig/persistConfig helpers used by the space and batch commands
- **Git Identity** (`src/infra/git.ts`): getGitUser (reads global `user.name`/`user.email`), writeActiveGitconfig/ensureGlobalInclude — includeIf-first: writes `~/.dss/active.gitconfig` and makes sure it's included via a global `include.path`, rather than writing `user.name`/`user.email` directly (there is no `setGitUser`)
- **SSH Config & Access** (`src/infra/ssh.ts`): setHostSSHKey, removeSSHKeyFromAgent, testHostAccess, addToAgent — host-agnostic (works for any configured Git host, not just github.com) via parse-don't-splice editing of `~/.ssh/config`
- **SSH Key Generation** (`src/infra/keys.ts`): Handles SSH key generation via the system `ssh-keygen` binary (not the `ssh-keygen` npm package); defaults to Ed25519
- **Clipboard** (`src/infra/clipboard.ts`): Platform-specific clipboard operations (pbcopy/clip/xclip)
- **Repository Binding** (`src/infra/repoBinding.ts`): Low-level Git conditional-include binding logic

### Data Model

The application stores its configuration in `~/.dss/spaces/config.json` as a v2 store:

```typescript
interface IKeyInfo {
  path: string;
  algorithm: 'ed25519' | 'rsa' | 'unknown';
  createdAt?: string;
  fingerprint?: string;
}

interface IIdentity {
  name: string;
  email: string;
  userName: string;
  host: string;      // e.g. 'github.com', 'gitlab.com', or any custom host
  key?: IKeyInfo;     // absent for a keyless identity
}

interface IBinding {
  path: string;       // canonical repository path
  identity: string;
}

interface IStoreV2 {
  version: 2;
  identities: IIdentity[];
  active?: string;
  bindings: IBinding[];
}
```

A v1 file (`{ spaces: ISpace[], activeSpace?: string }`, `sshKeyPath`-based, no `host`) is migrated silently on load. The command layer still works against a back-compat `ISpace`/`IConfig` view (`sshKeyPath` instead of `key`) via `src/infra/store.ts`'s `loadConfig`/`persistConfig`, which merge edits back onto the underlying `IIdentity` without dropping metadata the view can't carry (host, key fingerprint/createdAt).

### Key Operations

1. **Space Creation**: Generates SSH keys in `~/.dss/spaces/{spaceName}/id_ed25519` by default (`id_rsa` when RSA is selected)
2. **Space Switching**: Writes `~/.dss/active.gitconfig` (`[user]` name/email, plus `[core] sshCommand` when the identity has a key) and ensures the user's global Git config includes it via `include.path` — it does not write `user.name`/`user.email` into the user's own `~/.gitconfig` directly. Also updates `~/.ssh/config` and the ssh-agent (kept as a redundant safety net alongside `core.sshCommand`)
3. **SSH Configuration**: Parses and patches the `~/.ssh/config` `Host` block for the identity's configured host (defaults to `github.com`) rather than splicing text
4. **Host Integration**: `dss test` verifies SSH access and provides the public key/host-specific key-settings link
5. **Key Management**: `dss key show|copy|rotate` — view, copy, or rotate an identity's SSH key
6. **Interactive Selection**: Selection menus with per-space descriptions for better UX
7. **Batch Operations**: Switch between multiple spaces, export/import configurations, bulk-edit email/username/keys
8. **UI Enhancements**: Rich colored output, progress indicators, and better error messages

### File Structure

- SSH keys are stored in `~/.dss/spaces/{spaceName}/`
- Configuration is stored in `~/.dss/spaces/config.json`
- The tool writes `~/.dss/active.gitconfig` (included from the global Git config) and modifies `~/.ssh/config` and SSH agent state

## Testing

The project includes comprehensive test coverage:

- **Unit Tests**: Test individual functions and components
- **Integration Tests**: Test CLI commands and workflows
- **Performance Tests**: Benchmark operations and memory usage
- **UI Tests**: Test colored output and formatting functions

## Important Notes

- This CLI tool requires system-level permissions to modify SSH configuration and Git settings
- The tool uses platform-specific clipboard operations (pbcopy/clip/xclip)
- All space names are automatically slugified (lowercase with hyphens)
- The active space cannot be removed without switching to another space first
- Uses Chalk v4.1.2 for colored output (CommonJS compatible)
- Interactive selection menus provide per-space descriptions for enhanced UX
- All tests use Jest with ts-jest for TypeScript support