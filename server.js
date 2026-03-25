const express = require('express');
const multer = require('multer');
const helmet = require('helmet');
const { execFile } = require('child_process');
const { promisify } = require('util');
const fs = require('fs/promises');
const path = require('path');
const os = require('os');
const cors = require('cors');

const execFileAsync = promisify(execFile);
const statsPath = '/tmp/stats.json';
const VALID_COMPRESSION_LEVELS = new Set(['ultra', 'high', 'medium', 'low', 'minimal']);

class AppError extends Error {
  constructor(statusCode, message, options = {}) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.publicMessage = options.publicMessage || message;
    this.code = options.code || 'APP_ERROR';
    this.cause = options.cause;
  }
}

function createApp(deps = {}) {
  const app = express();
  const tools = {
    execFileAsync: deps.execFileAsync || execFileAsync,
    fs: deps.fs || fs,
    incrementCount: deps.incrementCount || incrementCount,
  };

  const upload = multer({
    limits: { fileSize: 100 * 1024 * 1024, files: 50 },
    fileFilter: (req, file, cb) => {
      if (file.mimetype !== 'application/pdf') {
        return cb(new AppError(400, 'Only PDF files are supported'));
      }
      cb(null, true);
    },
  });

  app.disable('x-powered-by');
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(cors({
    origin: ['https://doc-squeeze.vercel.app', 'http://localhost:3000'],
    methods: ['POST', 'GET', 'OPTIONS'],
    credentials: true,
  }));

  app.get('/', (req, res) => {
    res.json({ status: 'ok', service: 'doc-squeeze-api' });
  });

  app.get('/api/stats', async (req, res, next) => {
    try {
      const stats = await readStats(tools.fs);
      res.json({ count: stats.count });
    } catch (err) {
      next(new AppError(500, 'Failed to read stats', { cause: err }));
    }
  });

  app.post('/api/compress', upload.single('file'), asyncHandler(async (req, res) => {
    const level = normalizeCompressionLevel(req.body.level);

    if (!req.file) {
      throw new AppError(400, 'No file provided');
    }

    console.log(`Compressing: ${req.file.originalname}, ${req.file.size} bytes, level: ${level}`);

    await validateUploadedPdf(req.file.buffer, req.file.originalname, tools);
    const result = await compressPdf(req.file.buffer, req.file.originalname, level, tools);
    await tools.incrementCount();

    console.log(`Done. ${result.originalSize} → ${result.compressedSize} bytes (${Math.round((1 - result.compressedSize / result.originalSize) * 100)}% reduction)`);

    res.json(result);
  }));

  app.post('/api/batch-compress', upload.array('files', 50), asyncHandler(async (req, res) => {
    const level = normalizeCompressionLevel(req.body.level);
    const files = req.files;

    if (!files || files.length === 0) {
      throw new AppError(400, 'No files provided');
    }

    console.log(`Batch processing ${files.length} file(s), level: ${level}`);

    const results = [];
    for (const file of files) {
      try {
        await validateUploadedPdf(file.buffer, file.originalname, tools);
        const result = await compressPdf(file.buffer, file.originalname, level, tools);
        results.push(result);
        await tools.incrementCount();
      } catch (err) {
        const mapped = mapToolError(err, 'compress');
        console.error(`Error compressing ${file.originalname}:`, err.message);
        results.push({
          originalName: file.originalname,
          originalSize: file.size,
          error: mapped.publicMessage,
        });
      }
    }

    res.json({ files: results });
  }));

  app.post('/api/merge', upload.array('files', 20), asyncHandler(async (req, res) => {
    const files = req.files;

    if (!files || files.length < 2) {
      throw new AppError(400, 'At least 2 PDF files are required to merge');
    }

    console.log(`Merging ${files.length} PDF file(s)`);

    const result = await withTempDir(async (tmpDir) => {
      const inputPaths = [];
      for (let i = 0; i < files.length; i += 1) {
        const inputPath = path.join(tmpDir, `input_${String(i).padStart(3, '0')}.pdf`);
        await tools.fs.writeFile(inputPath, files[i].buffer);
        await validatePdfFile(inputPath, tools);
        inputPaths.push(inputPath);
      }

      const outputPath = path.join(tmpDir, 'merged.pdf');
      await mergePdfFiles(inputPaths, outputPath, files, tools);
      return tools.fs.readFile(outputPath);
    }, tools.fs);

    await tools.incrementCount();
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="merged.pdf"');
    res.send(result);
  }));

  app.post('/api/split', upload.single('file'), asyncHandler(async (req, res) => {
    const file = req.file;
    const mode = req.body.mode || 'by_pages';
    const ranges = req.body.ranges || '';

    if (!file) {
      throw new AppError(400, 'No file provided');
    }

    if (!['by_pages', 'range'].includes(mode)) {
      throw new AppError(400, 'Mode must be "by_pages" or "range"');
    }

    console.log(`Splitting file: ${file.originalname}, mode: ${mode}, ranges: ${ranges}`);

    const result = await withTempDir(async (tmpDir) => {
      const inputPath = path.join(tmpDir, 'input.pdf');
      const outputPath = path.join(tmpDir, 'output.pdf');
      await tools.fs.writeFile(inputPath, file.buffer);
      await validatePdfFile(inputPath, tools);

      const pageCount = await getPdfPageCount(inputPath, tools);
      let selections;

      if (mode === 'by_pages') {
        selections = Array.from({ length: pageCount }, (_, index) => String(index + 1));
      } else {
        const parsedRanges = parseRanges(ranges);
        validateRanges(parsedRanges, pageCount);
        selections = buildPageSelections(parsedRanges);
      }

      await runQpdfPageSelection(inputPath, selections, outputPath, tools);
      return tools.fs.readFile(outputPath);
    }, tools.fs);

    await tools.incrementCount();
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="split.pdf"');
    res.send(result);
  }));

  app.use((err, req, res, next) => {
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ error: 'File too large. Maximum size is 100MB.' });
      }
      return res.status(400).json({ error: 'Invalid upload payload.' });
    }

    const mapped = mapToolError(err, req.path);
    if (mapped.statusCode >= 500) {
      console.error(`${req.method} ${req.path} failed:`, err);
    }
    res.status(mapped.statusCode).json({ error: mapped.publicMessage });
  });

  return app;
}

