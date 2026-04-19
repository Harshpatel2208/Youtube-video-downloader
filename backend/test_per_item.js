// The REAL fix: 
// yt-dlp CAN download individual items from a playlist using --playlist-items
// but ONLY when fetching metadata for a single item, not the whole list.
// Let's test fetching item by item.

const { spawn } = require('child_process');
const path = require('path');
const ytdlpBin = path.join(__dirname, 'node_modules', 'yt-dlp-exec', 'bin', 'yt-dlp.exe');
const PL = 'https://www.youtube.com/playlist?list=PLyclUyUmwZJ8A1EomQmWaxPJB62jlPwx';

function getVideoAtIndex(playlistUrl, index) {
  return new Promise((resolve) => {
    const args = [
      playlistUrl,
      '--no-warnings',
      '--playlist-items', String(index),
      '--print', 'id\t%(title)s',
      '--flat-playlist'
    ];

    const proc = spawn(ytdlpBin, args);
    let out = '', err = '';
    proc.stdout.on('data', d => out += d.toString());
    proc.stderr.on('data', d => err += d.toString());
    proc.on('close', code => {
      if (code !== 0 || !out.trim()) {
        console.log(`Item ${index}: FAILED - ${err.slice(0, 100)}`);
        resolve(null);
      } else {
        const line = out.trim().split('\n')[0];
        const [id, ...titleParts] = line.split('\t');
        resolve({ id, title: titleParts.join('\t'), url: `https://www.youtube.com/watch?v=${id}` });
      }
    });
  });
}

// Test fetching just item 1 from the playlist
getVideoAtIndex(PL, 1).then(entry => {
  console.log('Item 1:', entry);
}).catch(console.error);
