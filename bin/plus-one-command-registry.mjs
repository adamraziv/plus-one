export const commandRegistry = Object.freeze([
  {
    id: 'status',
    help: [{ usage: 'status', description: 'Show gateway status.' }],
    matches: (argv) => argv.length === 1 && argv[0] === 'status',
    run: (_argv, context) => context.operations.status(),
  },
  {
    id: 'stop',
    help: [{ usage: 'stop', description: 'Stop the gateway.' }],
    matches: (argv) => argv.length === 1 && argv[0] === 'stop',
    run: (_argv, context) => context.operations.stop(),
  },
  {
    id: 'live',
    help: [{ usage: 'live', description: 'Open the operator console.' }],
    matches: (argv) => argv[0] === 'live',
    run: (_argv, context) => context.operations.live(),
  },
  {
    id: 'logs',
    help: [{ usage: 'logs [agent|errors|gateway] [options]', description: 'Inspect operational logs.' }],
    matches: (argv) => argv[0] === 'logs',
    run: (argv, context) => context.operations.logs(argv.slice(1)),
  },
  {
    id: 'telegram-pairing',
    help: [
      { usage: 'telegram pairing list-pending', description: 'List pending Telegram pairing requests.' },
      { usage: 'telegram pairing approve <code> --household <household_id>', description: 'Approve a Telegram pairing request.' },
      { usage: 'telegram pairing revoke <telegram_user_id>', description: 'Revoke a Telegram user.' },
    ],
    matches: (argv) => argv[0] === 'telegram' && argv[1] === 'pairing',
    run: (argv, context) => context.operations.telegramPairing(argv.slice(2)),
  },
  {
    id: 'foreground',
    help: [],
    matches: (argv) => argv.length === 1 && argv[0] === '--foreground',
    run: (_argv, context) => context.operations.foreground(),
  },
]);

export function isHelpRequest(argv) {
  return argv.length === 1 && (argv[0] === 'help' || argv[0] === '--help' || argv[0] === '-h');
}

export function renderHelp() {
  const lines = [
    'Usage: plus-one [command]',
    '',
    'Without a command, starts the gateway in the background.',
    '',
    'Commands:',
  ];
  for (const command of commandRegistry) {
    for (const entry of command.help) {
      lines.push(`  ${entry.usage}`);
      lines.push(`      ${entry.description}`);
    }
  }
  lines.push('', 'Options:', '  -h, --help', '      Show this help message.', '');
  return `${lines.join('\n')}`;
}
