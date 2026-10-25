const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('./server');

// Minimal, valid one-page PDF built entirely from synthetic content.
// Offsets are computed so qpdf checks the same kind of structure as uploads.
function syntheticPdf(label) {
  const stream = 'BT /F1 12 Tf 20 100 Td (' + label + ') Tj ET';
  const bodies = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    '<< /Length ' + Buffer.byteLength(stream, 'ascii') + ' >>\nstream\n' + stream + '\nendstream',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [];
  for (const [index, body] of bodies.entries()) {
    offsets.push(Buffer.byteLength(pdf, 'ascii'));
    pdf += (index + 1) + ' 0 obj\n' + body + '\nendobj\n';
  }
  const startxref = Buffer.byteLength(pdf, 'ascii');
  pdf += 'xref\n0 ' + (bodies.length + 1) + '\n0000000000 65535 f \n';
  for (const offset of offsets) {
    pdf += String(offset).padStart(10, '0') + ' 00000 n \n';
  }
  pdf += 'trailer\n<< /Root 1 0 R /Size ' + (bodies.length + 1) + ' >>\n';
  pdf += 'startxref\n' + startxref + '\n%%EOF\n';
  return Buffer.from(pdf, 'ascii');
}

function parsePdfResponse(res, callback) {
  const chunks = [];
  res.on('data', (chunk) => chunks.push(chunk));
  res.on('end', () => callback(null, Buffer.concat(chunks)));
  res.on('error', callback);
}

async function getValidatedPageCount(buffer) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'docsqueeze-native-test-'));
  const filePath = path.join(dir, 'result.pdf');
  try {
    await fs.writeFile(filePath, buffer);
    execFileSync('qpdf', ['--check', filePath]);
    return Number(execFileSync('qpdf', ['--show-npages', filePath], { encoding: 'utf8' }).trim());
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test('native tools: batch compression, merge and split return valid downloadable PDFs', async () => {
  const first = syntheticPdf('FIRST');
  const second = syntheticPdf('SECOND');
  const app = createApp({ incrementCount: async () => {} });

  // This is the endpoint used by the compression page, not only /api/compress.
  const compressed = await request(app)
    .post('/api/batch-compress')
    .field('level', 'medium')
    .attach('files', first, { filename: 'first.pdf', contentType: 'application/pdf' })
    .attach('files', second, { filename: 'second.pdf', contentType: 'application/pdf' });
  assert.equal(compressed.status, 200, JSON.stringify(compressed.body));
  assert.equal(compressed.body.files.length, 2);
  for (const [index, result] of compressed.body.files.entries()) {
    assert.equal(result.originalName, index === 0 ? 'first.pdf' : 'second.pdf');
    assert.ok(!result.error, result.error);
    assert.ok(result.compressedSize <= (index === 0 ? first.length : second.length));
    assert.equal(await getValidatedPageCount(Buffer.from(result.compressedBase64, 'base64')), 1);
  }

  const merged = await request(app)
    .post('/api/merge')
    .buffer(true)
    .parse(parsePdfResponse)
    .attach('files', first, { filename: 'first.pdf', contentType: 'application/pdf' })
    .attach('files', second, { filename: 'second.pdf', contentType: 'application/pdf' });
  assert.equal(merged.status, 200);
  assert.match(merged.headers['content-type'], /application\/pdf/);
  assert.match(merged.headers['content-disposition'], /merged\.pdf/);
  assert.equal(await getValidatedPageCount(merged.body), 2);

  const split = await request(app)
    .post('/api/split')
    .field('mode', 'range')
    .field('ranges', '2')
    .buffer(true)
    .parse(parsePdfResponse)
    .attach('file', merged.body, { filename: 'merged.pdf', contentType: 'application/pdf' });
  assert.equal(split.status, 200);
  assert.match(split.headers['content-type'], /application\/pdf/);
  assert.match(split.headers['content-disposition'], /split\.pdf/);
  assert.equal(await getValidatedPageCount(split.body), 1);
});
