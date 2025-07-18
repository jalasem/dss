import chalk from 'chalk';

export class UIHelper {
  static success(message: string): void {
    console.log(chalk.green(`✅ ${message}`));
  }

  static error(message: string): void {
    console.log(chalk.red(`❌ ${message}`));
  }

  static warning(message: string): void {
    console.log(chalk.yellow(`⚠️  ${message}`));
  }

  static info(message: string): void {
    console.log(chalk.blue(`ℹ️  ${message}`));
  }

  static highlight(text: string): string {
    return chalk.cyan(text);
  }

  static dim(text: string): string {
    return chalk.dim(text);
  }

  static bold(text: string): string {
    return chalk.bold(text);
  }

  static activeSpace(name: string): string {
    return chalk.green(`🔥 ${name}`);
  }

  static inactiveSpace(name: string): string {
    return chalk.white(name);
  }

  static spaceName(name: string, isActive: boolean = false): string {
    return isActive ? this.activeSpace(name) : this.inactiveSpace(name);
  }

  static command(cmd: string): string {
    return chalk.cyan(`\`${cmd}\``);
  }

  static filename(path: string): string {
    return chalk.magenta(path);
  }

  static url(url: string): string {
    return chalk.blue.underline(url);
  }

  static printSeparator(): void {
    console.log(chalk.gray('─'.repeat(60)));
  }

  static printHeader(title: string): void {
    console.log(chalk.bold.cyan(`\n${title}`));
    this.printSeparator();
  }

  static printSpaceTable(spaces: Array<{ name: string; email: string; userName: string; sshKeyPath: string }>, activeSpace?: string): void {
    if (spaces.length === 0) {
      this.warning('No spaces have been added yet.');
      return;
    }

    // Calculate column widths
    const nameWidth = Math.max(4, ...spaces.map(s => s.name.length + (s.name === activeSpace ? 3 : 0)));
    const emailWidth = Math.max(5, ...spaces.map(s => s.email.length));
    const userWidth = Math.max(9, ...spaces.map(s => s.userName.length));

    // Print header
    const header = `│ ${chalk.bold('Name'.padEnd(nameWidth))} │ ${chalk.bold('Email'.padEnd(emailWidth))} │ ${chalk.bold('User Name'.padEnd(userWidth))} │`;
    const separator = `├${'─'.repeat(nameWidth + 2)}┼${'─'.repeat(emailWidth + 2)}┼${'─'.repeat(userWidth + 2)}┤`;
    const topBorder = `┌${'─'.repeat(nameWidth + 2)}┬${'─'.repeat(emailWidth + 2)}┬${'─'.repeat(userWidth + 2)}┐`;
    const bottomBorder = `└${'─'.repeat(nameWidth + 2)}┴${'─'.repeat(emailWidth + 2)}┴${'─'.repeat(userWidth + 2)}┘`;

    console.log(chalk.gray(topBorder));
    console.log(header);
    console.log(chalk.gray(separator));

    // Print spaces
    spaces.forEach(space => {
      const displayName = space.name === activeSpace 
        ? this.activeSpace(space.name)
        : this.inactiveSpace(space.name);
      
      const row = `│ ${displayName.padEnd(nameWidth + (space.name === activeSpace ? 10 : 0))} │ ${space.email.padEnd(emailWidth)} │ ${space.userName.padEnd(userWidth)} │`;
      console.log(row);
    });

    console.log(chalk.gray(bottomBorder));
  }

  static printProgress(message: string): void {
    process.stdout.write(chalk.yellow(`⏳ ${message}...`));
  }

  static clearProgress(): void {
    process.stdout.write('\r' + ' '.repeat(80) + '\r');
  }

  static printKeyInstruction(): void {
    console.log(chalk.dim('\n💡 Tips:'));
    console.log(chalk.dim('  • Use arrow keys to navigate'));
    console.log(chalk.dim('  • Press Enter to select'));
    console.log(chalk.dim('  • Press Ctrl+C to cancel'));
  }

  static printSuccessBox(title: string, content: string[]): void {
    const maxWidth = Math.max(title.length, ...content.map(line => line.length));
    const width = Math.max(maxWidth + 4, 40);
    
    console.log(chalk.green('╔' + '═'.repeat(width - 2) + '╗'));
    console.log(chalk.green('║') + chalk.green.bold(title.padStart((width + title.length) / 2).padEnd(width - 2)) + chalk.green('║'));
    console.log(chalk.green('╠' + '═'.repeat(width - 2) + '╣'));
    
    content.forEach(line => {
      console.log(chalk.green('║') + ` ${line}`.padEnd(width - 2) + chalk.green('║'));
    });
    
    console.log(chalk.green('╚' + '═'.repeat(width - 2) + '╝'));
  }
}