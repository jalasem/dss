import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import { select, confirm } from '@inquirer/prompts';
import { UIHelper } from './ui';
// import { IConfig } from './types';

// const configPath = path.join(os.homedir(), '.dss', 'spaces', 'config.json');

export async function generateCompletionScript(shell?: string): Promise<void> {
  UIHelper.printHeader('Shell Completion Setup');
  
  let selectedShell = shell;
  if (!selectedShell) {
    selectedShell = await select({
      message: 'Select your shell:',
      choices: [
        { name: 'Bash', value: 'bash' },
        { name: 'Zsh', value: 'zsh' },
        { name: 'Fish', value: 'fish' }
      ]
    });
  }

  const completionScript = generateScript(selectedShell);
  
  if (!completionScript) {
    UIHelper.error(`Completion script for ${selectedShell} is not supported yet.`);
    return;
  }

  UIHelper.printInfoBox('Completion Script Generated', [
    `Generated completion script for ${selectedShell}`,
    'Copy the script below to enable auto-completion',
    '',
    'Installation instructions will be shown after the script'
  ]);

  console.log('\n' + UIHelper.dim('--- Completion Script ---'));
  console.log(completionScript);
  console.log(UIHelper.dim('--- End of Script ---\n'));

  // Show installation instructions
  showInstallationInstructions(selectedShell);

  const saveScript = await confirm({
    message: 'Would you like to save this script to a file?',
    default: true
  });

  if (saveScript) {
    const scriptPath = path.join(os.homedir(), `dss-completion.${selectedShell}`);
    await fs.writeFile(scriptPath, completionScript);
    UIHelper.success(`Completion script saved to: ${UIHelper.filename(scriptPath)}`);
    
    UIHelper.printInfoBox('Next Steps', [
      `1. Source the script in your ${selectedShell} configuration:`,
      `   source ${scriptPath}`,
      '',
      '2. Or follow the installation instructions above',
      '3. Restart your terminal or run the source command',
      '4. Try: dss <TAB> to see available commands'
    ]);
  }
}

function generateScript(shell: string): string | null {
  switch (shell) {
    case 'bash':
      return generateBashScript();
    case 'zsh':
      return generateZshScript();
    case 'fish':
      return generateFishScript();
    default:
      return null;
  }
}

function generateBashScript(): string {
  /* eslint-disable no-useless-escape */
  return `#!/bin/bash
# DSS (Dev Spaces Switcher) Bash Completion Script

_dss_completion() {
    local cur prev opts
    COMPREPLY=()
    cur="\${COMP_WORDS[COMP_CWORD]}"
    prev="\${COMP_WORDS[COMP_CWORD-1]}"
    
    # Main commands
    opts="add list switch remove edit test inspect onboard batch export import bulk completion --help --version -h -v"
    
    # Get space names for relevant commands
    if [[ \$prev == "switch" || \$prev == "remove" || \$prev == "edit" || \$prev == "test" || \$prev == "inspect" ]]; then
        local spaces
        if [ -f ~/.dss/spaces/config.json ]; then
            spaces=$(cat ~/.dss/spaces/config.json | grep -o '"name":"[^"]*"' | cut -d'"' -f4 | tr '\n' ' ')
            COMPREPLY=( $(compgen -W "\$spaces" -- \$cur) )
            return 0
        fi
    fi
    
    # Options for specific commands
    case \$prev in
        switch|remove|bulk)
            opts="$opts --dry-run"
            ;;
        completion)
            opts="bash zsh fish"
            ;;
    esac
    
    COMPREPLY=( $(compgen -W "\$opts" -- \$cur) )
    return 0
}

complete -F _dss_completion dss
`;
  /* eslint-enable no-useless-escape */
}

function generateZshScript(): string {
   
  return `#!/bin/zsh
# DSS (Dev Spaces Switcher) Zsh Completion Script

_dss() {
    local context state state_descr line
    local -a commands spaces
    
    commands=(
        'add:Create a new development space'
        'list:List all development spaces'
        'switch:Switch to a specified space'
        'remove:Remove a specified space'
        'edit:Modify an existing space'
        'test:Test GitHub access for current space'
        'inspect:Show detailed information about a space'
        'onboard:Interactive onboarding for new users'
        'batch:Switch between multiple spaces'
        'export:Export space configuration'
        'import:Import space configuration'
        'bulk:Bulk update operations'
        'completion:Generate shell completion script'
        '--help:Show help information'
        '--version:Show version information'
    )
    
    # Get space names
    if [[ -f ~/.dss/spaces/config.json ]]; then
        spaces=(\\$(echo "dummy"))
    fi
    
    _arguments -C \\
        '1: :->command' \
        '*: :->args' && return 0
    
    case $state in
        command)
            _describe 'commands' commands
            ;;
        args)
            case $words[2] in
                switch|remove|edit|test|inspect)
                    _describe 'spaces' spaces
                    ;;
                completion)
                    _values 'shell' 'bash' 'zsh' 'fish'
                    ;;
            esac
            ;;
    esac
}

compdef _dss dss
`;
   
}