async function readStats(fsModule = fs) {
  try {
    const data = await fsModule.readFile(statsPath, 'utf8');
    return JSON.parse(data);
  } catch {
    return { count: 0, lastUpdated: null };
  }
}

async function writeStats(stats, fsModule = fs) {
  stats.lastUpdated = new Date().toISOString();
  await fsModule.writeFile(statsPath, JSON.stringify(stats, null, 2));
}

async function incrementCount() {
  const stats = await readStats();
  stats.count += 1;
  await writeStats(stats);
}

async function runQpdfCompress(input, output, level = 'medium', tools = { execFileAsync }) {
  const qpdfArgs = [
    '--compress-streams=y',
    '--compression-level=9',
    '--object-streams=generate',
  ];

  if (level === 'ultra') {
    qpdfArgs.push('--linearize');
  }

  qpdfArgs.push(input, output);
  await tools.execFileAsync('qpdf', qpdfArgs);
}

async function runGhostscriptRecompress(input, output, level, tools = { execFileAsync }) {
  const settings = {
    ultra: { dpi: 36, preset: '/screen' },
    high: { dpi: 48, preset: '/ebook' },
    medium: { dpi: 72, preset: '/printer' },
    low: { dpi: 96, preset: '/printer' },
    minimal: { dpi: 150, preset: '/prepress' },
  };

  const cfg = settings[level] || settings.medium;
  const gsArgs = [
    '-sDEVICE=pdfwrite',
    '-dCompatibilityLevel=1.4',
    '-dNOPAUSE',
    '-dQUIET',
    '-dBATCH',
    `-dPDFSETTINGS=${cfg.preset}`,
    `-r${cfg.dpi}`,
  ];

  if (level !== 'minimal') {
    gsArgs.push(
      '-dDownsampleColorImages=true',
      '-dDownsampleGrayImages=true',
      '-dDownsampleMonoImages=true',
      '-dColorImageDownsampleType=/Bicubic',
      '-dGrayImageDownsampleType=/Bicubic',
      '-dMonoImageDownsampleType=/Bicubic',
    );
  }

  if (level === 'ultra') {
    gsArgs.push(
      '-dAutoFilterColorImages=true',
      '-dAutoFilterGrayImages=true',
      '-dColorImageFilter=/DCTEncode',
      '-dGrayImageFilter=/DCTEncode',
    );
  }

  gsArgs.push(`-sOutputFile=${output}`, input);
  await tools.execFileAsync('gs', gsArgs);
}

