'use strict';

/**
 * server.js — M4A → MP3 Converter Backend
 *
 * Routes:
 *   POST /convert          – upload ≤50 .m4a files (field: "files")
 *   GET  /conversions      – list all records (newest first)
 *   GET  /conversions/:id  – single record by UUID
 *   GET  /converted/<file> – download a converted MP3
 *   GET  /health           – liveness check
 */

require('dotenv').config();

const express   = require('express');
const cors      = require('cors');
const multer    = require('multer');
const ffmpeg    = require('fluent-ffmpeg');
const archiver  = require('archiver');
const youtubedl = require('yt-dlp-exec');
const path      = require('path');
const fs        = require('fs');
const { Pool }  = require('pg');

// ─────────────────────────────────────────────────────────────────────────────
// 0.  Optional: point fluent-ffmpeg at a custom FFmpeg binary
// ─────────────────────────────────────────────────────────────────────────────
if (process.env.FFMPEG_PATH) {
  ffmpeg.setFfmpegPath(process.env.FFMPEG_PATH);
}

// ─────────────────────────────────────────────────────────────────────────────
// 1.  Ensure upload / converted directories exist
// ─────────────────────────────────────────────────────────────────────────────
const UPLOADS_DIR   = path.join(__dirname, 'uploads');
const CONVERTED_DIR = path.join(__dirname, 'converted');

[UPLOADS_DIR, CONVERTED_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2.  PostgreSQL connection pool
// ─────────────────────────────────────────────────────────────────────────────
const db = new Pool({
  host:     process.env.DB_HOST     || 'localhost',
  port:     parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME     || 'converter_db',
  user:     process.env.DB_USER     || 'postgres',
  password: process.env.DB_PASSWORD || '',
});

db.on('error', err => console.error('[DB] Pool error:', err.message));

// ─────────────────────────────────────────────────────────────────────────────
// 3.  Sanitize filenames & Multer config
// ─────────────────────────────────────────────────────────────────────────────

function sanitizeFilename(name) {
  return name
    .replace(/[^a-zA-Z0-9 ._-]/g, '_')  // replace special chars with _
    .replace(/_{2,}/g, '_')              // collapse multiple underscores
    .replace(/^[_\s]+|[_\s]+$/g, '')    // trim leading/trailing _ and spaces
    .substring(0, 180);                  // cap length
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
  filename:    (_req, file, cb) => {
    // Multer uses latin1 for headers, which breaks UTF-8/Cyrillic characters. Convert it back:
    file.originalname = Buffer.from(file.originalname, 'latin1').toString('utf8');
    
    const stamp  = `${Date.now()}-${Math.round(Math.random() * 1e6)}`;
    const safeBase = sanitizeFilename(path.basename(file.originalname, path.extname(file.originalname)));
    cb(null, `${stamp}-${safeBase}.m4a`);
  },
});

const fileFilter = (_req, file, cb) => {
  if (path.extname(file.originalname).toLowerCase() === '.m4a') {
    cb(null, true);
  } else {
    cb(new Error(`Only .m4a files are accepted — got: ${file.originalname}`), false);
  }
};

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 300 * 1024 * 1024 }, // 300 MB per file
}).array('files', 50);

// ─────────────────────────────────────────────────────────────────────────────
// 4.  Concurrency-limited queue
//     Converts files in parallel up to CONCURRENCY at a time so the server
//     stays responsive even when 50 files are queued simultaneously.
// ─────────────────────────────────────────────────────────────────────────────
// 4a. Reset orphaned jobs on startup and set Concurrency
// ─────────────────────────────────────────────────────────────────────────────
const CONCURRENCY = parseInt(process.env.CONCURRENCY || '3', 10);

db.query(
  `UPDATE conversions 
      SET status = 'failed', error = 'Server restarted' 
    WHERE status IN ('pending', 'processing')`
).then(res => {
  if (res.rowCount > 0) console.log(`[Startup] Failed ${res.rowCount} orphaned job(s) from previous run.`);
}).catch(err => console.error('[Startup] DB reset error:', err.message));

/**
 * runWithConcurrency
 * @param {Array<() => Promise<any>>} tasks   Array of async factory functions
 * @param {number}                   limit   Max parallel runners
 * @returns {Promise<any[]>}                 Results in original order
 */
async function runWithConcurrency(tasks, limit) {
  const results = new Array(tasks.length);
  let   index   = 0;

  async function worker() {
    while (index < tasks.length) {
      const i = index++;          // capture slot before awaiting
      results[i] = await tasks[i]();
    }
  }

  // Spin up `limit` parallel workers
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, worker);
  await Promise.all(workers);
  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// 5.  DB helpers
// ─────────────────────────────────────────────────────────────────────────────
async function createRecord(originalName, source = 'local', sourceUrl = null) {
  const { rows } = await db.query(
    `INSERT INTO conversions (original_name, status, source, source_url)
     VALUES ($1, 'pending', $2, $3)
     RETURNING id`,
    [originalName, source, sourceUrl]
  );
  return rows[0].id;
}

/**
 * Checks if we already have an active/completed conversion for this URL.
 * Returns the record if found, otherwise null.
 */
