# Dev Spaces Switcher (DSS)

Dev Spaces Switcher (DSS) is a CLI tool designed to help developers switch between different contexts seamlessly when working across various environments or companies, without having to worry about SSH or GitHub configurations manually.

## Features

- **Create and Manage Spaces**: Easily create and manage isolated workspaces for different projects.
- **SSH Key Management**: Automatically generate and switch SSH keys when changing spaces.
- **GitHub Configuration**: Streamline GitHub user configuration for each space.
- **CLI-Based**: Simple and intuitive command-line interface.

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

## Contributing

Contributions are welcome! Please feel free to submit pull requests or create issues for bugs, questions, and feature requests.

## Acknowledgments

Special thanks to everyone who contributes to open source. Your efforts make projects like this possible.
