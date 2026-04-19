// Test: Can yt-dlp download a single track from a playlist URL without the broken flat-playlist metadata?
const { spawn } = require('child_process');
const path = require('path');
const ytdlpBin = path.join(__dirname, 'node_modules', 'yt-dlp-exec', 'bin', 'yt-dlp.exe');
const PL = 'https://www.youtube.com/playlist?list=PLyclUyUmwZJ8A1EomQmWaxPJB62jlPwx';

function downloadFromPlaylistItem(playlistUrl, index, outputTemplate) {
  return new Promise((resolve, reject) => {
    const args = [
      playlistUrl,
      '--no-warnings',
      '--playlist-items', String(index),
      '--extract-audio',
      '--audio-format', 'mp3',
      '--audio-quality', '0',
      '-o', outputTemplate,
    ];

    console.log('Downloading item', index, 'from playlist...');
    const proc = spawn(ytdlpBin, args);
    let out = '', err = '';
    proc.stdout.on('data', d => { out += d.toString(); process.stdout.write(d); });
    proc.stderr.on('data', d => { err += d.toString(); process.stderr.write(d); });
    proc.on('close', code => {
      if (code !== 0) return reject(new Error(err.slice(0, 300)));
      resolve({ code, output: out });
    });
  });
}

downloadFromPlaylistItem(PL, 1, 'test_pl_item1.mp3').then(r => {
  console.log('\n✅ SUCCESS! Exit:', r.code);
}).catch(err => {
  console.error('\n❌ FAILED:', err.message.slice(0, 300));
});