async function findActiveRecordByUrl(url) {
  const { rows } = await db.query(
    `SELECT id, original_name, status, download_url, error 
       FROM conversions 
      WHERE source_url = $1 
        AND status NOT IN ('failed', 'expired')
      ORDER BY created_at DESC LIMIT 1`,
    [url]
  );
  return rows.length > 0 ? rows[0] : null;
}

async function updateRecord(id, status, downloadUrl = null, error = null) {
  await db.query(
    `UPDATE conversions
        SET status = $1, download_url = $2, error = $3
      WHERE id = $4`,
    [status, downloadUrl, error, id]
  );
}

function buildYoutubeDlOptions(overrides = {}) {
  const baseOptions = {
    noPlaylist: true,
    noWarnings: true,
    retries: 10,
    fragmentRetries: 10,
    fileAccessRetries: 10, // Added to mitigate WinError 32 during rename
    socketTimeout: 30,
    extractorArgs: 'youtube:player_client=android,web',
    jsRuntimes: process.env.YTDLP_JS_RUNTIMES || 'node',
    remoteComponents: process.env.YTDLP_REMOTE_COMPONENTS || 'ejs:github',
  };

  if (process.env.FFMPEG_PATH) {
    // yt-dlp expects the directory containing ffmpeg and ffprobe so it finds both.
    const stat = fs.existsSync(process.env.FFMPEG_PATH) ? fs.statSync(process.env.FFMPEG_PATH) : null;
    baseOptions.ffmpegLocation = (stat && stat.isDirectory()) 
      ? process.env.FFMPEG_PATH 
      : path.dirname(process.env.FFMPEG_PATH);
  }

  return { ...baseOptions, ...overrides };
}

