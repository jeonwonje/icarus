import { existsSync, readFileSync } from 'node:fs';
import { google, type calendar_v3 } from 'googleapis';
import { cfg } from '../config.js';

export interface EventArgs {
  title: string;
  start: string; // ISO datetime, or YYYY-MM-DD for all-day
  end?: string;
  description?: string;
  location?: string;
}

const addDays = (day: string, n: number) => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

export function buildEventBody(args: EventArgs, tz: string): calendar_v3.Schema$Event {
  const body: calendar_v3.Schema$Event = { summary: args.title };
  if (args.description) body.description = args.description;
  if (args.location) body.location = args.location;
  if (args.start.length === 10) {
    body.start = { date: args.start };
    body.end = { date: addDays(args.end?.slice(0, 10) ?? args.start, 1) };
  } else {
    body.start = { dateTime: args.start, timeZone: tz };
    const end = args.end ?? new Date(new Date(args.start).getTime() + 60 * 60_000).toISOString();
    body.end = { dateTime: end, timeZone: tz };
  }
  return body;
}

export function calendarConfigured(): boolean {
  return !!(cfg.gcalClientId && cfg.gcalClientSecret && existsSync(cfg.gcalTokenPath));
}

export function getCalendar(): calendar_v3.Calendar {
  if (!calendarConfigured())
    throw new Error('calendar not configured — set GCAL_CLIENT_ID/GCAL_CLIENT_SECRET in .env and run `npm run gcal-login`');
  const oauth2 = new google.auth.OAuth2(cfg.gcalClientId, cfg.gcalClientSecret);
  oauth2.setCredentials(JSON.parse(readFileSync(cfg.gcalTokenPath, 'utf8')));
  return google.calendar({ version: 'v3', auth: oauth2 });
}
