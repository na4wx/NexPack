#!/usr/bin/env node
const { spawnSync } = require('child_process');
const path = require('path');

const files = [
  'test_kiss_port_nibble.js',
  'test_terminal_kisstcp.js',
  'test_terminal_serial.js',
  'test_terminal_agwpe.js',
  'test_terminal_digipath.js',
  'test_terminal_sabm_retry.js',
  'test_terminal_iframe_reliability.js',
  'test_terminal_line_termination.js',
  'test_terminal_logging.js',
  'test_terminal_yapp.js',
  'test_terminal_scripts.js',
  'test_rf_bbs_client.js',
  'test_winlink_orphan_reap.js',
  'test_winlink_connect_guard.js',
  'test_winlink_start_race.js',
  'test_winlink_settings_restart.js',
  'test_winlink_spawn_error.js',
  'test_aprs_parser.js',
  'test_aprs_manager_rf.js',
  'test_aprs_manager_tx.js'
];

let failed = 0;
for (const f of files) {
  console.log(`\n=== ${f} ===`);
  const res = spawnSync(process.execPath, [path.join(__dirname, f)], { stdio: 'inherit' });
  if (res.status !== 0) failed++;
}

console.log(`\n${files.length - failed}/${files.length} test files passed`);
process.exit(failed > 0 ? 1 : 0);
