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

// Enable CORS for Vercel frontend
app.use(cors({
  origin: ['https://doc-squeeze.vercel.app', 'http://localhost:3000'],
  methods: ['POST', 'GET', 'OPTIONS'],
  credentials: true
}));

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'doc-squeeze-api' });
});

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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`DocSqueeze API running on port ${PORT}`);
});
