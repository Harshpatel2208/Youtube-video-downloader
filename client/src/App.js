import React, { useState, useRef, useCallback, useEffect } from 'react';
import axios from 'axios';

// Point axios directly at the backend so we never rely on the React proxy
axios.defaults.baseURL = 'http://localhost:3000';


// ─── SVG Circular Progress Ring ───────────────────────────────────────────────
// size: ring diameter in px | status: queued|uploading|processing|completed|failed
function CircleRing({ status }) {
  const r  = 16;          // radius
  const cx = 20;          // center
  const stroke = 3;
  const circ = 2 * Math.PI * r; // circumference ≈ 100.5

  const map = {
    queued:     { dash: 0,     color: '#3a3a5c', spin: false, icon: null },
    uploading:  { dash: circ * 0.4, color: '#43e5f7', spin: true,  icon: null },
    processing: { dash: circ * 0.65, color: '#6c63ff', spin: true,  icon: null },
    completed:  { dash: circ,  color: '#1db954', spin: false, icon: '✓' },
    failed:     { dash: circ,  color: '#e74c5e', spin: false, icon: '✕' },
  };
  const cfg = map[status] || map.queued;

  return (
    <svg width="40" height="40" viewBox="0 0 40 40" className="ring-svg">
      {/* background track */}
      <circle cx={cx} cy={cx} r={r} fill="none" stroke="#1c1c3a" strokeWidth={stroke} />
      {/* progress arc */}
      <circle
        cx={cx} cy={cx} r={r}
        fill="none"
        stroke={cfg.color}
        strokeWidth={stroke}
        strokeLinecap="round"
        strokeDasharray={`${cfg.dash} ${circ}`}
        strokeDashoffset={0}
        transform={`rotate(-90 ${cx} ${cx})`}
        className={cfg.spin ? 'ring-spin' : ''}
        style={{ transition: 'stroke-dasharray 0.5s ease' }}
      />
      {/* centre icon */}
      {cfg.icon && (
        <text
          x={cx} y={cx + 5}
          textAnchor="middle"
          fontSize="11"
          fontWeight="700"
          fill={cfg.color}
        >
          {cfg.icon}
        </text>
      )}
    </svg>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
const fmtBytes = b => {
  if (!b) return '0 B';
  const k = 1024, u = ['B','KB','MB','GB'];
  const i = Math.floor(Math.log(b) / Math.log(k));
  return `${(b / Math.pow(k, i)).toFixed(1)} ${u[i]}`;
};
const uid = () => Math.random().toString(36).slice(2);

const STATUS_LABEL = {
  queued:     'Queued',
  uploading:  'Uploading…',
  processing: 'Converting…',
  completed:  'Done',
  failed:     'Failed',
};

const STATUS_STYLES = {
  queued: 'bg-white/10 text-slate-300 border border-white/10',
  uploading: 'bg-cyan-400/15 text-cyan-200 border border-cyan-300/20',
  processing: 'bg-indigo-400/15 text-indigo-200 border border-indigo-300/20 animate-pulse',
  completed: 'bg-emerald-400/15 text-emerald-200 border border-emerald-300/20',
  failed: 'bg-rose-500/15 text-rose-200 border border-rose-300/20',
};

const ROW_FILL_BY_STATUS = {
  queued: '0%',
  uploading: '35%',
  processing: '70%',
  completed: '0%',
  failed: '0%',
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const isUuid = (v) => UUID_RE.test(String(v || ''));

// ─────────────────────────────────────────────────────────────────────────────
export default function App() {
  const inputRef = useRef(null);
  const autoZipTimeoutRef = useRef(null);
  const autoZipIntervalRef = useRef(null);
  const autoZipSignatureRef = useRef('');
  const [files, setFiles]               = useState([]);
  const [uploadPct, setUploadPct]       = useState(0);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [dragOver, setDragOver]         = useState(false);

  // YouTube Tab States
  const [activeTab, setActiveTab]       = useState('local');
  const [ytMode, setYtMode]             = useState('videos');
  const [ytUrls, setYtUrls]             = useState('');
  const [playlistUrl, setPlaylistUrl]   = useState('');
  const [playlistStart, setPlaylistStart] = useState(1);
  const [playlistEnd, setPlaylistEnd]   = useState(50);
  const [playlistTotalVideos, setPlaylistTotalVideos] = useState(0);
  const [playlistMetaLoading, setPlaylistMetaLoading] = useState(false);
  const [ytLoading, setYtLoading]       = useState(false);
  const [downloadingFileIds, setDownloadingFileIds] = useState({});
  const [fileDownloadPctById, setFileDownloadPctById] = useState({});
  const [isZipDownloading, setIsZipDownloading] = useState(false);
  const [zipDownloadPct, setZipDownloadPct] = useState(0);
  const [zipDownloadLabel, setZipDownloadLabel] = useState('');
  const [autoZipCountdown, setAutoZipCountdown] = useState(0);

  // YouTube Video Downsloader States
  const [ytVideoUrl, setYtVideoUrl]     = useState('');
  const [ytVideoTitle, setYtVideoTitle] = useState('');
  const [ytVideoFormats, setYtVideoFormats] = useState([]);
  const [selectedQuality, setSelectedQuality] = useState('');

  const playlistStartNum = Number(playlistStart);
  const playlistEndNum = Number(playlistEnd);
  const playlistSelectedCount = !playlistUrl.trim()
    ? 0
    : (Number.isInteger(playlistStartNum) && Number.isInteger(playlistEndNum) && playlistStartNum > 0 && playlistEndNum >= playlistStartNum)
      ? (playlistEndNum - playlistStartNum + 1)
      : 0;

  useEffect(() => {
    if (ytMode !== 'playlist') return;

    const trimmed = playlistUrl.trim();
    if (!trimmed || !trimmed.includes('list=')) {
      setPlaylistTotalVideos(0);
      setPlaylistMetaLoading(false);
      return;
    }

    let cancelled = false;
    const timer = setTimeout(async () => {
      setPlaylistMetaLoading(true);
      try {
        const { data } = await axios.get('/youtube-playlist-meta', {
          params: { playlistUrl: trimmed }
        });
        if (!cancelled) setPlaylistTotalVideos(Number(data.total) || 0);
      } catch (_) {
        if (!cancelled) setPlaylistTotalVideos(0);
      } finally {
        if (!cancelled) setPlaylistMetaLoading(false);
      }
    }, 450);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [playlistUrl, ytMode]);

  const total     = files.length;
  const completed = files.filter(f => f.status === 'completed').length;
  const failed    = files.filter(f => f.status === 'failed').length;
  const progress  = total === 0 ? 0 : Math.round((completed + failed) / total * 100);

  const getCompletedUuidIds = useCallback((items) => {
    return [...new Set(
      items
        .filter(f => f.status === 'completed' && f.downloadUrl !== null)
        .map(f => f.id)
        .filter(isUuid)
    )];
  }, []);

  const clearAutoZipTimer = useCallback(() => {
    if (autoZipTimeoutRef.current) {
      clearTimeout(autoZipTimeoutRef.current);
      autoZipTimeoutRef.current = null;
    }
    if (autoZipIntervalRef.current) {
      clearInterval(autoZipIntervalRef.current);
      autoZipIntervalRef.current = null;
    }
    setAutoZipCountdown(0);
  }, []);

  // ── Add files ────────────────────────────────────────────────────────────
  const addFiles = useCallback(incoming => {
    const valid   = [...incoming].filter(f => f.name.toLowerCase().endsWith('.m4a'));
    const skipped = incoming.length - valid.length;
    if (skipped > 0) alert(`${skipped} file(s) skipped — only .m4a accepted.`);
    if (!valid.length) return;
    setFiles(prev => [
      ...prev,
      ...valid.map(f => ({ id: uid(), name: f.name, size: f.size,
                           status: 'queued', downloadUrl: null, error: null, _file: f })),
    ]);
  }, []);

  const onDrop = e => { e.preventDefault(); setDragOver(false); addFiles(e.dataTransfer.files); };

  const removeFile = async id => {
    setFiles(p => p.filter(f => f.id !== id));
    try {
      await axios.post('/cancel', { ids: [id] });
    } catch (e) {
      console.warn('Failed to notify server of cancellation', e.message);
    }
  };

  const clearAll = async () => {
    const ids = files.map(f => f.id);
    clearAutoZipTimer();
    autoZipSignatureRef.current = '';
    setFiles([]);
    setUploadPct(0);
    setDownloadingFileIds({});
    setFileDownloadPctById({});
    setIsZipDownloading(false);
    setZipDownloadPct(0);
    setZipDownloadLabel('');
    if (inputRef.current) inputRef.current.value = '';
    setIsSubmitting(false);

    try {
      await axios.post('/cancel', { ids });
    } catch (e) {
      console.warn('Failed to notify server of mass cancellation', e.message);
    }
  };

  // ── Convert ──────────────────────────────────────────────────────────────
  const handleConvert = async () => {
    const queued = files.filter(f => f.status === 'queued');
    if (!queued.length) return;

    setIsSubmitting(true);
    setUploadPct(0);
    setFiles(p => p.map(f => f.status === 'queued' ? { ...f, status: 'uploading' } : f));

    const form = new FormData();
    queued.forEach(f => form.append('files', f._file));

    try {
      const { data } = await axios.post('/convert', form, {
        headers: { 'Content-Type': 'multipart/form-data' },
        onUploadProgress: e => {
          const pct = e.total ? Math.round(e.loaded / e.total * 100) : 0;
          setUploadPct(pct);
          if (pct === 100)
            setFiles(p => p.map(f => f.status === 'uploading' ? { ...f, status: 'processing' } : f));
        },
      });

      // Replace temporary client IDs with DB UUIDs returned by backend.
      const serverStates = Array.isArray(data?.initialStates) ? data.initialStates : [];
      if (serverStates.length) {
        const queuedLocalIds = queued.map(f => f.id);
        const queuedIdSet = new Set(queuedLocalIds);
        let idx = 0;

        setFiles(prev => prev.map(item => {
          if (!queuedIdSet.has(item.id) || idx >= serverStates.length) return item;

          const serverItem = serverStates[idx++];
          return {
            ...item,
            id: serverItem?.id || item.id,
            status: serverItem?.status || 'processing'
          };
        }));
      }

      // Upload finished, server has queued them. Now start polling for status.
      pollStatus();

    } catch (err) {
      const msg = err.response?.data?.error || err.message;
      setFiles(p => p.map(f =>
        ['uploading','processing'].includes(f.status)
          ? { ...f, status: 'failed', error: msg } : f
      ));
      setIsSubmitting(false);
    }
  };

  const pollStatus = async () => {
    try {
      const { data } = await axios.get('/conversions');
      
      setFiles(prev => {
        let stillProcessing = false;
        const updated = prev.map(localFile => {
          // Completed/failed rows are terminal states.
          if (['completed', 'failed'].includes(localFile.status)) return localFile;

          // Local queued files (with a browser File object) are not submitted yet.
          if (localFile.status === 'queued' && localFile._file) return localFile;

          // Prefer exact UUID match; fall back to filename matching for legacy rows.
          const matchById = data.conversions.find(r => r.id === localFile.id);
          const matchByName = data.conversions.find(r => r.original_name === localFile.name);
          const match = matchById || matchByName;
          if (!match) {
            if (['uploading', 'processing'].includes(localFile.status)) stillProcessing = true;
            return localFile;
          }

          if (['pending', 'processing'].includes(match.status)) {
            stillProcessing = true;
            return { ...localFile, id: match.id || localFile.id, status: 'processing' };
          }

          // Otherwise, it finished or failed!
          return { 
            ...localFile, 
            id: match.id || localFile.id,
            status: match.status,
            downloadUrl: match.download_url || null, 
            error: match.error || null 
          };
        });

        // Loop polling if any file is still converting
        if (stillProcessing) {
          setTimeout(pollStatus, 2000);
        } else {
          setIsSubmitting(false);
        }

        return updated;
      });
    } catch (err) {
      console.error('Polling error', err);
      setTimeout(pollStatus, 5000); // retry gracefully
    }
  };

  const queueYoutubeItems = (initialStates) => {
    setFiles(prev => {
      const existingNames = new Set(prev.map(f => f.name));
      const filtered = initialStates.filter(f => !existingNames.has(f.file));
      
      const newItems = filtered.map(f => ({
        id: f.id,
        name: f.file,
        size: 0,
        status: f.status || 'queued',
        downloadUrl: null,
        error: null,
        _file: null
      }));

      return [...prev, ...newItems];
    });
    pollStatus();
  };

  const handleYoutubeVideosSubmit = async () => {
    const lines = ytUrls.split('\n').map(s => s.trim()).filter(s => s.startsWith('http'));
    if (!lines.length) return alert('Please paste at least one valid YouTube URL.');
    if (lines.length > 50) return alert('Please queue at most 50 links at once.');
    setYtLoading(true);
    
    try {
      const { data } = await axios.post('/youtube-videos', { urls: lines });
      queueYoutubeItems(data.initialStates || []);
      setYtUrls('');
    } catch (err) {
      alert(err.response?.data?.error || err.message);
    } finally {
      setYtLoading(false);
    }
  };

  const handleYoutubePlaylistSubmit = async () => {
    const start = Number(playlistStart);
    const end = Number(playlistEnd);

    if (!playlistUrl.includes('list=')) {
      return alert('Please paste a valid YouTube playlist URL containing list=...');
    }
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < 1 || end < start) {
      return alert('Please enter a valid start/end range. Example: 1 to 50');
    }
    if (end - start + 1 > 50) {
      return alert('Max 50 videos per batch. Use ranges like 1-50, then 51-100.');
    }
    if (playlistTotalVideos > 0 && start > playlistTotalVideos) {
      return alert(`This playlist has only ${playlistTotalVideos} videos. Start cannot be greater than ${playlistTotalVideos}.`);
    }
    if (playlistTotalVideos > 0 && end > playlistTotalVideos) {
      return alert(`This playlist has only ${playlistTotalVideos} videos. End cannot be greater than ${playlistTotalVideos}.`);
    }

    setYtLoading(true);
    try {
      const { data } = await axios.post('/youtube-playlist', {
        playlistUrl: playlistUrl.trim(),
        start,
        end,
      });
      if (typeof data.playlistTotal === 'number') {
        setPlaylistTotalVideos(data.playlistTotal);
      }
      queueYoutubeItems(data.initialStates || []);
    } catch (err) {
      alert(err.response?.data?.error || err.message);
    } finally {
      setYtLoading(false);
    }
  };

  const handleYoutubeSubmit = async (e) => {
    e.preventDefault();
    if (ytMode === 'playlist') {
      await handleYoutubePlaylistSubmit();
      return;
    }
    await handleYoutubeVideosSubmit();
  };

  const handleGetFormats = async () => {
    if (!ytVideoUrl.trim().startsWith('http')) {
      return alert('Please enter a valid YouTube URL');
    }
    setYtLoading(true);
    setYtVideoFormats([]);
    setSelectedQuality('');
    setYtVideoTitle('');
    try {
      const { data } = await axios.get('/youtube-formats', { params: { url: ytVideoUrl.trim() } });
      if (data.formats && data.formats.length > 0) {
        setYtVideoFormats(data.formats);
        setSelectedQuality(data.formats[0]);
        setYtVideoTitle(data.title || '');
      } else {
        alert('Could not detect video qualities.');
      }
    } catch (err) {
      alert(err.response?.data?.error || err.message);
    } finally {
      setYtLoading(false);
    }
  };

  const handleYoutubeVideoSubmit = async (e) => {
    e.preventDefault();
    if (!ytVideoUrl.trim().startsWith('http')) return alert('Valid URL required');
    if (!selectedQuality) return alert('Select a quality first');

    setYtLoading(true);
    try {
      const { data } = await axios.post('/youtube-video-download', {
        url: ytVideoUrl.trim(),
        quality: selectedQuality
      });
      queueYoutubeItems(data.initialStates || []);
      setYtVideoUrl('');
      setYtVideoFormats([]);
      setYtVideoTitle('');
      setSelectedQuality('');
    } catch (err) {
      alert(err.response?.data?.error || err.message);
    } finally {
      setYtLoading(false);
    }
  };

  const extractFilenameFromDisposition = (contentDisposition, fallback) => {
    if (!contentDisposition) return fallback;
    const starMatch = contentDisposition.match(/filename\*=UTF-8''([^;]+)/i);
    if (starMatch?.[1]) {
      try { return decodeURIComponent(starMatch[1]); } catch (_) {}
    }
    const plainMatch = contentDisposition.match(/filename="?([^";]+)"?/i);
    return plainMatch?.[1] || fallback;
  };

  const readBlobErrorMessage = async (blob, fallback) => {
    if (!blob) return fallback;
    try {
      const text = await blob.text();
      const parsed = JSON.parse(text);
      return parsed?.error || fallback;
    } catch (_) {
      return fallback;
    }
  };

  // ── Download programmatically to bypass CRA SPA fallback ─────────────────
  const handleDownload = async (url, filename, id) => {
    if (downloadingFileIds[id]) return;
    setDownloadingFileIds(prev => ({ ...prev, [id]: true }));
    setFileDownloadPctById(prev => ({ ...prev, [id]: 0 }));

    try {
      const response = await axios.get(url, {
        responseType: 'blob',
        onDownloadProgress: (evt) => {
          if (evt.total) {
            const pct = Math.round((evt.loaded / evt.total) * 100);
            setFileDownloadPctById(prev => ({ ...prev, [id]: pct }));
          }
        }
      });

      const blob = response.data;
      const blobUrl = window.URL.createObjectURL(blob);
      const tempLink = document.createElement('a');
      tempLink.href = blobUrl;
      const isMp4 = filename.toLowerCase().endsWith('.mp4');
      const finalExt = isMp4 ? '.mp4' : '.mp3';
      const baseName = filename.replace(/\.[^/.]+$/, '');
      tempLink.setAttribute('download', `${baseName}${finalExt}`);
      document.body.appendChild(tempLink);
      tempLink.click();
      document.body.removeChild(tempLink);
      window.URL.revokeObjectURL(blobUrl);
      setFileDownloadPctById(prev => ({ ...prev, [id]: 100 }));
    } catch (err) {
      alert('Download failed. Server might be down.');
    } finally {
      setTimeout(() => {
        setDownloadingFileIds(prev => {
          const next = { ...prev };
          delete next[id];
          return next;
        });
        setFileDownloadPctById(prev => {
          const next = { ...prev };
          delete next[id];
          return next;
        });
      }, 600);
    }
  };

  const handleDownloadZip = useCallback(async () => {
    if (isZipDownloading) return;

    clearAutoZipTimer();

    const currentSignature = getCompletedUuidIds(files).sort().join(',');
    if (currentSignature) autoZipSignatureRef.current = currentSignature;

    const completedFiles = files.filter(f => f.status === 'completed' && f.downloadUrl !== null);
    if (!completedFiles.length) return;

    let completedIds = [...new Set(completedFiles.map(f => f.id).filter(isUuid))];

    if (completedIds.length < completedFiles.length) {
      try {
        const { data } = await axios.get('/conversions');
        const rows = Array.isArray(data?.conversions) ? data.conversions : [];
        const recovered = new Map();

        for (const file of completedFiles) {
          if (isUuid(file.id)) continue;

          const byName = rows.find(r => r.status === 'completed' && r.original_name === file.name && r.id);
          if (byName?.id && isUuid(byName.id)) {
            recovered.set(file.id, byName.id);
            completedIds.push(byName.id);
          }
        }

        if (recovered.size) {
          setFiles(prev => prev.map(item => {
            const mapped = recovered.get(item.id);
            return mapped ? { ...item, id: mapped } : item;
          }));
        }

        completedIds = [...new Set(completedIds.filter(isUuid))];
      } catch (_) {
        // If refresh fails, proceed with whatever valid UUIDs we already have.
      }
    }

    if (!completedIds.length) {
      alert('No completed items with valid conversion IDs were found yet. Please wait a few seconds and try again.');
      return;
    }

    setIsZipDownloading(true);
    setZipDownloadPct(0);
    setZipDownloadLabel('Preparing ZIP...');

    try {
      const response = await axios.get('/download-zip', {
        params: { ids: completedIds.join(',') },
        responseType: 'blob',
        onDownloadProgress: (evt) => {
          setZipDownloadLabel('Downloading ZIP...');
          if (evt.total) {
            setZipDownloadPct(Math.round((evt.loaded / evt.total) * 100));
          }
        }
      });

      const blob = response.data;
      const fallbackName = `AudioBatch-${Date.now()}.zip`;
      const filename = extractFilenameFromDisposition(response.headers['content-disposition'], fallbackName);
      const blobUrl = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = blobUrl;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      window.URL.revokeObjectURL(blobUrl);

      setZipDownloadPct(100);
      setZipDownloadLabel('ZIP downloaded');
    } catch (err) {
      const fallback = err.response?.data
        ? await readBlobErrorMessage(err.response.data, 'ZIP download failed. Please try again.')
        : (err.message || 'ZIP download failed. Please try again.');
      setZipDownloadLabel('ZIP download failed');
      alert(fallback);
    } finally {
      setTimeout(() => {
        setIsZipDownloading(false);
        setZipDownloadPct(0);
        setZipDownloadLabel('');
      }, 1200);
    }
  }, [clearAutoZipTimer, files, getCompletedUuidIds, isZipDownloading]);

  useEffect(() => {
    const completedUuidIds = getCompletedUuidIds(files).sort();
    const signature = completedUuidIds.join(',');

    if (!signature) {
      clearAutoZipTimer();
      autoZipSignatureRef.current = '';
      return;
    }

    if (autoZipSignatureRef.current === signature || isZipDownloading || isSubmitting) {
      clearAutoZipTimer();
      return;
    }

    clearAutoZipTimer();
    setAutoZipCountdown(5);

    autoZipIntervalRef.current = setInterval(() => {
      setAutoZipCountdown(prev => (prev > 0 ? prev - 1 : 0));
    }, 1000);

    autoZipTimeoutRef.current = setTimeout(() => {
      autoZipSignatureRef.current = signature;
      handleDownloadZip();
    }, 5000);

    return () => {
      clearAutoZipTimer();
    };
  }, [clearAutoZipTimer, files, getCompletedUuidIds, handleDownloadZip, isSubmitting, isZipDownloading]);

  // ─────────────────────────────────────────────────────────────────────────
  return (
    <div className="mx-auto flex min-h-screen w-full max-w-7xl flex-col gap-6 px-4 pb-14 pt-6 md:px-8 lg:px-10">
      <header className="overflow-hidden rounded-[28px] border border-white/10 bg-gradient-to-br from-slate-900/95 via-[#101936]/95 to-[#06202d]/95 p-6 shadow-2xl shadow-black/35 backdrop-blur md:p-8">
        <div className="flex flex-col gap-6 lg:flex-row lg:items-start lg:justify-between">
          <div className="max-w-2xl">
            <div className="mb-4 inline-flex items-center gap-3 rounded-full border border-white/10 bg-white/5 px-3 py-2 text-xs font-semibold uppercase tracking-[0.25em] text-cyan-200/80">
              <span className="text-lg">♫</span>
              Audio Lab
            </div>
            <h1 className="max-w-xl text-4xl font-black leading-tight text-white md:text-5xl">
              Convert playlists and tracks into crisp MP3 batches.
            </h1>
            <p className="mt-3 max-w-2xl text-sm leading-7 text-slate-300 md:text-base">
              Queue local M4A files, individual YouTube links, or playlist slices like 1-50 and 51-100 with a cleaner batch workflow.
            </p>
          </div>

          <div className="grid grid-cols-2 gap-3 md:min-w-[320px]">
            <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
              <div className="text-xs uppercase tracking-[0.2em] text-slate-400">Queued</div>
              <div className="mt-2 text-3xl font-bold text-white">{total}</div>
            </div>
            <div className="rounded-2xl border border-emerald-400/20 bg-emerald-400/10 p-4">
              <div className="text-xs uppercase tracking-[0.2em] text-emerald-200/80">Completed</div>
              <div className="mt-2 text-3xl font-bold text-emerald-200">{completed}</div>
            </div>
            <div className="rounded-2xl border border-rose-400/20 bg-rose-500/10 p-4">
              <div className="text-xs uppercase tracking-[0.2em] text-rose-200/80">Failed</div>
              <div className="mt-2 text-3xl font-bold text-rose-200">{failed}</div>
            </div>
            <div className="rounded-2xl border border-indigo-400/20 bg-indigo-500/10 p-4">
              <div className="text-xs uppercase tracking-[0.2em] text-indigo-200/80">Progress</div>
              <div className="mt-2 text-3xl font-bold text-indigo-100">{progress}%</div>
            </div>
          </div>
        </div>
      </header>

      <section className="rounded-[28px] border border-white/10 bg-slate-900/80 p-4 shadow-2xl shadow-black/30 backdrop-blur md:p-6">
        <div className="mb-5 inline-flex flex-wrap gap-2 rounded-2xl border border-white/10 bg-slate-950/60 p-1">
          <button
            className={`rounded-xl px-4 py-2 text-sm font-semibold transition ${activeTab === 'local' ? 'bg-gradient-to-r from-indigo-500 to-cyan-400 text-slate-950 shadow-lg shadow-indigo-500/30' : 'text-slate-300 hover:bg-white/5'}`}
            onClick={() => setActiveTab('local')}
          >
            Local M4A Files
          </button>
          <button
            className={`rounded-xl px-4 py-2 text-sm font-semibold transition ${activeTab === 'youtube' ? 'bg-gradient-to-r from-rose-500 to-orange-400 text-white shadow-lg shadow-rose-500/25' : 'text-slate-300 hover:bg-white/5'}`}
            onClick={() => setActiveTab('youtube')}
          >
            YouTube To MP3
          </button>
          <button
            className={`rounded-xl px-4 py-2 text-sm font-semibold transition ${activeTab === 'video' ? 'bg-gradient-to-r from-emerald-500 to-teal-400 text-slate-950 shadow-lg shadow-emerald-500/25' : 'text-slate-300 hover:bg-white/5'}`}
            onClick={() => setActiveTab('video')}
          >
            YouTube Video
          </button>
        </div>

        {activeTab === 'local' ? (
          <div
            className={`group relative overflow-hidden rounded-[24px] border border-dashed px-6 py-14 text-center transition ${dragOver ? 'border-cyan-300/70 bg-cyan-400/10 shadow-[0_0_0_1px_rgba(125,211,252,0.35)]' : 'border-white/15 bg-gradient-to-br from-slate-900/80 via-[#10152b]/80 to-[#132233]/80 hover:border-indigo-300/40 hover:bg-white/[0.03]'}`}
            onClick={() => !isSubmitting && inputRef.current.click()}
            onDragOver={e => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={onDrop}
          >
            <div className="mx-auto flex h-20 w-20 items-center justify-center rounded-3xl bg-white/5 text-4xl shadow-inner shadow-white/5">🎧</div>
            <p className="mt-5 text-2xl font-bold text-white">Drop your .m4a files here</p>
            <p className="mx-auto mt-2 max-w-xl text-sm leading-6 text-slate-300">
              Drag files in or click anywhere in this card to browse. Batch limit is 50 files and up to 300 MB per file.
            </p>
            <input
              ref={inputRef}
              type="file"
              multiple
              accept=".m4a"
              className="hidden"
              onChange={e => addFiles(e.target.files)}
            />
          </div>
        ) : activeTab === 'youtube' ? (
          <form onSubmit={handleYoutubeSubmit} className="space-y-5 rounded-[24px] border border-white/10 bg-gradient-to-br from-[#11182d]/90 to-[#09141f]/90 p-5 md:p-6">
            <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
              <div>
                <h2 className="text-2xl font-bold text-white">YouTube to MP3 Queue</h2>
                <p className="mt-1 text-sm text-slate-300">
                  {ytMode === 'playlist'
                    ? 'Paste a playlist and choose a range. Use chunks like 1-50, 51-100, 101-150.'
                    : 'Paste up to 50 individual video URLs. The server queues and converts each one.'}
                </p>
              </div>
              <div className="inline-flex rounded-2xl border border-white/10 bg-slate-950/50 p-1">
                <button
                  type="button"
                  className={`rounded-xl px-4 py-2 text-sm font-semibold transition ${ytMode === 'videos' ? 'bg-white text-slate-950' : 'text-slate-300 hover:bg-white/5'}`}
                  onClick={() => setYtMode('videos')}
                  disabled={ytLoading}
                >
                  Video Links
                </button>
                <button
                  type="button"
                  className={`rounded-xl px-4 py-2 text-sm font-semibold transition ${ytMode === 'playlist' ? 'bg-white text-slate-950' : 'text-slate-300 hover:bg-white/5'}`}
                  onClick={() => setYtMode('playlist')}
                  disabled={ytLoading}
                >
                  Playlist Range
                </button>
              </div>
            </div>

            {ytMode === 'playlist' ? (
              <div className="space-y-4">
                <input
                  type="text"
                  value={playlistUrl}
                  onChange={e => setPlaylistUrl(e.target.value)}
                  placeholder="https://www.youtube.com/playlist?list=..."
                  required
                  className="w-full rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-white outline-none transition placeholder:text-slate-500 focus:border-cyan-300/60 focus:bg-white/[0.07]"
                />
                <div className="grid gap-4 md:grid-cols-2">
                  <label className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
                    <span className="mb-2 block text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">Start</span>
                    <input
                      type="number"
                      min="1"
                      max={playlistTotalVideos || undefined}
                      value={playlistStart}
                      onChange={e => setPlaylistStart(e.target.value)}
                      required
                      className="w-full bg-transparent text-2xl font-bold text-white outline-none"
                    />
                  </label>
                  <label className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
                    <span className="mb-2 block text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">End</span>
                    <input
                      type="number"
                      min="1"
                      max={playlistTotalVideos || undefined}
                      value={playlistEnd}
                      onChange={e => setPlaylistEnd(e.target.value)}
                      required
                      className="w-full bg-transparent text-2xl font-bold text-white outline-none"
                    />
                  </label>
                </div>
                <div className="rounded-2xl border border-cyan-300/15 bg-cyan-300/5 px-4 py-3 text-sm text-cyan-100/90">
                  Total videos in playlist: <span className="font-bold">{playlistMetaLoading ? '...' : playlistTotalVideos}</span>
                  <span className="mx-2 text-cyan-200/70">|</span>
                  Current range count: <span className="font-bold">{playlistSelectedCount}</span>
                </div>
              </div>
            ) : (
              <textarea
                value={ytUrls}
                onChange={e => setYtUrls(e.target.value)}
                placeholder={`https://www.youtube.com/watch?v=XXXX\nhttps://www.youtube.com/watch?v=YYYY\nhttps://www.youtube.com/watch?v=ZZZZ`}
                required
                rows={7}
                className="w-full rounded-2xl border border-white/10 bg-white/5 px-4 py-4 font-mono text-sm text-white outline-none transition placeholder:text-slate-500 focus:border-cyan-300/60 focus:bg-white/[0.07]"
              />
            )}

            <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
              <div className="rounded-2xl border border-amber-300/10 bg-amber-300/5 px-4 py-3 text-sm text-amber-100/80">
                {ytMode === 'playlist'
                  ? 'Queue in safe ranges of 50: 1-50, then 51-100, then 101-150.'
                  : 'Queue up to 50 direct links per batch for cleaner tracking and downloads.'}
              </div>
              <button
                type="submit"
                disabled={ytLoading}
                className="inline-flex items-center justify-center rounded-2xl bg-gradient-to-r from-rose-500 via-orange-400 to-amber-300 px-6 py-3 text-sm font-extrabold text-slate-950 shadow-xl shadow-rose-500/25 transition hover:scale-[1.01] disabled:cursor-not-allowed disabled:opacity-50"
              >
                {ytLoading ? 'Queuing…' : 'Queue & Convert to MP3'}
              </button>
            </div>
          </form>
        ) : activeTab === 'video' ? (
          <form onSubmit={handleYoutubeVideoSubmit} className="space-y-5 rounded-[24px] border border-white/10 bg-gradient-to-br from-[#11182d]/90 to-[#09141f]/90 p-5 md:p-6">
            <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
              <div>
                <h2 className="text-2xl font-bold text-white">YouTube Video Downloader</h2>
                <p className="mt-1 text-sm text-slate-300">
                  Paste a video URL to get available resolutions. Max 1 video at a time.
                </p>
              </div>
            </div>
            
            <div className="space-y-4">
              <input
                type="text"
                value={ytVideoUrl}
                onChange={e => { setYtVideoUrl(e.target.value); setYtVideoFormats([]); setYtVideoTitle(''); }}
                placeholder="https://www.youtube.com/watch?v=..."
                required
                className="w-full rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-white outline-none transition placeholder:text-slate-500 focus:border-emerald-300/60 focus:bg-white/[0.07]"
              />
              {ytVideoTitle && (
                <div className="mt-3 flex items-start gap-2 rounded-2xl border border-emerald-400/20 bg-emerald-500/10 px-4 py-3">
                  <span className="mt-0.5 text-emerald-400 text-lg flex-shrink-0">🎬</span>
                  <p className="text-sm font-semibold text-emerald-100 leading-snug">{ytVideoTitle}</p>
                </div>
              )}
              {ytVideoFormats.length > 0 ? (
                <div className="flex flex-wrap gap-2 mt-4">
                  {ytVideoFormats.map(q => (
                    <button
                      key={q}
                      type="button"
                      onClick={() => setSelectedQuality(q)}
                      className={`px-4 py-2 rounded-xl text-sm font-bold transition-all ${
                        selectedQuality === q 
                          ? 'bg-emerald-500 text-white shadow-lg shadow-emerald-500/30' 
                          : 'bg-white/10 text-slate-300 hover:bg-white/20'
                      }`}
                    >
                      {q}p
                    </button>
                  ))}
                </div>
              ) : null}
            </div>

            <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between mt-4">
              <div className="rounded-2xl border border-amber-300/10 bg-amber-300/5 px-4 py-3 text-sm text-amber-100/80">
                You can download video using available qualities.
              </div>
              
              {!ytVideoFormats.length ? (
                <button
                  type="button"
                  onClick={handleGetFormats}
                  disabled={ytLoading}
                  className="inline-flex items-center justify-center rounded-2xl bg-gradient-to-r from-emerald-500 to-teal-400 px-6 py-3 text-sm font-extrabold text-slate-950 shadow-xl shadow-emerald-500/25 transition hover:scale-[1.01] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {ytLoading ? 'Fetching Qualities...' : 'Get Video Qualities'}
                </button>
              ) : (
                <button
                  type="submit"
                  disabled={ytLoading || !selectedQuality}
                  className="inline-flex items-center justify-center rounded-2xl bg-gradient-to-r from-emerald-500 to-teal-400 px-6 py-3 text-sm font-extrabold text-slate-950 shadow-xl shadow-emerald-500/25 transition hover:scale-[1.01] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {ytLoading ? 'Queuing…' : 'Queue & Download MP4'}
                </button>
              )}
            </div>
          </form>
        ) : null}
      </section>

      {total > 0 && (
        <section className="space-y-4 rounded-[28px] border border-white/10 bg-slate-900/80 p-4 shadow-2xl shadow-black/30 backdrop-blur md:p-6">
          <div className="flex flex-wrap items-center gap-3">
            <button
              className="rounded-2xl bg-gradient-to-r from-indigo-500 to-cyan-400 px-5 py-3 text-sm font-bold text-slate-950 shadow-lg shadow-indigo-500/30 disabled:cursor-not-allowed disabled:opacity-40"
              onClick={handleConvert}
              disabled={isSubmitting || !files.some(f => f.status === 'queued')}
            >
              {isSubmitting ? 'Converting…' : `Convert ${files.filter(f => f.status === 'queued').length} file(s)`}
            </button>
            {completed > 0 && (
              <button
                className="rounded-2xl bg-emerald-500 px-5 py-3 text-sm font-bold text-white shadow-lg shadow-emerald-500/25 disabled:cursor-not-allowed disabled:opacity-50"
                onClick={handleDownloadZip}
                disabled={isSubmitting || isZipDownloading}
              >
                {isZipDownloading
                  ? (zipDownloadPct > 0 ? `Downloading ZIP ${zipDownloadPct}%` : (zipDownloadLabel || 'Preparing ZIP...'))
                  : (autoZipCountdown > 0
                    ? `Download ${completed} as ZIP (${autoZipCountdown}s auto)`
                    : `Download ${completed} as ZIP`)}
              </button>
            )}
            <button
              className="rounded-2xl border border-white/10 bg-white/5 px-5 py-3 text-sm font-semibold text-slate-200 disabled:cursor-not-allowed disabled:opacity-40"
              onClick={clearAll}
              disabled={isSubmitting}
            >
              Clear All
            </button>
          </div>

          {isZipDownloading && (
            <div className="rounded-2xl border border-emerald-300/20 bg-emerald-500/10 p-4">
              <div className="mb-2 flex items-center justify-between text-sm text-emerald-100">
                <span>{zipDownloadLabel || 'Preparing ZIP...'}</span>
                <span>{zipDownloadPct > 0 ? `${zipDownloadPct}%` : 'Working...'}</span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-emerald-200/20">
                <div
                  className={`h-full rounded-full bg-emerald-400 transition-all duration-300 ${zipDownloadPct === 0 ? 'animate-pulse' : ''}`}
                  style={{ width: `${zipDownloadPct > 0 ? zipDownloadPct : 35}%` }}
                />
              </div>
            </div>
          )}

          {isSubmitting && (
            <div className="rounded-2xl border border-white/10 bg-black/20 p-4">
              <div className="mb-2 flex items-center justify-between text-sm text-slate-300">
                <span>Uploading to server</span>
                <span>{uploadPct}%</span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-white/10">
                <div className="h-full rounded-full bg-gradient-to-r from-cyan-400 to-sky-500 transition-all duration-300" style={{ width: `${uploadPct}%` }} />
              </div>
            </div>
          )}

          <div className="rounded-2xl border border-white/10 bg-black/20 p-4">
            <div className="mb-2 flex items-center justify-between text-sm text-slate-300">
              <span>Overall conversion</span>
              <span>{completed + failed} / {total}</span>
            </div>
            <div className="h-3 overflow-hidden rounded-full bg-white/10">
              <div
                className="h-full rounded-full transition-all duration-500"
                style={{
                  width: `${progress}%`,
                  background: failed > 0
                    ? 'linear-gradient(90deg,#818cf8,#fb7185)'
                    : 'linear-gradient(90deg,#4f46e5,#2dd4bf)'
                }}
              />
            </div>
          </div>

          <div className="overflow-hidden rounded-[24px] border border-white/10 bg-black/20">
            <div className="hidden grid-cols-[56px_56px_minmax(320px,1fr)_90px_130px_140px] gap-0 border-b border-white/10 bg-white/5 px-4 py-4 text-xs font-semibold uppercase tracking-[0.18em] text-slate-400 lg:grid">
              <div>#</div>
              <div>Status</div>
              <div>File Name</div>
              <div>Size</div>
              <div>State</div>
              <div>Action</div>
            </div>

            <div className="divide-y divide-white/10">
              {files.map((f, i) => (
                <div
                  key={f.id}
                  className="group relative overflow-hidden transition-all duration-300 hover:bg-white/[0.03]"
                  style={{
                    backgroundImage: `linear-gradient(90deg, rgba(74,222,128,0.1) 0, rgba(74,222,128,0.1) ${ROW_FILL_BY_STATUS[f.status] || '0%'}, transparent ${ROW_FILL_BY_STATUS[f.status] || '0%'}, transparent 100%)`
                  }}
                >
                  {/* Hover Removal Button */}
                  <button 
                    onClick={() => removeFile(f.id)}
                    className="absolute right-3 top-1/2 z-20 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-full bg-rose-500/20 text-rose-300 opacity-0 backdrop-blur transition-all duration-200 hover:bg-rose-500 hover:text-white group-hover:opacity-100"
                    title="Remove from list"
                  >
                    ✕
                  </button>

                  <div className="grid gap-4 px-4 py-4 lg:grid-cols-[56px_56px_minmax(320px,1fr)_90px_130px_140px] lg:items-center">
                    <div className="text-sm text-slate-500">{i + 1}</div>
                    <div><CircleRing status={f.status} /></div>
                    <div className="min-w-0">
                      <div className="truncate text-sm font-semibold text-white" title={f.name}>
                        {f.name}
                        {f.error && <span className="ml-2 text-rose-400">⚠</span>}
                      </div>
                      {f.status === 'failed' && f.error && (
                        <div className="mt-1 whitespace-normal text-xs leading-5 text-rose-200/90">{f.error}</div>
                      )}
                    </div>
                    <div className="text-sm text-slate-400">{fmtBytes(f.size)}</div>
                    <div>
                      <span className={`inline-flex rounded-full px-3 py-1 text-xs font-bold ${STATUS_STYLES[f.status] || STATUS_STYLES.queued}`}>
                        {STATUS_LABEL[f.status] || f.status}
                      </span>
                    </div>
                    <div>
                      {f.status === 'completed' && f.downloadUrl ? (
                        <div className="w-full">
                          <button
                            className="rounded-xl bg-emerald-500 px-4 py-2 text-xs font-bold text-white shadow-md shadow-emerald-500/25 disabled:cursor-not-allowed disabled:opacity-60"
                            onClick={() => handleDownload(f.downloadUrl, f.name, f.id)}
                            disabled={!!downloadingFileIds[f.id]}
                          >
                            {downloadingFileIds[f.id]
                              ? `Downloading${fileDownloadPctById[f.id] > 0 ? ` ${fileDownloadPctById[f.id]}%` : '...'}`
                              : 'Download'}
                          </button>
                          {downloadingFileIds[f.id] && (
                            <div className="mt-2 w-full">
                              <div className="h-1.5 overflow-hidden rounded-full bg-emerald-200/20">
                                <div
                                  className={`h-full rounded-full bg-emerald-400 transition-all duration-300 ${!fileDownloadPctById[f.id] ? 'animate-pulse' : ''}`}
                                  style={{ width: `${fileDownloadPctById[f.id] > 0 ? fileDownloadPctById[f.id] : 35}%` }}
                                />
                              </div>
                            </div>
                          )}
                        </div>
                      ) : f.status === 'queued' ? (
                        <button
                          className="rounded-xl border border-rose-300/20 bg-rose-500/10 px-4 py-2 text-xs font-bold text-rose-200"
                          onClick={() => removeFile(f.id)}
                        >
                          Remove
                        </button>
                      ) : (
                        <span className="text-sm text-slate-500">—</span>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>
      )}

      {total === 0 && (
        <section className="rounded-[28px] border border-dashed border-white/10 bg-slate-900/50 px-6 py-14 text-center text-slate-400">
          <div className="mx-auto max-w-xl">
            <p className="text-2xl font-bold text-white">Nothing queued yet.</p>
            <p className="mt-2 text-sm leading-6">
              Add local files, direct links, or a playlist range to start building your MP3 batch.
            </p>
          </div>
        </section>
      )}

      <footer className="border-t border-white/10 pt-3 text-center text-xs text-slate-500">
        Converted files are automatically deleted after 1 hour · Max 50 files per batch
      </footer>
    </div>
  );
}
