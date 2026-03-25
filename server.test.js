const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const {
  createApp,
  parseRanges,
  validateRanges,
  buildPageSelections,
  normalizeCompressionLevel,
  AppError,
  mergePdfFiles,
} = require('./server');

const PDF_BUFFER = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF', 'utf8');
const ACROFORM_BUFFER = Buffer.from('%PDF-1.4\n1 0 obj\n<< /AcroForm <<>> >>\nendobj\ntrailer\n<<>>\n%%EOF', 'utf8');

function createMemoryFs() {
  const files = new Map();
  return {
    async mkdtemp(prefix) {
      return `${prefix}testdir`;
    },
    async writeFile(filePath, data) {
      files.set(filePath, Buffer.isBuffer(data) ? Buffer.from(data) : Buffer.from(String(data)));
    },
    async readFile(filePath) {
      return files.get(filePath) || Buffer.from('');
    },
    async stat(filePath) {
      const value = files.get(filePath) || Buffer.from('');
      return { size: value.length };
    },
    async rm() {},
    files,
  };
}

test('parseRanges parses valid ranges', () => {
  assert.deepEqual(parseRanges('1-3, 5,7-9'), [
    { start: 1, end: 3 },
    { start: 5, end: 5 },
    { start: 7, end: 9 },
  ]);
  assert.deepEqual(buildPageSelections(parseRanges('2,4-6')), ['2', '4-6']);
});

test('parseRanges rejects malformed segments', () => {
  assert.throws(() => parseRanges('0-2'), AppError);
  assert.throws(() => parseRanges('5-2'), /Start page/);
  assert.throws(() => parseRanges('abc'), /Invalid range segment/);
});

test('validateRanges rejects out-of-bounds selections', () => {
  assert.throws(() => validateRanges(parseRanges('1-4'), 3), /exceeds this document's 3 page/);
});

test('normalizeCompressionLevel validates supported values', () => {
  assert.equal(normalizeCompressionLevel('HIGH'), 'high');
  assert.throws(() => normalizeCompressionLevel('banana'), /Invalid compression level/);
});

test('split endpoint returns 400 for invalid ranges', async () => {
  const fsMock = createMemoryFs();
  const app = createApp({
    fs: fsMock,
    incrementCount: async () => {},
    execFileAsync: async (cmd, args) => {
      if (cmd === 'qpdf' && args[0] === '--show-npages') {
        return { stdout: '3\n', stderr: '' };
      }
      throw new Error(`unexpected command ${cmd} ${args.join(' ')}`);
    },
  });

  const response = await request(app)
    .post('/api/split')
    .field('mode', 'range')
    .field('ranges', '2-5')
    .attach('file', PDF_BUFFER, { filename: 'sample.pdf', contentType: 'application/pdf' });

  assert.equal(response.status, 400);
  assert.match(response.body.error, /exceeds this document's 3 page/);
});

test('split endpoint hides raw qpdf failures', async () => {
  const fsMock = createMemoryFs();
  const app = createApp({
    fs: fsMock,
    incrementCount: async () => {},
    execFileAsync: async (cmd, args) => {
      if (cmd === 'qpdf' && args[0] === '--show-npages') {
        return { stdout: '2\n', stderr: '' };
      }
      const err = new Error('qpdf exploded');
      err.stderr = 'qpdf: open failed: super sensitive internals';
      throw err;
    },
  });

  const response = await request(app)
    .post('/api/split')
    .field('mode', 'range')
    .field('ranges', '1')
    .attach('file', PDF_BUFFER, { filename: 'sample.pdf', contentType: 'application/pdf' });

  assert.equal(response.status, 500);
  assert.equal(response.body.error, 'Unable to split this PDF right now. Please verify the file is a valid PDF and try again.');
});

test('mergePdfFiles prefers qpdf and skips Ghostscript for AcroForm PDFs', async () => {
  const calls = [];
  await assert.rejects(() => mergePdfFiles(['a.pdf', 'b.pdf'], 'out.pdf', [
    { buffer: ACROFORM_BUFFER },
    { buffer: PDF_BUFFER },
  ], {
    execFileAsync: async (cmd, args) => {
      calls.push({ cmd, args });
      throw new Error(`${cmd} failed`);
    },
  }), /fillable PDFs/);

  assert.deepEqual(calls.map((call) => call.cmd), ['qpdf', 'pdfunite']);
});

test('merge endpoint sends a PDF when qpdf merge succeeds', async () => {
  const fsMock = createMemoryFs();
  const app = createApp({
    fs: fsMock,
    incrementCount: async () => {},
    execFileAsync: async (cmd, args) => {
      if (cmd === 'qpdf' && args[0] === '--empty') {
        const outputPath = args[args.length - 1];
        await fsMock.writeFile(outputPath, Buffer.from('%PDF-merged'));
        return { stdout: '', stderr: '' };
      }
      throw new Error(`unexpected command ${cmd} ${args.join(' ')}`);
    },
  });

  const response = await request(app)
    .post('/api/merge')
    .buffer(true)
    .parse((res, callback) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => callback(null, Buffer.concat(chunks)));
    })
    .attach('files', PDF_BUFFER, { filename: 'a.pdf', contentType: 'application/pdf' })
    .attach('files', PDF_BUFFER, { filename: 'b.pdf', contentType: 'application/pdf' });

  assert.equal(response.status, 200);
  assert.equal(response.headers['content-type'], 'application/pdf');
  assert.equal(Buffer.from(response.body).toString('utf8'), '%PDF-merged');
});
