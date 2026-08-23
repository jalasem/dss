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

DSS (Dev Spaces Switcher) is a CLI tool for managing isolated development **identities** — separate SSH keys and Git configuration per client, employer, or project. The application follows a command-based architecture using Commander.js, layered into `commands/` (thin, prompt-owning command handlers), `core/` (dependency-free domain types and lookups), and `infra/` (filesystem, Git, and SSH side effects).

The primary command surface is `dss` (bare-command dashboard), `ls`, `use`, `new`, `edit`, `rm`, `link`/`unlink`, `key`, `config`, `doctor`, `status`, `completion`. Pre-v2 command names (`list`, `switch`, `add`, `remove`, `bind`, `unbind`, `export`, `import`, `test`, `inspect`) still work as hidden Commander subcommands that print a deprecation warning to stderr and delegate to the same handler — they are removed in v3. `batch`, `bulk`, and `onboard` were cut entirely with no alias, replaced by the automatic first-run flow and per-identity `dss key rotate`.

### Core Components

- **CLI Entry Point** (`src/index.ts`): Defines the primary command surface and the `deprecatedAlias` wrapper for legacy names using Commander.js; dispatches bare `dss` (no args) to the dashboard instead of Commander's own help output
- **Space Commands** (`src/commands/spaces.ts`): `addSpace`, `listSpaces`, `switchSpace`, `removeSpace`, `modifySpace` — also `reapplyActiveIdentity`, the shared helper that re-applies active.gitconfig/ssh-config for an identity when (and only when) it's still the store's active one
- **Batch Commands** (`src/commands/batch.ts`): `exportSpaceConfiguration`, `importSpaceConfiguration` — backs `dss config export|import`
- **Key Commands** (`src/commands/keys.ts`): `showKey`, `copyKey`, `rotateKey`, `keyCommand` — `dss key show|copy|rotate`
- **Repository Binding Commands** (`src/commands/binding.ts`): `bindSpaceToRepository`, `unbindSpaceFromRepository`, `showRepositoryBindingStatus` — `dss link`/`unlink`/`status`
- **Dashboard** (`src/commands/dashboard.ts`): the bare-`dss` front door — which identity applies here (repo-bound or global default) and a fast, network-free health summary
- **Doctor** (`src/commands/doctor.ts`): `dss doctor` — the single combined health check that absorbed the old `test` (host auth) and `inspect` (detailed report) commands: identity info, key files/permissions, ssh-agent, ssh-config Host-block match, host auth (the one network call), Git identity drift, repo binding
- **First Run** (`src/commands/firstRun.ts`): `firstRunFlow` — replaces the old `onboard` tutorial; triggered automatically by `dss`/`dss ls`/`dss use` whenever the store has zero identities, offering to create the first one immediately
- **Completion** (`src/commands/completion.ts`): generates bash/zsh/fish completion scripts for the current command surface
- **UI Helper** (`src/commands/ui.ts`): the calm output layer — one accent color, a small glyph set (`●`/`✓`/`✗`/`!`) instead of emoji, no box-drawing, and a plain-ASCII degrade for `NO_COLOR`/non-TTY output
- **Domain Types** (`src/core/types.ts`): `ISpace`, `IConfig`, `IIdentity`, `IKeyInfo`, `IBinding`, `IStoreV2`
- **Identity Lookups** (`src/core/identity.ts`): `slugify`, `findSpace`, `findIdentity`, `validateIdentityName` — pure, dependency-free helpers
- **Hosts** (`src/core/hosts.ts`): `KNOWN_HOSTS` (github.com/gitlab.com/bitbucket.org) and `keySettingsUrl` — any other host is still usable, just without a key-settings deep link
- **Config Store** (`src/infra/store.ts`): reads/writes `~/.dss/spaces/config.json` (with silent v1→v2 migration), including the shared `loadConfig`/`persistConfig` helpers used by the space and batch commands
- **Git Identity** (`src/infra/git.ts`): `getGitUser` (reads global `user.name`/`user.email`), `writeActiveGitconfig`/`ensureGlobalInclude` — includeIf-first: writes `~/.dss/active.gitconfig` and makes sure it's included via a global `include.path`, rather than writing `user.name`/`user.email` directly (there is no `setGitUser`)
- **SSH Config & Access** (`src/infra/ssh.ts`): `setHostSSHKey`, `removeSSHKeyFromAgent`, `testHostAccess`, `checkHostAccess`, `addToAgent` — host-agnostic (works for any configured Git host, not just github.com) via parse-don't-splice editing of `~/.ssh/config`
- **SSH Key Generation** (`src/infra/keys.ts`): handles SSH key generation via the system `ssh-keygen` binary (not an npm `ssh-keygen` package); defaults to Ed25519
- **Clipboard** (`src/infra/clipboard.ts`): platform-specific clipboard operations (pbcopy/clip/xclip)
- **Repository Binding** (`src/infra/repoBinding.ts`): low-level Git conditional-include binding logic (`includeIf.gitdir:`, worktree-aware, Git ≥2.30)

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