function generateFishScript(): string {
   
  return `#!/usr/bin/env fish
# DSS (Dev Spaces Switcher) Fish Completion Script

# Function to get space names
function __dss_get_spaces
    if test -f ~/.dss/spaces/config.json
        cat ~/.dss/spaces/config.json | grep -o '"name":"[^"]*"' | cut -d'"' -f4
    end
end

# Main completion function
complete -c dss -f

# Commands
complete -c dss -n '__fish_use_subcommand' -a 'add' -d 'Create a new development space'
complete -c dss -n '__fish_use_subcommand' -a 'list' -d 'List all development spaces'
complete -c dss -n '__fish_use_subcommand' -a 'switch' -d 'Switch to a specified space'
complete -c dss -n '__fish_use_subcommand' -a 'remove' -d 'Remove a specified space'
complete -c dss -n '__fish_use_subcommand' -a 'edit' -d 'Modify an existing space'
complete -c dss -n '__fish_use_subcommand' -a 'test' -d 'Test GitHub access for current space'
complete -c dss -n '__fish_use_subcommand' -a 'inspect' -d 'Show detailed information about a space'
complete -c dss -n '__fish_use_subcommand' -a 'onboard' -d 'Interactive onboarding for new users'
complete -c dss -n '__fish_use_subcommand' -a 'batch' -d 'Switch between multiple spaces'
complete -c dss -n '__fish_use_subcommand' -a 'export' -d 'Export space configuration'
complete -c dss -n '__fish_use_subcommand' -a 'import' -d 'Import space configuration'
complete -c dss -n '__fish_use_subcommand' -a 'bulk' -d 'Bulk update operations'
complete -c dss -n '__fish_use_subcommand' -a 'completion' -d 'Generate shell completion script'

# Global options
complete -c dss -n '__fish_use_subcommand' -l help -s h -d 'Show help information'
complete -c dss -n '__fish_use_subcommand' -l version -s v -d 'Show version information'

# Space name completions for relevant commands
complete -c dss -n '__fish_seen_subcommand_from switch remove edit test inspect' -a '(__dss_get_spaces)'

# Options for specific commands
complete -c dss -n '__fish_seen_subcommand_from switch remove bulk' -l dry-run -d 'Preview changes without applying them'

# Shell completions for completion command
complete -c dss -n '__fish_seen_subcommand_from completion' -a 'bash zsh fish' -d 'Shell type'
`;
   
}

function showInstallationInstructions(shell: string): void {
  UIHelper.printHeader('Installation Instructions');
  
  switch (shell) {
    case 'bash':
      UIHelper.printInfoBox('Bash Installation', [
        '1. Add to ~/.bashrc or ~/.bash_profile:',
        '   source /path/to/dss-completion.bash',
        '',
        '2. Or copy to system completion directory:',
        '   sudo cp dss-completion.bash /etc/bash_completion.d/',
        '',
        '3. Restart your terminal or run:',
        '   source ~/.bashrc'
      ]);
      break;
      
    case 'zsh':
      UIHelper.printInfoBox('Zsh Installation', [
        '1. Add to ~/.zshrc:',
        '   source /path/to/dss-completion.zsh',
        '',
        '2. Or copy to zsh completion directory:',
        '   cp dss-completion.zsh ~/.oh-my-zsh/completions/_dss',
        '',
        '3. Restart your terminal or run:',
        '   source ~/.zshrc'
      ]);
      break;
      
    case 'fish':
      UIHelper.printInfoBox('Fish Installation', [
        '1. Copy to fish completion directory:',
        '   cp dss-completion.fish ~/.config/fish/completions/',
        '',
        '2. Or manually load:',
        '   source dss-completion.fish',
        '',
        '3. Restart your terminal or run:',
        '   fish'
      ]);
      break;
  }
}