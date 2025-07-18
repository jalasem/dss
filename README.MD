# Dev Spaces Switcher (DSS)

Dev Spaces Switcher (DSS) is a CLI tool designed to help developers switch between different contexts seamlessly when working across various environments or companies, without having to worry about SSH or GitHub configurations manually.

## Features

- **Create and Manage Spaces**: Easily create and manage isolated workspaces for different projects.
- **SSH Key Management**: Automatically generate and switch SSH keys when changing spaces.
- **GitHub Configuration**: Streamline GitHub user configuration for each space.
- **Rich CLI Interface**: Enhanced command-line interface with colors, progress indicators, and better formatting.
- **Fuzzy Search**: Quickly find spaces using intelligent search functionality.
- **Batch Operations**: Perform operations on multiple spaces at once.
- **Import/Export**: Backup and restore space configurations.
- **Performance Optimized**: Fast operations with comprehensive test coverage.

## Installation

DSS is available as an npm package. You can install it globally using npm:

```bash
npm install -g @jalasem/dss
```

or using yarn:

```bash
yarn global add @jalasem/dss
```

## Usage

After installation, you can use the dss command to manage your spaces. Here are some common commands:

### Adding a New Space

```bash
dss add
```

This command will guide you through the process of adding a new space.

### Listing All Spaces

```bash
dss list
```

This command will list all the spaces you have created.

### Switching to a Space

```bash
dss switch [spaceName]
```

If `[spaceName]` is omitted, you'll be prompted to select from available spaces.

### Removing a Space

```bash
dss remove [spaceName]
```

Remove an existing space. You'll be asked to confirm the removal.

### Modifying a Space
  
```bash
dss edit [spaceName]
```

Modify the configuration of an existing space. Follow the interactive prompts to make changes.

### Batch Operations

```bash
dss batch
```

Perform batch operations on multiple spaces - switch between them quickly.

### Import/Export Configuration

```bash
dss export
```

Export your space configuration to a JSON file.

```bash
dss import
```

Import space configuration from a JSON file.

### Bulk Operations

```bash
dss bulk
```

Perform bulk update operations on multiple spaces.

## What's New in v1.1.0

- 🎨 **Enhanced UI**: Rich colored output with progress indicators and better formatting
- 🔍 **Fuzzy Search**: Intelligent search functionality for quick space discovery
- 📦 **Batch Operations**: Switch between multiple spaces efficiently
- 🔄 **Import/Export**: Backup and restore your space configurations
- 🚀 **Performance**: Optimized operations with comprehensive test coverage
- 🧪 **Testing**: Full test suite with unit, integration, and performance tests
- 📚 **Better Documentation**: Improved help text and user guidance

## Contributing

Contributions are welcome! Please feel free to submit pull requests or create issues for bugs, questions, and feature requests.

### Development

```bash
# Install dependencies
npm install

# Run in development mode
npm run dev

# Build the project
npm run build

# Run tests
npm test

# Run tests with coverage
npm run test:coverage
```

## Acknowledgments

Special thanks to everyone who contributes to open source. Your efforts make projects like this possible.