1. **Identity Creation**: `dss new` generates SSH keys in `~/.dss/spaces/{identityName}/id_ed25519` by default (`id_rsa` when RSA is selected), Ed25519 via the system `ssh-keygen` binary, with an optional passphrase; on macOS the key is added to the ssh-agent with `--apple-use-keychain` so the passphrase survives a reboot
2. **Identity Switching**: `dss use` writes `~/.dss/active.gitconfig` (`[user]` name/email, plus `[core] sshCommand` when the identity has a key) and ensures the user's global Git config includes it via `include.path` — includeIf-first: it does not write `user.name`/`user.email` into the user's own `~/.gitconfig` directly. Also updates `~/.ssh/config` and the ssh-agent (kept as a redundant safety net alongside `core.sshCommand`)
3. **SSH Configuration**: parses and patches the `~/.ssh/config` `Host` block for the identity's configured host (per-identity, defaults to `github.com`) rather than splicing text
4. **Repository Binding**: `dss link`/`unlink` pin one identity to a repository (or Git worktree) via a private, git-tracked-ignored config file wired in through `includeIf.gitdir:` — independent of the global active identity; `dss status` reports the current repo's binding
5. **Health Checks**: `dss doctor [identityName]` runs the full combined check (see Doctor above); the bare-`dss` dashboard runs a fast, network-free subset as a front door
6. **Key Management**: `dss key show|copy|rotate` — view, copy, or rotate an identity's SSH key
7. **First Run**: an empty store triggers `firstRunFlow` automatically from `dss`/`dss ls`/`dss use` instead of requiring a separate onboarding command
8. **Backup/Restore**: `dss config export|import [path]` — SSH keys are never included in the export
9. **Deprecation Aliases**: legacy command names delegate to the current handlers and print a warning to stderr; see Architecture Overview above for the full mapping

### File Structure

- SSH keys are stored in `~/.dss/spaces/{identityName}/`
- Configuration is stored in `~/.dss/spaces/config.json`
- The tool writes `~/.dss/active.gitconfig` (included from the global Git config) and modifies `~/.ssh/config` and SSH agent state
- Repository bindings live under each repository's own `.git/` directory and are never committed

## Testing

The project includes comprehensive test coverage:

- **Unit Tests**: Test individual functions and components
- **Integration Tests**: Test CLI commands and workflows
- **Performance Tests**: Benchmark operations and memory usage
- **UI Tests**: Test colored/plain output and formatting functions, including the `NO_COLOR`/non-TTY degrade

## Important Notes

- This CLI tool requires system-level permissions to modify SSH configuration and Git settings
- The tool uses platform-specific clipboard operations (pbcopy/clip/xclip)
- All identity names are automatically slugified (lowercase with hyphens)
- The active identity cannot be removed without switching to another identity first
- Uses Chalk v4.1.2 for colored output (CommonJS compatible), degrading to plain ASCII under `NO_COLOR` or when stdout isn't a TTY
- No `--json` output mode yet — planned for a later phase, not implemented
- All tests use Jest with ts-jest for TypeScript support
