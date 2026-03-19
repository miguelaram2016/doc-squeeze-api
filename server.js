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

async function runQpdf(input, output) {
  await execFileAsync('qpdf', [
    '--linearize',
    '--object-streams=generate',
    input,
    output,
  ]);
}

async function runGhostscript(input, output, level) {
  const qualityMap = {
    low: '/printer',
    medium: '/ebook',
    high: '/screen',
  };

  const quality = qualityMap[level] || '/ebook';

  await execFileAsync('gs', [
    '-sDEVICE=pdfwrite',
    '-dCompatibilityLevel=1.4',
    `-dPDFSETTINGS=${quality}`,
    '-dNOPAUSE',
    '-dQUIET',
    '-dBATCH',
    `-sOutputFile=${output}`,
    input,
  ]);
}

async function compressPdf(buffer, originalName, level) {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'docsqueeze-'));
  try {
    const inputPath = path.join(tmpDir, 'input.pdf');
    const qpdfPath = path.join(tmpDir, 'qpdf.pdf');
    const outputPath = path.join(tmpDir, 'output.pdf');

    await fs.writeFile(inputPath, buffer);
    await runQpdf(inputPath, qpdfPath);
    await runGhostscript(qpdfPath, outputPath, level);

    const compressedBuffer = await fs.readFile(outputPath);
    const compressedSize = (await fs.stat(outputPath)).size;

    return {
      originalName,
      originalSize: buffer.length,
      compressedSize,
      compressedBase64: compressedBuffer.toString('base64'),
    };
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

// ── Single-file compress (existing, unchanged) ───────────────────────────────

app.post('/api/compress', upload.single('file'), async (req, res) => {
  let tmpDir = '';

  try {
    const level = req.body.level || 'medium';

    if (!req.file) {
      return res.status(400).json({ error: 'No file provided' });
    }

    if (req.file.mimetype !== 'application/pdf') {
      return res.status(400).json({ error: 'Only PDF files are supported' });
    }

    console.log(`Processing file: ${req.file.originalname}, size: ${req.file.size}, level: ${level}`);

    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'docsqueeze-'));
    const inputPath = path.join(tmpDir, 'input.pdf');
    const qpdfPath = path.join(tmpDir, 'qpdf.pdf');
    const outputPath = path.join(tmpDir, 'output.pdf');

    await fs.writeFile(inputPath, req.file.buffer);

    await runQpdf(inputPath, qpdfPath);
    await runGhostscript(qpdfPath, outputPath, level);

    const result = await fs.readFile(outputPath);
    const stats = await fs.stat(outputPath);

    await incrementCount();

    console.log(`Compression complete. Original: ${req.file.size}, Compressed: ${stats.size}`);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="compressed_${req.file.originalname}"`);
    res.send(result);

  } catch (err) {
    console.error('Compression error:', err);
    res.status(500).json({
      error: err.message || 'Compression failed',
      details: err.stack
    });
  } finally {
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
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

// ── Start ─────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`DocSqueeze API running on port ${PORT}`);
});
