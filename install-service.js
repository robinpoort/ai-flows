#!/usr/bin/env node
'use strict';

// Runs the AI Flows server as a macOS LaunchAgent: it starts at login and is
// restarted if it ever stops.
//   node install-service.js            install or update, and (re)start it
//   node install-service.js --remove   stop it and remove the LaunchAgent

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const LABEL = 'local.ai-flows';
const PLIST = path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
const LOG = path.join(os.homedir(), 'Library', 'Logs', 'ai-flows.log');
const PORT = process.env.PORT || '4777';
const domain = `gui/${process.getuid()}`;

// The node that runs this script, except that ServBay installs node per
// version and its "current" link survives upgrades.
function nodePath() {
  const servbay = '/Applications/ServBay/package/node/current/bin/node';
  if (process.execPath.includes('/ServBay/') && fs.existsSync(servbay)) return servbay;
  return process.execPath;
}

function launchctl(...args) {
  try { execFileSync('/bin/launchctl', args, { stdio: 'pipe' }); return true; } catch { return false; }
}

const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// bootout returns before launchd has let go of the job; a bootstrap right
// after it then fails. Wait until the job is really gone.
function stopService() {
  if (!launchctl('print', `${domain}/${LABEL}`)) return;
  launchctl('bootout', `${domain}/${LABEL}`);
  for (let i = 0; i < 50 && launchctl('print', `${domain}/${LABEL}`); i++) pause(100);
}

function startService() {
  for (let i = 0; i < 10; i++) {
    if (launchctl('bootstrap', domain, PLIST)) return true;
    pause(300);
  }
  return false;
}

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

if (process.argv.includes('--remove')) {
  stopService();
  if (fs.existsSync(PLIST)) fs.unlinkSync(PLIST);
  console.log('AI Flows-dienst gestopt en verwijderd.');
  process.exit(0);
}

const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${esc(nodePath())}</string>
    <string>${esc(path.join(__dirname, 'server.js'))}</string>
  </array>
  <key>WorkingDirectory</key><string>${esc(__dirname)}</string>
  <key>EnvironmentVariables</key>
  <dict><key>PORT</key><string>${esc(PORT)}</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${esc(LOG)}</string>
  <key>StandardErrorPath</key><string>${esc(LOG)}</string>
</dict>
</plist>
`;

fs.mkdirSync(path.dirname(PLIST), { recursive: true });
fs.writeFileSync(PLIST, plist);
stopService();
if (!startService()) {
  console.error(`Starten mislukt. Probeer: launchctl bootstrap ${domain} ${PLIST}`);
  process.exit(1);
}
console.log(`AI Flows draait nu als dienst op http://localhost:${PORT} en start voortaan bij het inloggen.`);
console.log(`Log: ${LOG}`);