async function validateUploadedPdf(buffer, originalName, tools) {
  return withTempDir(async (tmpDir) => {
    const inputPath = path.join(tmpDir, originalName || 'input.pdf');
    await tools.fs.writeFile(inputPath, buffer);
    await validatePdfFile(inputPath, tools);
  }, tools.fs);
}

async function compressPdf(buffer, originalName, level, tools) {
  return withTempDir(async (tmpDir) => {
    const inputPath = path.join(tmpDir, 'input.pdf');
    const qpdfPath = path.join(tmpDir, 'qpdf.pdf');
    const gsPath = path.join(tmpDir, 'gs.pdf');

    await tools.fs.writeFile(inputPath, buffer);

    try {
      await runQpdfCompress(inputPath, qpdfPath, level, tools);
    } catch (err) {
      throw mapToolError(err, 'compress');
    }

    const qpdfResult = await tools.fs.readFile(qpdfPath);
    const qpdfSize = (await tools.fs.stat(qpdfPath)).size;

    let finalBuffer = qpdfResult;
    let finalSize = qpdfSize;

    try {
      await runGhostscriptRecompress(qpdfPath, gsPath, level, tools);
      const gsSize = (await tools.fs.stat(gsPath)).size;
      if (gsSize < qpdfSize) {
        finalBuffer = await tools.fs.readFile(gsPath);
        finalSize = gsSize;
      }
    } catch (err) {
      console.error(`Ghostscript skipped for ${originalName}:`, err.message);
    }

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
  }, tools.fs);
}

async function mergePdfFiles(inputPaths, outputPath, files, tools) {
  const hasAcroForm = files.some((file) => isLikelyAcroFormPdf(file.buffer));
  const mergeAttempts = [
    {
      tool: 'qpdf',
      args: ['--empty', '--pages', ...inputPaths, '--', outputPath],
      allowedWhenAcroForm: true,
    },
    {
      tool: 'pdfunite',
      args: [...inputPaths, outputPath],
      allowedWhenAcroForm: true,
    },
    {
      tool: 'gs',
      args: [
        '-dBATCH',
        '-dNOPAUSE',
        '-q',
        '-sDEVICE=pdfwrite',
        `-sOutputFile=${outputPath}`,
        ...inputPaths,
      ],
      allowedWhenAcroForm: false,
    },
  ];

  const failures = [];

  for (const attempt of mergeAttempts) {
    if (hasAcroForm && !attempt.allowedWhenAcroForm) {
      failures.push(`${attempt.tool} skipped because AcroForm content was detected`);
      continue;
    }

    try {
      await tools.execFileAsync(attempt.tool, attempt.args);
      return attempt.tool;
    } catch (err) {
      failures.push(`${attempt.tool}: ${sanitizeToolFailure(err)}`);
    }
  }

  const publicMessage = hasAcroForm
    ? 'Unable to merge one or more fillable PDFs. Please flatten the form fields first or try different source files.'
    : 'Unable to merge these PDFs right now. Please verify the files are valid PDFs and try again.';

  throw new AppError(500, publicMessage, {
    code: 'MERGE_FAILED',
    cause: new Error(failures.join(' | ')),
  });
}

async function validatePdfFile(inputPath, tools) {
  try {
    await tools.execFileAsync('qpdf', ['--check', inputPath]);
  } catch (err) {
    const text = sanitizeToolFailure(err).toLowerCase();
    if (text.includes('file is damaged') || text.includes('unable to find trailer dictionary') || text.includes('can\'t find startxref') || text.includes('not a pdf file')) {
      throw new AppError(400, 'The uploaded file is not a valid PDF. Please export or print it as a standard PDF and try again.', {
        code: 'INVALID_PDF',
        cause: err,
      });
    }
    throw mapToolError(err, 'validate');
  }
}

async function getPdfPageCount(inputPath, tools) {
  try {
    const { stdout } = await tools.execFileAsync('qpdf', ['--show-npages', inputPath]);
    const pageCount = Number.parseInt(String(stdout).trim(), 10);
    if (!Number.isInteger(pageCount) || pageCount < 1) {
      throw new Error('Invalid page count from qpdf');
    }
    return pageCount;
  } catch (err) {
    throw mapToolError(err, 'split');
  }
}