function getCookieCandidates() {
  const candidates = [];
  const cookiesFile = (process.env.YTDLP_COOKIES_FILE || '').trim();
  const cookiesBrowser = (process.env.YTDLP_COOKIES_FROM_BROWSER || '').trim();
  const extraBrowsers = (process.env.YTDLP_COOKIES_BROWSER_FALLBACKS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

  if (cookiesFile) {
    candidates.push({ label: `cookies file (${cookiesFile})`, options: { cookies: cookiesFile } });
  }
  if (cookiesBrowser) {
    candidates.push({ label: `browser (${cookiesBrowser})`, options: { cookiesFromBrowser: cookiesBrowser } });
  }
  for (const browser of extraBrowsers) {
    if (browser !== cookiesBrowser) {
      candidates.push({ label: `browser (${browser})`, options: { cookiesFromBrowser: browser } });
    }
  }

  return candidates;
}

function extractYtError(err) {
  const raw = (
    err?.stderr ||
    err?.stdout ||
    err?.message ||
    'YouTube conversion failed.'
  ).toString().split('\n').slice(0, 8).join(' ').trim();

  const lower = raw.toLowerCase();
  if (lower.includes('could not copy chrome cookie database')) {
    return 'Could not read Chrome cookies because Chrome is open/locked. Close all Chrome windows (including background processes) and restart backend, or use YTDLP_COOKIES_FILE.';
  }
  if (lower.includes('failed to decrypt with dpapi')) {
    return 'Could not decrypt browser cookies (DPAPI). Run backend as the same Windows user session as your browser, or use YTDLP_COOKIES_FILE.';
  }

  return raw;
}

function isYoutubeBotCheckError(err) {
  const text = `${err?.stderr || ''} ${err?.stdout || ''} ${err?.message || ''}`.toLowerCase();
  return text.includes('not a bot') || text.includes('sign in to confirm') || text.includes('cookies-from-browser');
}

async function runYoutubeDlWithFallback(url, options, onStart) {
  const attempt = async (opts) => {
    // youtubedl.exec returns a subprocess from yt-dlp-exec
    const promise = youtubedl.exec(url, opts);
    if (onStart && promise.process) onStart(promise.process);
    return await promise;
  };

  try {
    return await attempt(options);
  } catch (err) {
    if (!isYoutubeBotCheckError(err)) throw err;

    const candidates = getCookieCandidates();
    if (candidates.length) {
      const errors = [];
      for (const candidate of candidates) {
        try {
          return await attempt({ ...options, ...candidate.options });
        } catch (retryErr) {
          errors.push(`${candidate.label}: ${extractYtError(retryErr)}`);
        }
      }
      throw new Error(`YouTube bot-check: all configured cookie sources failed. ${errors.join(' | ')}`);
    }

    throw new Error('YouTube blocked this video (bot-check). Configure cookies in .env.');
  }
}

function findGeneratedMedia(prefix, ext) {
  const files = fs.readdirSync(CONVERTED_DIR)
    .filter(name => name.startsWith(prefix) && name.toLowerCase().endsWith(ext))
    .map(name => {
      const fullPath = path.join(CONVERTED_DIR, name);
      const stat = fs.statSync(fullPath);
      return { name, fullPath, mtimeMs: stat.mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  return files.length ? files[0] : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// 5.5 Background Job Queue System
// ─────────────────────────────────────────────────────────────────────────────
const jobQueue = [];
let activeJobs = 0;
const activeProcesses = new Map(); // recordId -> process/command handle

async function processQueue() {
  if (activeJobs >= CONCURRENCY || jobQueue.length === 0) return;

  activeJobs++;
  const job = jobQueue.shift();

  try {
    if (job.type === 'youtube') {
      await processYoutube(job);
    } else if (job.type === 'youtube-video') {
      await processYoutubeVideo(job);
    } else {
      await processFile(job.file, job.recordId);
    }
  } catch (err) {
    console.error(`[Queue] Unhandled job error:`, err);
  } finally {
    activeJobs--;
    processQueue(); // pull next job
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 6.  FFmpeg conversion helper
//
//  Speed & quality choices:
//    • libmp3lame VBR -q:a 0 = highest quality (~245 kbps avg), faster than CBR
//      because the encoder doesn’t have to hit an exact bitrate target.
//    • -threads 0 = let FFmpeg use ALL available CPU cores for this job.
//    • -vn   = drop any video stream (artwork) — saves time.
//    • -map_metadata 0 = copy ID3 tags (artist, title, album) from source.
// ─────────────────────────────────────────────────────────────────────────────
function convertToMp3(inputPath, outputPath, onStart) {
  return new Promise((resolve, reject) => {
    let isFinished = false;

    const command = ffmpeg(inputPath)
      .toFormat('mp3')
      .audioCodec('libmp3lame')
      .outputOptions([
        '-q:a', '0',          // VBR best quality (~245 kbps)
        '-threads', '0',      // use all CPU cores
        '-vn',                // strip video/cover art stream
        '-map_metadata', '0', // preserve ID3 tags
      ]);

    if (onStart) onStart(command);

    command
      .on('end', () => {
        isFinished = true;
        resolve();
      })
      .on('error', (err) => {
        isFinished = true;
        reject(err);
      });

    // Start the conversion
    command.save(outputPath);

    // Hard timeout: 90 seconds max per file
    setTimeout(() => {
      if (!isFinished) {
        try { command.kill(); } catch (e) {} // fail safely on Windows
        reject(new Error('Conversion timed out after 90 seconds'));
      }
    }, 90000);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 7.  Per-file conversion task
// ─────────────────────────────────────────────────────────────────────────────
async function processFile(file, recordId) {
  const originalName = file.originalname;
  const inputPath    = file.path;

  // Build a URL-safe output filename from the original name (strip extension first)
  const nameNoExt    = path.basename(originalName, path.extname(originalName));
  const safeBase     = sanitizeFilename(nameNoExt);
  const stamp        = Date.now();
  const outputName   = `${stamp}-${safeBase}.mp3`;   
  const outputPath   = path.join(CONVERTED_DIR, outputName);

  // Mark as processing
  await updateRecord(recordId, 'processing').catch(() => {});

  // Convert
  try {
    await convertToMp3(inputPath, outputPath, (cmd) => {
      activeProcesses.set(recordId, cmd);
    });
    // Store URL-encoded path
    const encodedName = encodeURIComponent(outputName);
    const downloadUrl = `/converted/${encodedName}`;
    await updateRecord(recordId, 'completed', downloadUrl);
    console.log(`[OK]  Converted: ${originalName} → ${outputName}`);
    fs.unlink(inputPath, () => {});
    return { id: recordId, file: originalName, status: 'completed', download_url: downloadUrl };
  } catch (err) {
    if (err.message && err.message.includes('SIGKILL')) {
       console.log(`[Job] Cancelled: ${originalName}`);
       return; 
    }
    console.error(`[ERR] Conversion failed: ${originalName} —`, err.message);
    await updateRecord(recordId, 'failed', null, err.message).catch(() => {});
    fs.unlink(inputPath, () => {});
    return { id: recordId, file: originalName, status: 'failed', error: err.message };
  } finally {
    activeProcesses.delete(recordId);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 7b. YouTube conversion task
// ─────────────────────────────────────────────────────────────────────────────
async function processYoutube(job) {
  const { url, title, recordId } = job;
  
  const safeBase     = sanitizeFilename(title);
  const stamp        = Date.now();
  const filePrefix   = `${stamp}-${safeBase}`;
  const outputName   = `${filePrefix}.mp3`;
  const outputPath   = path.join(CONVERTED_DIR, `${filePrefix}.%(ext)s`);

  await updateRecord(recordId, 'processing').catch(() => {});

  try {
    await runYoutubeDlWithFallback(url, buildYoutubeDlOptions({
      extractAudio: true,
      audioFormat: 'mp3',
      audioQuality: 0,
      output: outputPath,
    }), (proc) => {
      activeProcesses.set(recordId, proc);
    });

    const generated = findGeneratedMedia(filePrefix, '.mp3');
    if (!generated) {
      throw new Error('YouTube job completed but no MP3 file was generated.');
    }

    // Ensure we always store a predictable final filename for download URLs.
    if (generated.name !== outputName) {
      fs.renameSync(generated.fullPath, path.join(CONVERTED_DIR, outputName));
    }

    const encodedName = encodeURIComponent(outputName);
    const downloadUrl = `/converted/${encodedName}`;
    await updateRecord(recordId, 'completed', downloadUrl);
    console.log(`[OK]  Converted YT: ${title} → ${outputName}`);
    return { id: recordId, file: title + '.mp3', status: 'completed', download_url: downloadUrl };
  } catch (err) {
    if (err.message && err.message.includes('signal')) {
       console.log(`[Job] YT Cancelled: ${title}`);
       return;
    }
    const errorText = extractYtError(err);
    console.error(`[ERR] YT Conversion failed: ${title} —`, errorText);
    await updateRecord(recordId, 'failed', null, errorText).catch(() => {});
    return { id: recordId, file: title + '.mp3', status: 'failed', error: errorText };
  } finally {
    activeProcesses.delete(recordId);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 7c. YouTube Video conversion task
// ─────────────────────────────────────────────────────────────────────────────
async function processYoutubeVideo(job) {
  const { url, title, quality, recordId } = job;
  
  const safeBase     = sanitizeFilename(title);
  const stamp        = Date.now();
  const filePrefix   = `${stamp}-${safeBase}-${quality}p`;
  const outputName   = `${filePrefix}.mp4`;
  const outputPath   = path.join(CONVERTED_DIR, `${filePrefix}.%(ext)s`);

  await updateRecord(recordId, 'processing').catch(() => {});

  try {
    await runYoutubeDlWithFallback(url, buildYoutubeDlOptions({
      format: `bestvideo[height<=${quality}][ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best`,
      output: outputPath,
      mergeOutputFormat: 'mp4'
    }), (proc) => {
      activeProcesses.set(recordId, proc);
    });

    const generated = findGeneratedMedia(filePrefix, '.mp4');
    if (!generated) {
      throw new Error('YouTube video job completed but no MP4 file was generated.');
    }

    if (generated.name !== outputName) {
      fs.renameSync(generated.fullPath, path.join(CONVERTED_DIR, outputName));
    }

    const encodedName = encodeURIComponent(outputName);
    const downloadUrl = `/converted/${encodedName}`;
    await updateRecord(recordId, 'completed', downloadUrl);
    console.log(`[OK]  Downloaded YT Video: ${title} → ${outputName}`);
    return { id: recordId, file: outputName, status: 'completed', download_url: downloadUrl };
  } catch (err) {
    if (err.message && err.message.includes('signal')) {
       console.log(`[Job] YT Video Cancelled: ${title}`);
       return;
    }
    const errorText = extractYtError(err);
    console.error(`[ERR] YT Video failed: ${title} —`, errorText);
    await updateRecord(recordId, 'failed', null, errorText).catch(() => {});
    return { id: recordId, file: outputName, status: 'failed', error: errorText };
  } finally {
    activeProcesses.delete(recordId);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 8.  Cleanup scheduler — runs every 10 min, deletes MP3s older than 1 hour
// ─────────────────────────────────────────────────────────────────────────────
const CLEANUP_INTERVAL_MS = 10 * 60 * 1000;  // 10 minutes
const FILE_TTL_MS         = 60 * 60 * 1000;  // 1 hour

async function cleanupOldFiles() {
  const cutoff = new Date(Date.now() - FILE_TTL_MS);
  console.log(`[Cleanup] Scanning for files created before ${cutoff.toISOString()}...`);

  try {
    // Fetch completed records older than 1 hour that still have a download URL
    const { rows } = await db.query(
      `SELECT id, download_url FROM conversions
        WHERE status = 'completed'
          AND download_url IS NOT NULL
          AND created_at < $1`,
      [cutoff]
    );

    for (const row of rows) {
      const filePath = path.join(__dirname, row.download_url);

      // Delete the MP3 file from disk
      fs.unlink(filePath, err => {
        if (err && err.code !== 'ENOENT') {
          console.warn(`[Cleanup] Could not delete ${filePath}:`, err.message);
        } else {
          console.log(`[Cleanup] Deleted: ${filePath}`);
        }
      });

      // Nullify download_url so the record reflects the file is gone
      await db.query(
        `UPDATE conversions SET download_url = NULL, status = 'expired'
          WHERE id = $1`,
        [row.id]
      ).catch(err => console.error('[Cleanup] DB update error:', err.message));
    }

    if (rows.length > 0) {
      console.log(`[Cleanup] Processed ${rows.length} expired file(s).`);
    }
  } catch (err) {
    console.error('[Cleanup] Error during cleanup run:', err.message);
  }
}

// Kick off the recurring cleanup
setInterval(cleanupOldFiles, CLEANUP_INTERVAL_MS);
// Also run once shortly after startup
setTimeout(cleanupOldFiles, 5000);

// ─────────────────────────────────────────────────────────────────────────────
// 9.  Express app
// ─────────────────────────────────────────────────────────────────────────────
const app = express();

app.use(cors());
app.use(express.json());

// Serve converted MP3s — explicit route so we control headers and get clear 404s
app.get('/converted/:filename', (req, res) => {
  const safeName = path.basename(decodeURIComponent(req.params.filename));
  const filePath = path.join(CONVERTED_DIR, safeName);

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'File not found or has expired.' });
  }

  // Force browser to download as .mp3 or .mp4 with the clean filename
  const ext = path.extname(safeName).toLowerCase();
  const mimeType = ext === '.mp4' ? 'video/mp4' : 'audio/mpeg';
  res.setHeader('Content-Type', mimeType);
  res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
  res.sendFile(filePath);
});

// Serve React production build (if it exists)
const clientBuild = path.join(__dirname, '../client/build');
if (fs.existsSync(clientBuild)) {
  app.use(express.static(clientBuild));
}

// ─────────────────────────────────────────────────────────────────────────────
// 10. Routes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Scrape a YouTube playlist page HTML to extract video IDs and titles.
 * This bypasses YouTube's internal browse API (which blocks programmatic access)
 * by fetching the page exactly as a real browser would.
 */
function scrapePlaylistEntries(playlistUrl, startNum, endNum) {
  return new Promise((resolve, reject) => {
    const https = require('https');
    // Extract playlist ID from URL
    const listMatch = playlistUrl.match(/[?&]list=([a-zA-Z0-9_-]+)/);
    if (!listMatch) return reject(new Error('Invalid playlist URL — could not extract list ID.'));
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
      if (res.statusCode === 301 || res.statusCode === 302) {
        return reject(new Error('YouTube redirected — playlist may be private or invalid.'));
      }
      let html = '';
      res.on('data', chunk => html += chunk);
      res.on('end', () => {
        // Extract ytInitialData JSON embedded in the page by YouTube
        const dataMatch = html.match(/var ytInitialData = ({.+?});<\/script>/s);
        if (!dataMatch) {
          // Fallback: try regex-based extraction of videoIds and titles directly
          const videoIdRe = /"videoId":"([a-zA-Z0-9_-]{11})"/g;
          const titleRe = /"title":\{"runs":\[\{"text":"([^"]+)"/g;
          const ids = [...html.matchAll(videoIdRe)].map(m => m[1]);
          const titles = [...html.matchAll(titleRe)].map(m => m[1]);
          const unique = [...new Set(ids)];
          if (unique.length === 0) return reject(new Error('Could not parse playlist page. Ensure the playlist is Public.'));
          const total = unique.length;
          const entries = unique.slice(startNum - 1, endNum).map((id, i) => ({
            id, title: titles[i] || `Track_${i + 1}`, url: `https://www.youtube.com/watch?v=${id}`
          }));
          return resolve({ entries, total });
        }

        try {
          const data = JSON.parse(dataMatch[1]);
          // Navigate the ytInitialData structure to find playlist items
          const contents = data?.contents?.twoColumnBrowseResultsRenderer
            ?.tabs?.[0]?.tabRenderer?.content
            ?.sectionListRenderer?.contents?.[0]
            ?.itemSectionRenderer?.contents?.[0]
            ?.playlistVideoListRenderer?.contents;

          if (!contents || !contents.length) {
            // Second structure attempt
            const flatItems = [];
            JSON.stringify(data).replace(/"videoId":"([a-zA-Z0-9_-]{11})"/g, (_, id) => flatItems.push(id));
            const uniqueIds = [...new Set(flatItems)];
            if (!uniqueIds.length) return reject(new Error('Playlist appears empty or private.'));
            const total = uniqueIds.length;
            const entries = uniqueIds.slice(startNum - 1, endNum).map((id, i) => ({
              id, title: `Track_${i + 1}`, url: `https://www.youtube.com/watch?v=${id}`
            }));
            return resolve({ entries, total });
          }

          const allEntries = contents
            .filter(c => c.playlistVideoRenderer)
            .map(c => {
              const r = c.playlistVideoRenderer;
              const id = r.videoId;
              const title = r.title?.runs?.[0]?.text || r.title?.simpleText || `Track_${id}`;
              return { id, title, url: `https://www.youtube.com/watch?v=${id}` };
            });
          const total = allEntries.length;
          const entries = allEntries.slice(startNum - 1, endNum);

          resolve({ entries, total });
        } catch (parseErr) {
          reject(new Error('Failed to parse playlist data: ' + parseErr.message));
        }
      });
    }).on('error', reject);
  });
}

/**
 * GET /youtube-playlist-meta
 * Query: ?playlistUrl=https://www.youtube.com/playlist?list=...
 * Returns total videos discovered in the playlist.
 */
app.get('/youtube-playlist-meta', async (req, res) => {
  const playlistUrl = typeof req.query.playlistUrl === 'string' ? req.query.playlistUrl.trim() : '';
  if (!playlistUrl || !playlistUrl.includes('list=')) {
    return res.status(400).json({ error: 'A valid playlistUrl containing list= is required.' });
  }

  try {
    const { total } = await scrapePlaylistEntries(playlistUrl, 1, 1);
    return res.json({ total });
  } catch (err) {
    console.error('[YT Playlist Meta Error]', err.message);
    return res.status(400).json({ error: err.message || 'Failed to fetch playlist details.' });
  }
});

/**
 * POST /youtube-playlist
 * Accepts JSON: { playlistUrl, start, end }
 * Scrapes the playlist page to get video IDs, then queues each video for yt-dlp conversion.
 */
app.post('/youtube-playlist', async (req, res) => {
  const { playlistUrl, start, end } = req.body;
  
  if (!playlistUrl) return res.status(400).json({ error: 'playlistUrl is required' });
  const startNum = parseInt(start, 10) || 1;
  const endNum = parseInt(end, 10) || 50;

  if (!Number.isInteger(startNum) || !Number.isInteger(endNum) || startNum < 1 || endNum < 1) {
    return res.status(400).json({ error: 'start and end must be positive integers.' });
  }
  if (endNum < startNum) {
    return res.status(400).json({ error: 'end must be greater than or equal to start.' });
  }
  if (endNum - startNum + 1 > 50) {
    return res.status(400).json({ error: 'Maximum 50 videos per request. Use ranges like 1-50, then 51-100.' });
  }

  try {
    console.log(`[Queue] Scraping playlist: ${playlistUrl} (items ${startNum}–${endNum})`);
    
    const { entries, total } = await scrapePlaylistEntries(playlistUrl, startNum, endNum);

    if (startNum > total) {
      return res.status(400).json({ error: `Playlist has only ${total} video(s). Start cannot be greater than ${total}.` });
    }
    if (endNum > total) {
      return res.status(400).json({ error: `Playlist has only ${total} video(s). End cannot be greater than ${total}.` });
    }

    if (!entries || entries.length === 0) {
      return res.status(400).json({ error: 'No videos found in that range. Ensure the playlist is Public.' });
    }

    console.log(`[Queue] Found ${entries.length} video(s). Queuing...`);
    const acceptedFiles = [];

    for (const entry of entries) {
      const { id, title, url } = entry;
      const originalName = title + '.m4a';

      try {
        // De-duplication check
        const existing = await findActiveRecordByUrl(url);
        if (existing) {
          console.log(`[Queue] Skipping duplicate (already ${existing.status}): ${title}`);
          acceptedFiles.push({ 
            file: originalName, 
            id: existing.id, 
            status: existing.status === 'pending' ? 'queued' : existing.status 
          });
          continue;
        }

        const recordId = await createRecord(originalName, 'youtube', url);
        jobQueue.push({ type: 'youtube', url, title, recordId });
        acceptedFiles.push({ file: originalName, id: recordId, status: 'queued' });
      } catch (err) {
        console.error(`[DB] Failed to create record for YT "${title}":`, err.message);
      }
    }

    // Kickstart queue workers up to CONCURRENCY
    for (let i = 0; i < CONCURRENCY; i++) processQueue();

    return res.status(202).json({ 
      message: `Queued ${acceptedFiles.length} video(s) for conversion.`,
      total: acceptedFiles.length,
      playlistTotal: total,
      initialStates: acceptedFiles
    });
  } catch (err) {
    console.error('[YT Scrape Error]', err.message);
    return res.status(400).json({ error: err.message || 'Failed to fetch playlist. Is it Public?' });
  }
});
/**
 * POST /youtube-videos
 * Accepts JSON: { urls: string[] }
 * Queues individual YouTube video URLs for conversion.
 * Much more reliable than playlist fetching since individual video APIs are not blocked.
 */
app.post('/youtube-videos', async (req, res) => {
  const { urls } = req.body;
  if (!Array.isArray(urls) || urls.length === 0) {
    return res.status(400).json({ error: 'urls must be a non-empty array.' });
  }

  // Validate URLs quickly (must be youtube.com or youtu.be)
  const validUrls = urls.filter(u => typeof u === 'string' && /^https?:\/\/(www\.)?(youtube\.com|youtu\.be)/.test(u));
  if (validUrls.length === 0) {
    return res.status(400).json({ error: 'No valid YouTube URLs found.' });
  }

  console.log(`[Queue] Received ${validUrls.length} individual YT URL(s).`);
  const acceptedFiles = [];

  // Get each video's title using yt-dlp --get-title (fast, individual API, not blocked)
  for (const url of validUrls) {
    let title = '';
    try {
      // De-duplication check
      const existing = await findActiveRecordByUrl(url);
      if (existing) {
        acceptedFiles.push({ 
          file: existing.original_name, 
          id: existing.id, 
          status: existing.status === 'pending' ? 'queued' : existing.status 
        });
        continue;
      }

      const result = await runYoutubeDlWithFallback(url, buildYoutubeDlOptions({ getTitle: true }));
      title = (typeof result === 'string' ? result : result?.stdout || result?.title || '').trim();
    } catch (_) {}

    if (!title) {
      // Fallback title from common YouTube URL formats
      const idMatch =
        url.match(/[?&]v=([a-zA-Z0-9_-]{11})/) ||
        url.match(/youtu\.be\/([a-zA-Z0-9_-]{11})/) ||
        url.match(/\/shorts\/([a-zA-Z0-9_-]{11})/);
      title = idMatch ? `YouTube_Video_${idMatch[1]}` : `YouTube_Video_${Date.now()}`;
    }

    const originalName = title + '.m4a';
    const recordId = await createRecord(originalName, 'youtube', url);
    jobQueue.push({ type: 'youtube', url, title, recordId });
    acceptedFiles.push({ file: originalName, id: recordId, status: 'queued' });
  }

  for (let i = 0; i < CONCURRENCY; i++) processQueue();

  return res.status(202).json({
    message: `Queued ${acceptedFiles.length} video(s) for conversion.`,
    total: acceptedFiles.length,
    initialStates: acceptedFiles
  });
});

/**
 * GET /youtube-formats
 * Query: ?url=https://www.youtube.com/watch?v=...
 * Returns available video qualities for a given YouTube URL.
 */
app.get('/youtube-formats', async (req, res) => {
  const videoUrl = req.query.url;
  if (!videoUrl) return res.status(400).json({ error: 'url is required' });

  try {
    // Call youtubedl() directly (not .exec) — it returns the parsed JSON object
    const opts = {
      noPlaylist: true,
      noWarnings: true,
      dumpJson: true,
    };

    if (process.env.FFMPEG_PATH) {
      const stat = fs.existsSync(process.env.FFMPEG_PATH) ? fs.statSync(process.env.FFMPEG_PATH) : null;
      opts.ffmpegLocation = (stat && stat.isDirectory()) ? process.env.FFMPEG_PATH : path.dirname(process.env.FFMPEG_PATH);
    }
    if (process.env.YTDLP_COOKIES_FILE) opts.cookies = process.env.YTDLP_COOKIES_FILE;
    if (process.env.YTDLP_COOKIES_FROM_BROWSER) opts.cookiesFromBrowser = process.env.YTDLP_COOKIES_FROM_BROWSER;

    const info = await youtubedl(videoUrl, opts);

    const formats = info.formats || [];
    const videoFormats = formats.filter(f => f.vcodec && f.vcodec !== 'none' && f.height);
    const uniqueHeights = [...new Set(videoFormats.map(f => f.height))].sort((a, b) => b - a);

    console.log(`[YT Formats] ${info.title} — found heights: ${uniqueHeights.join(', ')}`);
    res.json({ title: info.title, formats: uniqueHeights });
  } catch (err) {
    console.error('[YT Formats Error]', err.stderr || err.message);
    res.status(400).json({ error: err.stderr?.trim() || err.message || 'Failed to fetch formats' });
  }
});


/**
 * POST /youtube-video-download
 * Accepts JSON: { url, quality }
 * Queues a YouTube video for downloading in the specified quality.
 */
app.post('/youtube-video-download', async (req, res) => {
  const { url, quality } = req.body;
  if (!url || !quality) return res.status(400).json({ error: 'url and quality are required' });

  try {
    let title = '';
    try {
      const result = await runYoutubeDlWithFallback(url, buildYoutubeDlOptions({ getTitle: true }));
      title = (typeof result === 'string' ? result : result?.stdout || result?.title || '').trim();
    } catch (_) {}
    
    if (!title) {
        title = `YouTube_Video_${Date.now()}`;
    }

    const originalName = `${title}_${quality}p.mp4`;
    const recordId = await createRecord(originalName, 'youtube-video', url);
    jobQueue.push({ type: 'youtube-video', url, title, quality, recordId });
    processQueue();

    return res.status(202).json({
      message: `Queued video for download in ${quality}p`,
      id: recordId,
      initialStates: [{ file: originalName, id: recordId, status: 'queued' }]
    });
  } catch (err) {
     res.status(400).json({ error: err.message });
  }
});

/**
 * POST /cancel
 * Body: { ids: string[] }
 * Stops background queue jobs or kills active processes.
 */
app.post('/cancel', async (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids)) return res.status(400).json({ error: 'ids must be an array' });

  console.log(`[Cancel] Request for ${ids.length} jobs.`);

  // 1. Remove from jobQueue (pending jobs)
  for (let i = jobQueue.length - 1; i >= 0; i--) {
    if (ids.includes(jobQueue[i].recordId)) {
      const removed = jobQueue.splice(i, 1)[0];
      await updateRecord(removed.recordId, 'failed', null, 'Cancelled by user').catch(() => {});
      console.log(`[Queue] Cancelled pending job: ${removed.recordId}`);
    }
  }

  // 2. Terminate active processes (running jobs)
  for (const id of ids) {
    if (activeProcesses.has(id)) {
      const proc = activeProcesses.get(id);
      try {
        if (proc.kill) {
          // It's a subprocess (yt-dlp) or a command with kill method (ffmpeg)
          proc.kill('SIGKILL');
        }
        console.log(`[Queue] Terminated active process: ${id}`);
      } catch (err) {
        console.warn(`[Queue] Error killing process ${id}:`, err.message);
      }
      activeProcesses.delete(id);
      await updateRecord(id, 'failed', null, 'Cancelled by user').catch(() => {});
    }
  }

  res.json({ success: true });
});

/**
 * POST /convert
 * Accepts multipart/form-data with field "files".
 * Pushes to background queue and returns 202 Accepted instantly.
 */
app.post('/convert', (req, res) => {
  upload(req, res, async uploadErr => {
    if (uploadErr) {
      return res.status(400).json({ error: uploadErr.message });
    }

    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'No .m4a files were uploaded.' });
    }

    console.log(`[Queue] Received ${req.files.length} file(s). Enqueuing...`);
    const acceptedFiles = [];

    // Create a DB row for each, then push to the background worker queue
    for (const file of req.files) {
      try {
        const recordId = await createRecord(file.originalname);
        jobQueue.push({ file, recordId });
        acceptedFiles.push({ file: file.originalname, id: recordId, status: 'queued' });
      } catch (err) {
        console.error(`[DB] Failed to create record for ${file.originalname}:`, err.message);
        fs.unlink(file.path, () => {});
      }
    }

    // Kickstart queue workers up to CONCURRENCY
    for (let i = 0; i < CONCURRENCY; i++) {
       processQueue();
    }

    return res.status(202).json({ 
      message: 'Processing started in background.',
      total: acceptedFiles.length,
      initialStates: acceptedFiles
    });
  });
});

/**
 * GET /conversions
 * Returns all conversion records in descending creation order.
 */
app.get('/conversions', async (_req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT * FROM conversions ORDER BY created_at DESC'
    );
    res.json({ total: rows.length, conversions: rows });
  } catch (err) {
    console.error('[DB] GET /conversions:', err.message);
    res.status(500).json({ error: 'Failed to fetch conversions.' });
  }
});

/**
 * GET /conversions/:id
 * Returns a single conversion record by its UUID.
 */
app.get('/conversions/:id', async (req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT * FROM conversions WHERE id = $1',
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Record not found.' });
    res.json(rows[0]);
  } catch (err) {
    console.error('[DB] GET /conversions/:id:', err.message);
    res.status(500).json({ error: 'Failed to fetch record.' });
  }
});

/**
 * GET /download-zip?ids=UUID1,UUID2...
 * Streams a ZIP file containing all requested completed conversions.
 */
app.get('/download-zip', async (req, res) => {
  const idsParam = req.query.ids;
  if (!idsParam) return res.status(400).json({ error: 'Missing ids parameter' });

  const ids = idsParam.split(',').map(s => s.trim()).filter(Boolean);
  if (ids.length === 0) return res.status(400).json({ error: 'No valid ids provided' });

  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const validIds = ids.filter(id => uuidRegex.test(id));
  if (validIds.length === 0) {
    return res.status(400).json({ error: 'No valid conversion IDs were provided.' });
  }

  try {
    // 1. Fetch paths from DB
    const { rows } = await db.query(
      `SELECT original_name, download_url 
         FROM conversions 
        WHERE id = ANY($1::uuid[]) 
          AND status = 'completed' 
          AND download_url IS NOT NULL`,
      [validIds]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'None of the requested files were found or they have expired.' });
    }

    const usedNames = new Set();
    const filesToZip = [];

    for (const row of rows) {
      let extracted = row.download_url;
      try {
        extracted = decodeURIComponent(row.download_url.split('/converted/')[1] || row.download_url);
      } catch (_err) {
        extracted = row.download_url.split('/converted/')[1] || row.download_url;
      }

      const safeName = path.basename(extracted);
      const filePath = path.join(CONVERTED_DIR, safeName);
      if (!fs.existsSync(filePath)) continue;

      let rawDisplayName = row.original_name.replace(/\.[^/.]+$/, '');
      rawDisplayName = sanitizeFilename(rawDisplayName);

      let ext = path.extname(safeName) || '.mp3';
      let entryName = `${rawDisplayName}${ext}`;
      if (usedNames.has(entryName)) {
        let suffix = 2;
        while (usedNames.has(`${rawDisplayName} (${suffix})${ext}`)) {
          suffix++;
        }
        entryName = `${rawDisplayName} (${suffix})${ext}`;
      }

      usedNames.add(entryName);
      filesToZip.push({ filePath, entryName });
    }

    if (filesToZip.length === 0) {
      return res.status(404).json({ error: 'Requested conversions exist, but source MP3 files are no longer available on server.' });
    }

    // 2. Setup ZIP stream response headers
    const zipName = `AudioBatch-${Date.now()}.zip`;
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${zipName}"`);

    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.on('error', err => {
      console.error('[Archiver Error]', err);
      if (!res.headersSent) res.status(500).end();
    });

    // Pipe the archive to the user's browser download stream immediately
    archive.pipe(res);

    // 3. Add each file to the archive
    for (const item of filesToZip) {
      archive.file(item.filePath, { name: item.entryName });
    }

    // 4. Finalize the stream
    await archive.finalize();

  } catch (err) {
    console.error('[DB/Archiver Error]', err.message);
    if (!res.headersSent) res.status(500).json({ error: 'Internal server error while building ZIP.' });
  }
});

/** GET /health — liveness probe */
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', concurrency: CONCURRENCY, time: new Date().toISOString() });
});

// Catch-all: serve React index.html for client-side routing (production)
if (fs.existsSync(clientBuild)) {
  app.get('*', (_req, res) => {
    res.sendFile(path.join(clientBuild, 'index.html'));
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 11. Start
// ─────────────────────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || '3000', 10);
app.listen(PORT, () => {
  console.log(`\n🎵  M4A → MP3 Converter  |  http://localhost:${PORT}`);
  console.log(`   POST /convert            upload up to 50 .m4a files`);
  console.log(`   GET  /conversions        list all records`);
  console.log(`   GET  /conversions/:id    single record`);
  console.log(`   GET  /converted/<file>   download MP3`);
  console.log(`   Cleanup runs every 10 min — files expire after 1 hour\n`);
});
