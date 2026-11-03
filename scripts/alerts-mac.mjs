// npm run alerts:on | alerts:off | alerts:status — runs the SFP alerts from
// this Mac with launchd, the Mac's own scheduler: at minute 55 and minute 0 of
// every hour, while you're logged in and the Mac is awake. It starts again by
// itself after a restart. The log is ~/Library/Logs/perp-dojo-alerts.log.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const LABEL = 'com.perpdojo.alerts';
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLIST = path.join(os.homedir(), 'Library/LaunchAgents', `${LABEL}.plist`);
const LOG = path.join(os.homedir(), 'Library/Logs/perp-dojo-alerts.log');
const domain = `gui/${process.getuid()}`;
const launchctl = (...a) => { try { return execFileSync('launchctl', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { return null; } };
const x = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const cmd = process.argv[2];
if (cmd === 'on') {
  if (!fs.existsSync(path.join(REPO, '.env'))) { console.log('No .env yet. Run npm run telegram first.'); process.exit(1); }
  const times = [];
  for (let h = 0; h < 24; h++) times.push({ h, m: 55 }, { h, m: 0 });
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${x(process.execPath)}</string>
    <string>--env-file=${x(path.join(REPO, '.env'))}</string>
    <string>${x(path.join(REPO, 'scripts/alerts.mjs'))}</string>
  </array>
  <key>WorkingDirectory</key><string>${x(REPO)}</string>
  <key>StartCalendarInterval</key>
  <array>
${times.map(t => `    <dict><key>Hour</key><integer>${t.h}</integer><key>Minute</key><integer>${t.m}</integer></dict>`).join('\n')}
  </array>
  <key>StandardOutPath</key><string>${x(LOG)}</string>
  <key>StandardErrorPath</key><string>${x(LOG)}</string>
</dict>
</plist>
`;
  fs.mkdirSync(path.dirname(PLIST), { recursive: true });
  launchctl('bootout', `${domain}/${LABEL}`);
  fs.writeFileSync(PLIST, plist);
  if (launchctl('bootstrap', domain, PLIST) === null) { console.log('launchctl couldn’t load the job. Try: launchctl bootstrap ' + domain + ' ' + PLIST); process.exit(1); }
  console.log(`SFP alerts are on. This Mac checks at minute 55 and minute 0 of every hour while it's awake.\nLog: ${LOG}`);
} else if (cmd === 'off') {
  launchctl('bootout', `${domain}/${LABEL}`);
  if (fs.existsSync(PLIST)) fs.unlinkSync(PLIST);
  console.log('SFP alerts from this Mac are off.');
} else {
  const loaded = launchctl('print', `${domain}/${LABEL}`) !== null;
  console.log(loaded ? 'SFP alerts from this Mac: on' : 'SFP alerts from this Mac: off');
  if (fs.existsSync(LOG)) console.log('\nLast runs:\n' + fs.readFileSync(LOG, 'utf8').trim().split('\n').filter(l => /UTC ·/.test(l)).slice(-8).join('\n'));
}
