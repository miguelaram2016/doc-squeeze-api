const express = require('express');
const multer = require('multer');
const { execFile } = require('child_process');
const { promisify } = require('util');
const fs = require('fs/promises');
const path = require('path');
const os = require('os');
const cors = require('cors');

const execFileAsync = promisify(execFile);
const app = express();
const upload = multer({ limits: { fileSize: 100 * 1024 * 1024 } }); // 100MB limit
const statsPath = '/tmp/stats.json';

// ── Stats helpers ────────────────────────────────────────────────────────────

async function readStats() {
  try {
    const data = await fs.readFile(statsPath, 'utf8');
    return JSON.parse(data);
  } catch {
    return { count: 0, lastUpdated: null };
  }
}

async function writeStats(stats) {
  stats.lastUpdated = new Date().toISOString();
  await fs.writeFile(statsPath, JSON.stringify(stats, null, 2));
}

async function incrementCount() {
  const stats = await readStats();
  stats.count += 1;
  await writeStats(stats);
}

// ── CORS ─────────────────────────────────────────────────────────────────────

app.use(cors({
  origin: ['https://doc-squeeze.vercel.app', 'http://localhost:3000'],
  methods: ['POST', 'GET', 'OPTIONS'],
  credentials: true
}));

// ── Health check ─────────────────────────────────────────────────────────────

app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'doc-squeeze-api' });
});

// ── Stats endpoint ───────────────────────────────────────────────────────────

app.get('/api/stats', async (req, res) => {
  try {
    const stats = await readStats();
    res.json({ count: stats.count });
  } catch (err) {
    res.status(500).json({ error: 'Failed to read stats' });
  }
});

// ── PDF helpers ─────────────────────────────────────────────────────────────

// qpdf with actual compression (recompress streams with zlib)
async function runQpdfCompress(input, output) {
  await execFileAsync('qpdf', [
    '--compress-streams=y',
    '--compression-level=9',
    '--object-streams=generate',
    input,
    output,
  ]);
}

// Ghostscript compression - force JPEG recompression at target quality
async function runGhostscriptRecompress(input, output, level) {
  // Target DPI for each level
  const dpi = level === 'high' ? 72 : level === 'medium' ? 120 : 200;
  
  // Force JPEG recompression with explicit settings
  // -dColorImageResolution sets target DPI for color images
  // -dAutoFilterColorImages=false disables auto filter selection  
  // -dColorImageFilter=/DCTEncode forces JPEG encoding
  await execFileAsync('gs', [
    '-sDEVICE=pdfwrite',
    '-dCompatibilityLevel=1.4',
    '-dNOPAUSE',
    '-dQUIET',
    '-dBATCH',
    `-dColorImageResolution=${dpi}`,
    `-dGrayImageResolution=${dpi}`,
    '-dAutoFilterColorImages=false',
    '-dColorImageFilter=/DCTEncode',
    '-dAutoFilterGrayImages=false', 
    '-dGrayImageFilter=/DCTEncode',
    '-dEncodeColorImages=true',
    '-dEncodeGrayImages=true',
    `-sOutputFile=${output}`,
    input,
  ]);
}

