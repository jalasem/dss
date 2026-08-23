<div align="center">

# 🚀 Dev Spaces Switcher (DSS)

*Seamlessly manage isolated development environments with separate SSH keys and Git configurations*

[![npm version](https://badge.fury.io/js/%40jalasem%2Fdss.svg)](https://badge.fury.io/js/%40jalasem%2Fdss)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/Built%20with-TypeScript-blue.svg)](https://www.typescriptlang.org/)

---

**Stop manually managing SSH keys and Git configs when switching between projects, clients, or companies.**

DSS provides isolated development environments that automatically handle SSH authentication and Git configuration, letting you focus on what matters most: your code.

</div>

## ✨ Features

| Feature | Description |
|---------|-------------|
| 🏗️ **Space Management** | Create and manage isolated workspaces for different projects |
| 🔐 **SSH Key Automation** | Automatically generate and switch SSH keys when changing spaces |
| 📝 **Git Configuration** | Streamlined GitHub user configuration for each space |
| 🎨 **Rich CLI Interface** | Beautiful command-line interface with colors and progress indicators |
| 🔄 **Interactive Selection** | Smart selection menus with per-space descriptions |
| 📦 **Batch Operations** | Perform operations on multiple spaces efficiently |
| 💾 **Import/Export** | Backup and restore space configurations |
| ⚡ **Performance** | Fast operations with comprehensive test coverage |

## 🚀 Quick Start

### Installation

Install DSS globally using your preferred package manager:

<table>
<tr>
<td>

**npm**
```bash
npm install -g @jalasem/dss
```

</td>
<td>

**yarn**
```bash
yarn global add @jalasem/dss
```

</td>
<td>

**pnpm**
```bash
pnpm add -g @jalasem/dss
```

</td>
</tr>
</table>

### Verify Installation

```bash
dss --version
```

## 📖 Usage Guide

After installation, use the `dss` command to manage your development spaces:

### Core Commands

<details>
<summary><b>🆕 Creating a New Space</b></summary>

```bash
dss add
```

Interactive wizard to create a new development space:
- Enter space name (auto-slugified)
- Provide email and username
- Choose a Git host (GitHub, GitLab, Bitbucket, or a custom host)
- Automatically generates an SSH key (Ed25519 by default)
- Sets up Git configuration

</details>

<details>
<summary><b>📋 List All Spaces</b></summary>

```bash
dss list
```

Displays a beautiful table of all your spaces showing:
- Space names with active indicators
- Associated email addresses
- Usernames
- Current status (active/inactive)

</details>

<details>
<summary><b>🔄 Switch Between Spaces</b></summary>

```bash
dss switch [spaceName]
```

Switch to a different development space:
- Without `spaceName`: Interactive selection menu
- With `spaceName`: Direct switch to specified space
- Updates Git config and SSH agent automatically

</details>

<details>
<summary><b>🗑️ Remove a Space</b></summary>

```bash
dss remove [spaceName]
```

Safely remove a development space:
- Interactive confirmation required
- Cannot remove active space
- Removes space from config and SSH agent, but key files remain on disk (`~/.dss/spaces/<name>/`)

</details>

<details>
<summary><b>✏️ Edit Space Configuration</b></summary>

```bash
dss edit [spaceName]
```

Modify existing space settings:
- Update name, email, username, and Git host
- Interactive editing workflow
- Does not regenerate SSH keys — use `dss bulk` or `dss key rotate` for that

</details>

<details>
<summary><b>🔑 SSH Key Management</b></summary>

```bash
dss key show [identityName]
dss key copy [identityName]
dss key rotate [identityName]
```

Manage a single identity's SSH key directly, without going through `dss add`/`dss bulk`:
- `show` — prints the public key, algorithm, fingerprint, and a link to the host's key-settings page
- `copy` — copies the public key to the clipboard
- `rotate` — generates a new key for the identity (same algorithm as its current key, Ed25519 for a keyless identity), adds it to the ssh-agent, and copies the new public key

`identityName` defaults to the currently active space when omitted. Rotating the active identity's key also refreshes `~/.dss/active.gitconfig` and `~/.ssh/config` so the new key takes effect immediately.

</details>

### Repository-Local Binding

Use repository-local binding when you want one DSS identity to stay attached to
the Git repository open in VS Code or another editor, without changing your
global DSS space.

```bash
# From a repository opened in VS Code
dss bind aweds-personal

# Bind an explicitly selected repository
dss bind aweds-personal --path ~/Desktop/my-project

# From a parent folder, preview and bind every child Git repository
dss bind aweds-personal -r --dry-run
dss bind aweds-personal -r

# Inspect or remove the current repository binding
dss status
dss unbind
```

DSS stores each repository binding under `.git/`, so no binding file can be
committed or pushed. Editor Git integrations inherit the binding because they
run Git inside that repository, while `dss switch` remains the separate global
mode for changing your active DSS space everywhere else. A repository's linked
Git worktrees can each be bound to a different DSS space.

DSS registers the private file with a Git `includeIf.gitdir:` condition for the
current worktree. Unbinding removes only that exact DSS condition and file; it
does not change `extensions.worktreeConfig` or unrelated Git includes. The
binding workflow requires Git 2.30 or newer.

Git cannot represent a carriage return or line feed exactly in an
`includeIf.gitdir:` subsection. DSS therefore refuses to bind the rare
repository whose canonical Git metadata path contains either character, rather
than using a wildcard that could match a sibling worktree. Read-only status and
unbind retain compatibility for diagnosing and removing legacy experimental
bindings created with that approximation.

### Advanced Features

<details>
<summary><b>📦 Batch Operations</b></summary>

```bash
dss batch
```

Perform operations on multiple spaces:
- Quick switching between spaces
- Bulk configuration updates
- Efficient workflow management

</details>

<details>
<summary><b>💾 Backup & Restore</b></summary>

Export your configuration:
```bash
dss export
```

Import from backup:
```bash
dss import
```

Both commands are interactive and use the fixed path `~/dss-export.json`:
- Export saves space configurations (SSH keys are excluded)
- Import creates spaces from exported config (without SSH keys)
- Perfect for moving between machines or backing up your setup

</details>

<details>
<summary><b>🔧 Space Inspection</b></summary>

```bash
dss inspect [spaceName]
```

View detailed information about a space:
- SSH key paths and fingerprints
- Git configuration details
- GitHub access status
- Configuration history

</details>

<details>
<summary><b>🧪 Test GitHub Access</b></summary>

```bash
dss test [spaceName]
```

Verify GitHub SSH connectivity:
- Tests SSH key authentication
- Validates GitHub access
- Provides troubleshooting tips

</details>

## 🎯 Use Cases

<table>
<tr>
<td width="50%">

### 🏢 **Freelancers & Consultants**
- Separate spaces for each client
- Isolated SSH keys and Git configs
- Quick switching between projects
- Professional identity management

</td>
<td width="50%">

### 🏭 **Enterprise Developers**
- Work and personal GitHub accounts
- Different SSH keys for security
- Project-specific configurations
- Compliance with company policies

</td>
</tr>
<tr>
<td>

### 👥 **Open Source Contributors**
- Personal vs. professional identities
- Multiple GitHub accounts
- Easy context switching
- Organized contribution workflow

</td>
<td>

### 🎓 **Students & Educators**
- School vs. personal projects
- Different email addresses
- Learning environment isolation
- Portfolio organization

</td>
</tr>
</table>

## 🆕 What's New in v1.1.0

<div align="center">

| Feature | Description | Impact |
|---------|-------------|---------|
| 🎨 **Enhanced UI** | Rich colored output with progress indicators | Better user experience |
| 📦 **Batch Operations** | Multi-space switching and operations | Improved workflow efficiency |
| 🔄 **Import/Export** | Backup and restore configurations | Data portability |
| ⚡ **Performance** | Optimized operations and memory usage | Faster execution |
| 🧪 **Testing** | Comprehensive test coverage (90%+) | Higher reliability |
| 📚 **Documentation** | Improved help text and guides | Better onboarding |

</div>

## 🛠️ Development

### Contributing

We welcome contributions! Here's how to get started:

1. **Fork the repository**
2. **Create a feature branch**: `git checkout -b feature/amazing-feature`
3. **Make your changes** with tests
4. **Run the test suite**: `npm test`
5. **Submit a pull request**

### Local Development

```bash
# Clone and setup
git clone https://github.com/jalasem/dss.git
cd dss
npm install

# Development workflow
npm run dev          # Run in development mode
npm run build        # Build for production
npm run lint         # Check code style
npm test             # Run test suite
npm run test:watch   # Run tests in watch mode
npm run test:coverage # Generate coverage report
```

### Project Structure

```
src/
├── index.ts              # CLI entry point
├── commands/             # Thin, prompt-owning command handlers
│   ├── spaces.ts         # addSpace, switchSpace, etc. (core business logic)
│   ├── batch.ts          # Bulk operations
│   ├── binding.ts        # Repository binding commands
│   ├── keys.ts           # dss key show/copy/rotate
│   ├── prompts.ts        # Shared/cancellation-safe prompt helpers
│   └── ui.ts             # Rich UI components
├── core/                 # Dependency-free domain types and lookups
│   ├── types.ts
│   ├── identity.ts
│   └── hosts.ts          # Known Git hosts + key-settings links
└── infra/                # Filesystem, Git, and SSH side effects
    ├── store.ts          # Config store (~/.dss/spaces/config.json, v1→v2 migration)
    ├── git.ts            # active.gitconfig + global include (includeIf-first)
    ├── ssh.ts            # SSH config (parse-don't-splice) and host access
    ├── keys.ts           # SSH key generation (system ssh-keygen binary)
    ├── clipboard.ts       # Platform-specific clipboard operations
    └── repoBinding.ts     # Repository-local Git conditional-include binding
tests/
├── commands/              # Command-layer test suites
├── core/                  # Core-layer test suites
├── infra/                 # Infra-layer test suites
└── ...                    # Additional tests
```

## 🙏 Acknowledgments

- **Contributors**: Thank you to all developers who've contributed to this project
- **Open Source Community**: For the amazing tools and libraries that make this possible
- **Users**: For feedback, bug reports, and feature requests that help improve DSS

---

<div align="center">

**Made with ❤️ by developers, for developers**

[Report Bug](https://github.com/jalasem/dss/issues) · [Request Feature](https://github.com/jalasem/dss/issues) · [Documentation](https://github.com/jalasem/dss#readme)

</div>