async function runQpdfPageSelection(inputPath, selections, outputPath, tools) {
  try {
    await tools.execFileAsync('qpdf', ['--empty', '--pages', inputPath, ...selections, '--', outputPath]);
  } catch (err) {
    throw mapToolError(err, 'split');
  }
}

function parseRanges(rangesStr) {
  const parts = String(rangesStr || '').split(',').map((value) => value.trim()).filter(Boolean);
  if (parts.length === 0) {
    throw new AppError(400, 'Invalid ranges format. Use values like "1-3,5,7-9".');
  }

  return parts.map((part) => {
    const single = part.match(/^(\d+)$/);
    const range = part.match(/^(\d+)-(\d+)$/);

    if (single) {
      const page = Number.parseInt(single[1], 10);
      if (page < 1) {
        throw new AppError(400, 'Page numbers must start at 1.');
      }
      return { start: page, end: page };
    }

    if (range) {
      const start = Number.parseInt(range[1], 10);
      const end = Number.parseInt(range[2], 10);
      if (start < 1 || end < 1) {
        throw new AppError(400, 'Page numbers must start at 1.');
      }
      if (start > end) {
        throw new AppError(400, `Invalid range "${part}". Start page must be less than or equal to end page.`);
      }
      return { start, end };
    }

    throw new AppError(400, `Invalid range segment "${part}". Use values like "1-3,5,7-9".`);
  });
}

function validateRanges(ranges, pageCount) {
  if (!Array.isArray(ranges) || ranges.length === 0) {
    throw new AppError(400, 'At least one page range is required.');
  }

  for (const range of ranges) {
    if (range.start > pageCount || range.end > pageCount) {
      throw new AppError(400, `Page range ${range.start}-${range.end} exceeds this document's ${pageCount} page(s).`);
    }
  }
}

function buildPageSelections(ranges) {
  return ranges.map((range) => (range.start === range.end ? String(range.start) : `${range.start}-${range.end}`));
}

function normalizeCompressionLevel(level) {
  const normalized = String(level || 'medium').toLowerCase();
  if (!VALID_COMPRESSION_LEVELS.has(normalized)) {
    throw new AppError(400, 'Invalid compression level. Use one of: ultra, high, medium, low, minimal.');
  }
  return normalized;
}

function isLikelyAcroFormPdf(buffer) {
  return /\/AcroForm\b/.test(buffer.toString('latin1'));
}

function sanitizeToolFailure(err) {
  const stderr = String(err?.stderr || '').trim();
  const stdout = String(err?.stdout || '').trim();
  const message = String(err?.message || '').trim();
  return stderr || stdout || message || 'tool execution failed';
}

function mapToolError(err, action) {
  if (err instanceof AppError) {
    return err;
  }

  const text = sanitizeToolFailure(err).toLowerCase();

  if (text.includes('no such file') || text.includes('not recognized') || text.includes('enoent')) {
    return new AppError(500, 'PDF processing tools are not available on this server.', {
      code: 'TOOL_MISSING',
      cause: err,
    });
  }

  if (action === 'compress') {
    return new AppError(500, 'Unable to compress this PDF right now. Please try another file or try again later.', {
      code: 'COMPRESS_FAILED',
      cause: err,
    });
  }

  if (action === 'split' || String(action).includes('/split')) {
    return new AppError(500, 'Unable to split this PDF right now. Please verify the file is a valid PDF and try again.', {
      code: 'SPLIT_FAILED',
      cause: err,
    });
  }

  if (action === 'merge' || String(action).includes('/merge')) {
    return new AppError(500, 'Unable to merge these PDFs right now. Please verify the files are valid PDFs and try again.', {
      code: 'MERGE_FAILED',
      cause: err,
    });
  }

  return new AppError(500, 'Something went wrong while processing the PDF.', {
    code: 'PDF_PROCESSING_FAILED',
    cause: err,
  });
}

async function withTempDir(fn, fsModule = fs) {
  const tmpDir = await fsModule.mkdtemp(path.join(os.tmpdir(), 'docsqueeze-'));
  try {
    return await fn(tmpDir);
  } finally {
    await fsModule.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

const app = createApp();

if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`DocSqueeze API running on port ${PORT}`);
  });
}

module.exports = {
  app,
  createApp,
  AppError,
  parseRanges,
  validateRanges,
  buildPageSelections,
  normalizeCompressionLevel,
  isLikelyAcroFormPdf,
  mapToolError,
  mergePdfFiles,
  getPdfPageCount,
  runQpdfPageSelection,
};