// Compress a PDF buffer — returns { buffer, size }
// Tries qpdf compression, optionally also ghostscript, picks the smaller result
async function compressPdf(buffer, originalName, level) {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'docsqueeze-'));
  try {
    const inputPath = path.join(tmpDir, 'input.pdf');
    const qpdfPath = path.join(tmpDir, 'qpdf.pdf');
    const gsPath = path.join(tmpDir, 'gs.pdf');

    await fs.writeFile(inputPath, buffer);

    // Step 1: qpdf recompress (always — this is the baseline compression)
    await runQpdfCompress(inputPath, qpdfPath);
    const qpdfResult = await fs.readFile(qpdfPath);
    const qpdfSize = (await fs.stat(qpdfPath)).size;

    // Step 2: ghostscript only for medium/high (aggressive image recompression)
    // Skip for low quality (best quality, minimal compression)
    // Skip entirely if qpdf output is already >= original (avoid inflating)
    let finalBuffer = qpdfResult;
    let finalSize = qpdfSize;

    if (level !== 'low' && qpdfSize < buffer.length) {
      try {
        await runGhostscriptRecompress(qpdfPath, gsPath, level);
        const gsSize = (await fs.stat(gsPath)).size;
        // Only use gs output if it's actually smaller than qpdf output
        if (gsSize < qpdfSize) {
          finalBuffer = await fs.readFile(gsPath);
          finalSize = gsSize;
        }
      } catch (gsErr) {
        console.warn(`Ghostscript failed for ${originalName}, using qpdf only:`, gsErr.message);
      }
    }

    // Safety: never return a file larger than the original
    if (finalSize >= buffer.length) {
      finalBuffer = qpdfResult;
      finalSize = qpdfSize;
    }

    return {
      originalName,
      originalSize: buffer.length,
      compressedSize: finalSize,
      compressedBase64: finalBuffer.toString('base64'),
    };
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

// ── Single-file compress ──────────────────────────────────────────────────────

app.post('/api/compress', upload.single('file'), async (req, res) => {
  try {
    const level = req.body.level || 'medium';

    if (!req.file) {
      return res.status(400).json({ error: 'No file provided' });
    }

    if (req.file.mimetype !== 'application/pdf') {
      return res.status(400).json({ error: 'Only PDF files are supported' });
    }

    console.log(`Compressing: ${req.file.originalname}, ${req.file.size} bytes, level: ${level}`);

    const result = await compressPdf(req.file.buffer, req.file.originalname, level);
    await incrementCount();

    console.log(`Done. ${result.originalSize} → ${result.compressedSize} bytes (${Math.round((1 - result.compressedSize / result.originalSize) * 100)}% reduction)`);

    // Return JSON (frontend decodes base64 and triggers download)
    res.json({
      originalName: result.originalName,
      originalSize: result.originalSize,
      compressedSize: result.compressedSize,
      compressedBase64: result.compressedBase64,
    });

  } catch (err) {
    console.error('Compression error:', err);
    res.status(500).json({ error: err.message || 'Compression failed' });
  }
});

// ── Batch compress ────────────────────────────────────────────────────────────

app.post('/api/batch-compress', upload.array('files', 50), async (req, res) => {
  try {
    const level = req.body.level || 'medium';
    const files = req.files;

    if (!files || files.length === 0) {
      return res.status(400).json({ error: 'No files provided' });
    }

    const nonPdf = files.filter(f => f.mimetype !== 'application/pdf');
    if (nonPdf.length > 0) {
      return res.status(400).json({
        error: 'Only PDF files are supported',
        invalidFiles: nonPdf.map(f => f.originalname),
      });
    }

    console.log(`Batch processing ${files.length} file(s), level: ${level}`);

    const results = [];
    for (const file of files) {
      try {
        const result = await compressPdf(file.buffer, file.originalname, level);
        results.push(result);
        await incrementCount();
      } catch (err) {
        console.error(`Error compressing ${file.originalname}:`, err.message);
        results.push({
          originalName: file.originalname,
          originalSize: file.size,
          error: err.message,
        });
      }
    }

    res.json({ files: results });

  } catch (err) {
    console.error('Batch compression error:', err);
    res.status(500).json({
      error: err.message || 'Batch compression failed',
    });
  }
});

// ── Merge PDFs ────────────────────────────────────────────────────────────────

app.post('/api/merge', upload.array('files', 20), async (req, res) => {
  let tmpDir = '';

  try {
    const files = req.files;

    if (!files || files.length < 2) {
      return res.status(400).json({ error: 'At least 2 PDF files are required to merge' });
    }

    const nonPdf = files.filter(f => f.mimetype !== 'application/pdf');
    if (nonPdf.length > 0) {
      return res.status(400).json({
        error: 'Only PDF files are supported',
        invalidFiles: nonPdf.map(f => f.originalname),
      });
    }

    console.log(`Merging ${files.length} PDF file(s)`);

    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'docsqueeze-'));

    // Write input files preserving order
    const inputPaths = [];
    for (let i = 0; i < files.length; i++) {
      const inputPath = path.join(tmpDir, `input_${String(i).padStart(3, '0')}.pdf`);
      await fs.writeFile(inputPath, files[i].buffer);
      inputPaths.push(inputPath);
    }

    const outputPath = path.join(tmpDir, 'merged.pdf');

    // Prefer pdfunite (poppler-utils), fall back to ghostscript
    const hasPdfunite = await commandExists('pdfunite');

    if (hasPdfunite) {
      await execFileAsync('pdfunite', [...inputPaths, outputPath]);
    } else {
      // Ghostscript merge fallback
      const gsArgs = [
        '-dBATCH',
        '-dNOPAUSE',
        '-q',
        '-sDEVICE=pdfwrite',
        `-sOutputFile=${outputPath}`,
        ...inputPaths,
      ];
      await execFileAsync('gs', gsArgs);
    }

    const result = await fs.readFile(outputPath);
    const stats = await fs.stat(outputPath);

    await incrementCount();

    console.log(`Merge complete. Output size: ${stats.size}`);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="merged.pdf"');
    res.send(result);

  } catch (err) {
    console.error('Merge error:', err);
    res.status(500).json({
      error: err.message || 'Merge failed',
      details: err.stack,
    });
  } finally {
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }
});

