// Quick test of the scrapePlaylistEntries function without starting the whole server
const https = require('https');

function scrapePlaylistEntries(playlistUrl, startNum, endNum) {
  return new Promise((resolve, reject) => {
    const listMatch = playlistUrl.match(/[?&]list=([a-zA-Z0-9_-]+)/);
    if (!listMatch) return reject(new Error('Invalid playlist URL'));
    const listId = listMatch[1];

    const options = {
      hostname: 'www.youtube.com',
      path: `/playlist?list=${listId}&hl=en`,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      }
    };

    https.get(options, res => {
      console.log('HTTP Status:', res.statusCode);
      let html = '';
      res.on('data', chunk => html += chunk);
      res.on('end', () => {
        console.log('Page size:', html.length, 'bytes');

        const dataMatch = html.match(/var ytInitialData = ({.+?});<\/script>/s);
        if (!dataMatch) {
          console.log('ytInitialData NOT found, trying regex fallback...');
          const ids = [...html.matchAll(/"videoId":"([a-zA-Z0-9_-]{11})"/g)].map(m => m[1]);
          const titles = [...html.matchAll(/"title":\{"runs":\[\{"text":"([^"]+)"/g)].map(m => m[1]);
          const unique = [...new Set(ids)];
          console.log('Found IDs via regex:', unique.length);
          if (unique.length === 0) return reject(new Error('No videos found'));
          const entries = unique.slice(startNum - 1, endNum).map((id, i) => ({
            id, title: titles[i] || `Track_${i+1}`, url: `https://www.youtube.com/watch?v=${id}`
          }));
          return resolve(entries);
        }

        console.log('ytInitialData FOUND! Parsing...');
        const data = JSON.parse(dataMatch[1]);
        const contents = data?.contents?.twoColumnBrowseResultsRenderer
          ?.tabs?.[0]?.tabRenderer?.content
          ?.sectionListRenderer?.contents?.[0]
          ?.itemSectionRenderer?.contents?.[0]
          ?.playlistVideoListRenderer?.contents;

        if (!contents || !contents.length) {
          console.log('Structured contents not found, trying flat search...');
          const flatItems = [];
          JSON.stringify(data).replace(/"videoId":"([a-zA-Z0-9_-]{11})"/g, (_, id) => flatItems.push(id));
          const uniqueIds = [...new Set(flatItems)];
          console.log('Found IDs via flat search:', uniqueIds.length);
          const entries = uniqueIds.slice(startNum - 1, endNum).map((id, i) => ({
            id, title: `Track_${i+1}`, url: `https://www.youtube.com/watch?v=${id}`
          }));
          return resolve(entries);
        }

        const entries = contents
          .filter(c => c.playlistVideoRenderer)
          .slice(startNum - 1, endNum)
          .map(c => {
            const r = c.playlistVideoRenderer;
            const id = r.videoId;
            const title = r.title?.runs?.[0]?.text || `Track_${id}`;
            return { id, title, url: `https://www.youtube.com/watch?v=${id}` };
          });

        console.log('Found via structured contents:', entries.length);
        resolve(entries);
      });
    }).on('error', reject);
  });
}

scrapePlaylistEntries('https://www.youtube.com/playlist?list=PLyclUyUmwZJ8A1EomQmWaxPJB62jlPwx', 1, 5)
  .then(entries => {
    console.log('\n✅ SUCCESS! Entries:');
    entries.forEach((e, i) => console.log(`  ${i+1}. [${e.id}] ${e.title}`));
  })
  .catch(err => console.error('\n❌ FAILED:', err.message));
