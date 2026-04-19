const youtubedl = require('yt-dlp-exec');

async function test() {
  try {
    console.log('Starting yt-dlp test...');
    await youtubedl('https://www.youtube.com/watch?v=dQw4w9WgXcQ', {
      extractAudio: true,
      audioFormat: 'mp3',
      audioQuality: 0,
      output: 'test_output.mp3',
      noPlaylist: true,
      extractorArgs: 'youtube:player_client=web,default'
    });
    console.log('Success!');
  } catch (err) {
    console.error('Download failed!');
    console.error(err.message);
  }
}

test();
