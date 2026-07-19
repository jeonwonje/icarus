import { createServer } from 'node:http';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { google } from 'googleapis';

if (existsSync('.env')) process.loadEnvFile('.env');
const clientId = process.env.GCAL_CLIENT_ID;
const clientSecret = process.env.GCAL_CLIENT_SECRET;
if (!clientId || !clientSecret) {
  console.error('Set GCAL_CLIENT_ID and GCAL_CLIENT_SECRET in .env first (Google Cloud → OAuth desktop client).');
  process.exit(1);
}

const PORT = 8765;
const oauth2 = new google.auth.OAuth2(clientId, clientSecret, `http://127.0.0.1:${PORT}/oauth2callback`);
const url = oauth2.generateAuthUrl({
  access_type: 'offline',
  prompt: 'consent',
  scope: ['https://www.googleapis.com/auth/calendar'],
});

const server = createServer(async (req, res) => {
  const code = new URL(req.url!, `http://127.0.0.1:${PORT}`).searchParams.get('code');
  if (!code) {
    res.end('no code — try again');
    return;
  }
  const { tokens } = await oauth2.getToken(code);
  mkdirSync('state', { recursive: true });
  writeFileSync('state/gcal-token.json', JSON.stringify(tokens, null, 2));
  res.end('Calendar connected — you can close this tab.');
  console.log('token saved to state\\gcal-token.json');
  server.close();
  process.exit(0);
});
server.listen(PORT, '127.0.0.1', () => {
  console.log('Open this URL in your browser and approve access:\n\n' + url + '\n');
});
