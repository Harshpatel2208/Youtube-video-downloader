const youtubedl = require('yt-dlp-exec');

youtubedl('https://www.youtube.com/watch?v=dQw4w9WgXcQ', {
  dumpJson: true,
  noWarnings: true
}).then(output => console.log('Title:', output.title)).catch(err => console.error('Error:', err.message));
