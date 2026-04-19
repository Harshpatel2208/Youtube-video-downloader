// Test using yt-dlp to enumerate playlist in batches using --no-playlist-metadata
// This avoids the playlist's main browse API call and uses the video-level APIs instead
const { spawn } = require('child_process');
const path = require('path');

const ytdlpBin = path.join(__dirname, 'node_modules', 'yt-dlp-exec', 'bin', 'yt-dlp.exe');

function getPlaylistEntries(playlistUrl, start, end) {
  return new Promise((resolve, reject) => {
    const args = [
      playlistUrl,
      '--flat-playlist',
      '--no-warnings',
      '--playlist-start', String(start),
      '--playlist-end', String(end),
      '--print', '%(id)s\t%(title)s',
      '--skip-download',
      '--no-playlist-metadata'
    ];
    
    console.log('Running:', ytdlpBin, args.join(' '));
    
    const proc = spawn(ytdlpBin, args);
    let output = '';
    let errors = '';
    
    proc.stdout.on('data', d => output += d.toString());
    proc.stderr.on('data', d => errors += d.toString());
    proc.on('close', code => {
      console.log('Exit code:', code);
      console.log('Errors:', errors.slice(0, 500));
      console.log('Output:', output.slice(0, 500));
      if (code !== 0) reject(new Error(errors));
      const entries = output.trim().split('\n').filter(Boolean).map(line => {
        const [id, ...titleParts] = line.split('\t');
        return { id, title: titleParts.join('\t') };
      });
      resolve(entries);
    });
  });
}

getPlaylistEntries('https://www.youtube.com/playlist?list=PLyclUyUmwZJ8A1EomQmWaxPJB62jlPwx', 1, 3)
  .then(entries => {
    console.log('Resolved:', entries);
  })
  .catch(err => console.error('Failed:', err.message?.slice(0, 300)));
