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

- **CLI Entry Point** (`src/index.ts`): Defines all CLI commands using Commander.js
- **SpaceManager** (`src/utils/SpaceManager.ts`): Core business logic for managing spaces
- **SSH Key Generation** (`src/utils/sshKeyGen.ts`): Handles SSH key generation using the `ssh-keygen` package
- **Utility Functions** (`src/utils/index.ts`): SSH configuration, clipboard operations, and GitHub access testing
- **UI Helper** (`src/utils/ui.ts`): Rich UI components with colored output and formatting
- **Batch Operations** (`src/utils/batchOperations.ts`): Bulk operations and import/export functionality

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