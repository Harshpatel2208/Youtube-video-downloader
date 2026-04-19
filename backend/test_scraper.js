const https = require('https');

const options = {
  hostname: 'www.youtube.com',
  path: '/playlist?list=PLyclUyUmwZJ8A1EomQmWaxPJB62jlPwx',
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept': 'text/html,application/xhtml+xml'
  }
};

https.get(options, res => {
  let data = '';
  res.on('data', d => data += d);
  res.on('end', () => {
    // Unique video IDs
    const allMatches = Array.from(data.matchAll(/"videoId":"([a-zA-Z0-9_-]{11})"/g));
    const uniqueIds = [...new Set(allMatches.map(m => m[1]))];
    
    // Title matches
    const titleMatches = Array.from(data.matchAll(/"title":\{"runs":\[\{"text":"([^"]+)"/g));
    
    console.log('Status:', res.statusCode);
    console.log('Location:', res.headers['location'] || 'none');
    console.log('IDs found:', uniqueIds.length);
    
    if (uniqueIds.length > 0) {
      uniqueIds.slice(0, 5).forEach((id, i) => {
        console.log(`${i+1}. ${id} -> ${titleMatches[i] ? titleMatches[i][1] : 'N/A'}`);
      });
    } else {
      console.log('Page size:', data.length + ' bytes');
      console.log('Redirect or blocked?', data.slice(0, 500));
    }
  });
}).on('error', console.error);
