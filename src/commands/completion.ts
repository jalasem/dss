import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import { select } from '@inquirer/prompts';
import { UIHelper } from './ui';
import { safeConfirm } from './prompts';

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

  const saveScript = await safeConfirm({
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
    local cur prev command opts
    COMPREPLY=()
    cur="\${COMP_WORDS[COMP_CWORD]}"
    prev="\${COMP_WORDS[COMP_CWORD-1]}"
    command="\${COMP_WORDS[1]}"

    # Main commands
    opts="ls use new edit rm link unlink key config completion test inspect status --help --version -h -v"

    # Get space names for relevant commands
    if [[ \$cur != -* && (\$prev == "use" || \$prev == "rm" || \$prev == "edit" || \$prev == "test" || \$prev == "inspect" || \$prev == "link") ]]; then
        local spaces
        if [ -f ~/.dss/spaces/config.json ]; then
            spaces=$(cat ~/.dss/spaces/config.json | grep -o '"name": *"[^"]*"' | cut -d'"' -f4 | tr '\n' ' ')
            COMPREPLY=( $(compgen -W "\$spaces" -- \$cur) )
            return 0
        fi
    fi

    # Options for specific commands
    case \$command in
        link)
            if [[ \$cur == -* ]]; then
                opts="-p --path -r --recursive --dry-run"
            fi
            ;;
        unlink)
            if [[ \$cur == -* ]]; then
                opts="-p --path --dry-run"
            fi
            ;;
        status)
            if [[ \$cur == -* ]]; then
                opts="-p --path"
            fi
            ;;
        use|rm)
            opts="$opts --dry-run"
            ;;
        key)
            opts="show copy rotate"
            ;;
        config)
            opts="export import"
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
        'new:Create a new development space'
        'ls:List all development spaces'
        'use:Switch to a specified space'
        'rm:Remove a specified space'
        'edit:Modify an existing space'
        'test:Test GitHub access for current space'
        'inspect:Show detailed information about a space'
        'link:Link a space to one or more Git repositories'
        'unlink:Remove the DSS link from a Git repository'
        'status:Show repository-local DSS binding status'
        'key:Manage SSH keys for an identity (show, copy, rotate)'
        'config:Manage DSS configuration (export, import)'
        'completion:Generate shell completion script'
        '--help:Show help information'
        '--version:Show version information'
    )

    # Get space names
    if [[ -f ~/.dss/spaces/config.json ]]; then
        spaces=($(grep -o '"name": *"[^"]*"' ~/.dss/spaces/config.json | cut -d'"' -f4))
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
                use|rm|edit|test|inspect)
                    _describe 'spaces' spaces
                    ;;
                link)
                    if [[ $CURRENT -eq 3 && \${words[CURRENT]} != -* ]]; then
                        _describe 'spaces' spaces
                    else
                        _values 'link options' \
                            '-p[Bind an explicit Git repository]' \
                            '--path[Bind an explicit Git repository]' \
                            '-r[Bind repositories beneath a parent directory]' \
                            '--recursive[Bind repositories beneath a parent directory]' \
                            '--dry-run[Preview changes without applying them]'
                    fi
                    ;;
                unlink)
                    _values 'unlink options' \
                        '-p[Select an explicit Git repository]' \
                        '--path[Select an explicit Git repository]' \
                        '--dry-run[Preview changes without applying them]'
                    ;;
                status)
                    _values 'status options' \
                        '-p[Select an explicit Git repository]' \
                        '--path[Select an explicit Git repository]'
                    ;;
                key)
                    _values 'key actions' 'show' 'copy' 'rotate'
                    ;;
                config)
                    _values 'config actions' 'export' 'import'
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
        cat ~/.dss/spaces/config.json | grep -o '"name": *"[^"]*"' | cut -d'"' -f4
    end
end

# Main completion function
complete -c dss -f

# Commands
complete -c dss -n '__fish_use_subcommand' -a 'new' -d 'Create a new development space'
complete -c dss -n '__fish_use_subcommand' -a 'ls' -d 'List all development spaces'
complete -c dss -n '__fish_use_subcommand' -a 'use' -d 'Switch to a specified space'
complete -c dss -n '__fish_use_subcommand' -a 'rm' -d 'Remove a specified space'
complete -c dss -n '__fish_use_subcommand' -a 'edit' -d 'Modify an existing space'
complete -c dss -n '__fish_use_subcommand' -a 'test' -d 'Test GitHub access for current space'
complete -c dss -n '__fish_use_subcommand' -a 'inspect' -d 'Show detailed information about a space'
complete -c dss -n '__fish_use_subcommand' -a 'link' -d 'Link a space to one or more Git repositories'
complete -c dss -n '__fish_use_subcommand' -a 'unlink' -d 'Remove the DSS link from a Git repository'
complete -c dss -n '__fish_use_subcommand' -a 'status' -d 'Show repository-local DSS binding status'
complete -c dss -n '__fish_use_subcommand' -a 'key' -d 'Manage SSH keys for an identity (show, copy, rotate)'
complete -c dss -n '__fish_use_subcommand' -a 'config' -d 'Manage DSS configuration (export, import)'
complete -c dss -n '__fish_use_subcommand' -a 'completion' -d 'Generate shell completion script'

# Global options
complete -c dss -n '__fish_use_subcommand' -l help -s h -d 'Show help information'
complete -c dss -n '__fish_use_subcommand' -l version -s v -d 'Show version information'

# Space name completions for relevant commands
complete -c dss -n '__fish_seen_subcommand_from use rm edit test inspect link' -a '(__dss_get_spaces)'

# Options for specific commands
complete -c dss -n '__fish_seen_subcommand_from use rm' -l dry-run -d 'Preview changes without applying them'
complete -c dss -n '__fish_seen_subcommand_from link' -s p -l path -r -d 'Bind an explicit Git repository (--path)'
complete -c dss -n '__fish_seen_subcommand_from link' -s r -l recursive -d 'Bind repositories beneath a parent directory (--recursive)'
complete -c dss -n '__fish_seen_subcommand_from link' -l dry-run -d 'Preview changes without applying them (--dry-run)'
complete -c dss -n '__fish_seen_subcommand_from unlink' -s p -l path -r -d 'Select an explicit Git repository (--path)'
complete -c dss -n '__fish_seen_subcommand_from unlink' -l dry-run -d 'Preview changes without applying them (--dry-run)'
complete -c dss -n '__fish_seen_subcommand_from status' -s p -l path -r -d 'Select an explicit Git repository (--path)'

# Actions for key command
complete -c dss -n '__fish_seen_subcommand_from key' -a 'show copy rotate' -d 'Key action'

# Actions for config command
complete -c dss -n '__fish_seen_subcommand_from config' -a 'export import' -d 'Config action'

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
