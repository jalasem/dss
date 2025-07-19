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
| 🔍 **Fuzzy Search** | Intelligent search functionality for quick space discovery |
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
- Automatically generates SSH keys
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
- Cleans up SSH keys and configurations

</details>

<details>
<summary><b>✏️ Edit Space Configuration</b></summary>

```bash
dss edit [spaceName]
```

Modify existing space settings:
- Update email and username
- Regenerate SSH keys if needed
- Interactive editing workflow

</details>

### Advanced Features

<details>
<summary><b>🔍 Fuzzy Search Spaces</b></summary>

```bash
dss search [query]
```

Quickly find spaces using intelligent search:
- Search by name, email, or username
- Fuzzy matching for typos
- Fast results display

</details>

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
dss export [--output config.json]
```

Import from backup:
```bash
dss import [--file config.json]
```

Perfect for:
- Moving between machines
- Backup strategies
- Team configuration sharing

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
| 🔍 **Fuzzy Search** | Intelligent search functionality | Faster space discovery |
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
├── utils/
│   ├── SpaceManager.ts   # Core business logic
│   ├── ui.ts            # Rich UI components
│   ├── sshKeyGen.ts     # SSH key generation
│   ├── fuzzySearch.ts   # Search functionality
│   └── batchOperations.ts # Bulk operations
└── __tests__/           # Test suites
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
