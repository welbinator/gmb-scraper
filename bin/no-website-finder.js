#!/usr/bin/env node
'use strict';

const { execSync, spawn } = require('child_process');
const path = require('path');

const APP_DIR = path.join(__dirname, '..');
const APP_NAME = 'no-website-finder';
const PORT = 3056;

const [,, cmd = 'start'] = process.argv;

function pm2(...args) {
  try {
    execSync(`pm2 ${args.join(' ')}`, { stdio: 'inherit', cwd: APP_DIR });
  } catch {}
}

switch (cmd) {
  case 'start':
    pm2(`start server.js --name ${APP_NAME} --cwd ${APP_DIR}`);
    console.log(`\n✅ No-Website Finder running at http://localhost:${PORT}`);
    break;
  case 'stop':
    pm2(`stop ${APP_NAME}`);
    pm2(`delete ${APP_NAME}`);
    break;
  case 'status':
    pm2(`status ${APP_NAME}`);
    break;
  case 'logs':
    pm2(`logs ${APP_NAME}`);
    break;
  default:
    console.log('Usage: no-website-finder [start|stop|status|logs]');
}
