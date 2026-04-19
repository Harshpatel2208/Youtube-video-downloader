const youtubedl = require('yt-dlp-exec');

youtubedl('https://www.youtube.com/playlist?list=PLyclUyUmwZJ8A1EomQmWaxPJB62jlPwx', {
  dumpSingleJson: true,
  flatPlaylist: true,
  playlistItems: '1-5'
}).then(output => console.log('Success!', output.title, output.entries?.length))
  .catch(err => console.error('YT-DLP Error:', err.message));
