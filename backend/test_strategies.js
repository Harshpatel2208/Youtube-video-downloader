// Test using different combos of yt-dlp to get playlist entries
const { spawn } = require('child_process');
const path = require('path');

const ytdlpBin = path.join(__dirname, 'node_modules', 'yt-dlp-exec', 'bin', 'yt-dlp.exe');

async function test(desc, args) {
  return new Promise((resolve) => {
    const proc = spawn(ytdlpBin, args);
    let output = '';
    let errors = '';
    
    proc.stdout.on('data', d => output += d.toString());
    proc.stderr.on('data', d => errors += d.toString());
    proc.on('close', code => {
      const errSnip = errors.slice(0, 200);
      console.log(`\n--- ${desc} ---`);
      console.log('Exit code:', code);
      if (output) console.log('Output:', output.slice(0, 300));
      if (errors) console.log('Errors:', errSnip);
      resolve({ code, output });
    });
  });
}

async function run() {
  const PL = 'https://www.youtube.com/playlist?list=PLyclUyUmwZJ8A1EomQmWaxPJB62jlPwx';

  // Strategy 1: --lazy-playlist
  await test('Strategy 1: --lazy-playlist + print', [
    PL, '--flat-playlist', '--lazy-playlist', '--playlist-items', '1-3', '--print', '%(id)s|||%(title)s', '--no-warnings'
  ]);

  // Strategy 2: TV client
  await test('Strategy 2: TV client', [
    PL, '--flat-playlist', '--playlist-items', '1-3', '--print', '%(id)s|||%(title)s', '--no-warnings',
    '--extractor-args', 'youtube:player_client=tv'
  ]);

  // Strategy 3: Mediaconnect client
  await test('Strategy 3: mweb client', [
    PL, '--flat-playlist', '--playlist-items', '1-3', '--print', '%(id)s|||%(title)s', '--no-warnings',
    '--extractor-args', 'youtube:player_client=mweb'
  ]);
}

run();
