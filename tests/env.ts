// Must be imported first before any src modules — ensures env defaults are set before config.ts evaluates.
process.env.TELEGRAM_BOT_TOKEN ??= 'test-token-0123456789';
process.env.TELEGRAM_OWNER_ID ??= '1';
process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token-0123456789';
// Pre-set so the machine's real .env (loadEnvFile never overrides) can't leak connectors into tests.
process.env.CANVAS_BASE_URL = '';
process.env.CANVAS_API_TOKEN = '';
