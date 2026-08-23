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
- **Space Commands** (`src/commands/spaces.ts`): addSpace, listSpaces, switchSpace, removeSpace, modifySpace, testSpace, inspectSpace, onboardUser
- **Batch Commands** (`src/commands/batch.ts`): batchSwitchSpaces, exportSpaceConfiguration, importSpaceConfiguration, bulkUpdateSpaces
- **Repository Binding Commands** (`src/commands/binding.ts`): bindSpaceToRepository, unbindSpaceFromRepository, showRepositoryBindingStatus
- **UI Helper** (`src/commands/ui.ts`): Rich UI components with colored output and formatting
- **Domain Types** (`src/core/types.ts`): ISpace, IConfig, IIdentity, IKeyInfo, IBinding, IStoreV2
- **Identity Lookups** (`src/core/identity.ts`): slugify, findSpace, findIdentity — pure, dependency-free helpers
- **Config Store** (`src/infra/store.ts`): Reads/writes `~/.dss/spaces/config.json` (with silent v1→v2 migration), including the shared loadConfig/persistConfig helpers used by the space and batch commands
- **Git Identity** (`src/infra/git.ts`): setGitUser/getGitUser — wraps global `git config user.name`/`user.email`
- **SSH Config & Access** (`src/infra/ssh.ts`): setGitHubSSHKey, removeSSHKeyFromAgent, testGithubAccess
- **SSH Key Generation** (`src/infra/keys.ts`): Handles SSH key generation using the `ssh-keygen` package
- **Clipboard** (`src/infra/clipboard.ts`): Platform-specific clipboard operations (pbcopy/clip/xclip)
- **Repository Binding** (`src/infra/repoBinding.ts`): Low-level Git conditional-include binding logic

### Data Model

The application stores its configuration in `~/.dss/spaces/config.json`:

```typescript
interface ISpace {
  name: string;
  email: string;
  userName: string;
  sshKeyPath: string;
}

interface IConfig {
  spaces: ISpace[];
  activeSpace?: string;
}
```

### Key Operations

1. **Space Creation**: Generates SSH keys in `~/.dss/spaces/{spaceName}/id_rsa`
2. **Space Switching**: Updates global Git config and SSH agent with space-specific credentials
3. **SSH Configuration**: Modifies `~/.ssh/config` to use the appropriate SSH key for GitHub
4. **GitHub Integration**: Tests SSH access and provides public key for GitHub setup
5. **Interactive Selection**: Selection menus with per-space descriptions for better UX
6. **Batch Operations**: Switch between multiple spaces, export/import configurations
7. **UI Enhancements**: Rich colored output, progress indicators, and better error messages

### File Structure

- SSH keys are stored in `~/.dss/spaces/{spaceName}/`
- Configuration is stored in `~/.dss/spaces/config.json`
- The tool modifies global Git configuration and SSH agent state

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