// ── Split PDF ─────────────────────────────────────────────────────────────────

app.post('/api/split', upload.single('file'), async (req, res) => {
  let tmpDir = '';

  try {
    const file = req.file;
    const mode = req.body.mode || 'by_pages';
    const ranges = req.body.ranges || '';

    if (!file) {
      return res.status(400).json({ error: 'No file provided' });
    }

    if (file.mimetype !== 'application/pdf') {
      return res.status(400).json({ error: 'Only PDF files are supported' });
    }

    if (!['by_pages', 'range'].includes(mode)) {
      return res.status(400).json({ error: 'Mode must be "by_pages" or "range"' });
    }

    if (mode === 'range' && !ranges) {
      return res.status(400).json({ error: 'ranges parameter is required when mode is "range"' });
    }

    console.log(`Splitting file: ${file.originalname}, mode: ${mode}, ranges: ${ranges}`);

    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'docsqueeze-'));
    const inputPath = path.join(tmpDir, 'input.pdf');
    const outputPath = path.join(tmpDir, 'output.pdf');

    await fs.writeFile(inputPath, file.buffer);

    if (mode === 'by_pages') {
      // Split each page into its own PDF using qpdf
      // Output: a multi-section PDF where each page is a separate section
      // We use qpdf --split-pages to create page-per-file output
      // qpdf --split-pages input.pdf will produce input.pdf.1, input.pdf.2, etc.
      const splitPrefix = path.join(tmpDir, 'split_page');
      await execFileAsync('qpdf', ['--split-pages', '--', inputPath, splitPrefix]);

      // Read all generated page files and return them bundled
      // Since we return a single file download, use qpdf --pages to reassemble
      // the requested pages into one output
      const pageFiles = await fs.readdir(tmpDir);
      const pageFilesSorted = pageFiles
        .filter(f => f.startsWith('split_page') && f.endsWith('.pdf'))
        .sort();

      if (pageFilesSorted.length === 0) {
        throw new Error('No pages found in PDF (file may have 0 pages)');
      }

      // Reassemble all pages into a single output PDF
      const splitPaths = pageFilesSorted.map(f => path.join(tmpDir, f));
      await execFileAsync('qpdf', ['--pages', ...splitPaths, '--', inputPath, outputPath]);

    } else {
      // mode === 'range': parse ranges like "1-3,4,5-7"
      const pageRanges = parseRanges(ranges);
      if (pageRanges.length === 0) {
        return res.status(400).json({ error: 'Invalid ranges format. Use like "1-3,4,5-7"' });
      }

      // Build qpdf page selection args
      // qpdf --pages input.pdf 1-3 4 5-7 -- output.pdf
      // We need to flatten all individual ranges into page selections
      const allPages = [];
      for (const r of pageRanges) {
        if (r.start === r.end) {
          allPages.push(String(r.start));
        } else {
          allPages.push(`${r.start}-${r.end}`);
        }
      }

      await execFileAsync('qpdf', ['--pages', inputPath, ...allPages, '--', inputPath, outputPath]);
    }

    const result = await fs.readFile(outputPath);
    const stats = await fs.stat(outputPath);

    await incrementCount();

    console.log(`Split complete. Output size: ${stats.size}`);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="split.pdf"');
    res.send(result);

  } catch (err) {
    console.error('Split error:', err);
    res.status(500).json({
      error: err.message || 'Split failed',
      details: err.stack,
    });
  } finally {
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }
});

// ── Range parser ──────────────────────────────────────────────────────────────

/**
 * Parse comma-separated page ranges like "1-3,4,5-7" into [{start,end}, ...]
 * @param {string} rangesStr
 * @returns {{start: number, end: number}[]}
 */
function parseRanges(rangesStr) {
  const ranges = [];
  const parts = rangesStr.split(',').map(s => s.trim()).filter(Boolean);

  for (const part of parts) {
    // Match "n" or "n-m"
    const single = part.match(/^(\d+)$/);
    const range = part.match(/^(\d+)-(\d+)$/);

    if (single) {
      const n = parseInt(single[1], 10);
      ranges.push({ start: n, end: n });
    } else if (range) {
      const start = parseInt(range[1], 10);
      const end = parseInt(range[2], 10);
      if (start > 0 && end > 0 && start <= end) {
        ranges.push({ start, end });
      }
    }
    // Skip invalid parts silently (or could throw)
  }

  return ranges;
}

// ── Start ─────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`DocSqueeze API running on port ${PORT}`);
});
