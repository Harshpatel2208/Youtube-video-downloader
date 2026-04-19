const http = require('http');

const data = JSON.stringify({
  playlistUrl: 'https://www.youtube.com/playlist?list=PLyclUyUmwZJ8A1EomQmWaxPJB62jlPwx',
  start: 1, end: 50
});

const req = http.request({
  hostname: 'localhost',
  port: 3000,
  path: '/youtube-playlist',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(data)
  }
}, (res) => {
  let body = '';
  res.on('data', d => body += d);
  res.on('end', () => console.log('STATUS:', res.statusCode, 'BODY:', body));
});

req.on('error', (e) => console.error(e));
req.write(data);
req.end();
