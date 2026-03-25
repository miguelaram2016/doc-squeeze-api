# DocSqueeze API

Express API for PDF compression, merge, split, and usage stats.

## What it actually does

- Compress PDFs with `qpdf` first, then optionally `ghostscript` when that produces a smaller file.
- Merge PDFs with `qpdf` first and `pdfunite` as fallback.
- **Important:** if fillable/AcroForm PDFs are detected, Ghostscript is intentionally skipped for merge so form data is not flattened or corrupted by the fallback path.
- Split PDFs with `qpdf` page selection.
- Return clean client-facing errors instead of raw tool output.

## Runtime dependencies

The API container/server needs these binaries installed and available on `PATH`:

- `qpdf`
- `ghostscript` (`gs`)
- `pdfunite` (from `poppler-utils`)

The provided Dockerfile installs all three.

## Local development

```bash
npm install
npm test
npm start
```

Default port: `3000`

## API endpoints

### `GET /`
Health check.

### `GET /api/stats`
Returns the processed file count.

### `POST /api/compress`
Compress a single PDF.

Multipart fields:
- `file`: PDF file
- `level`: `ultra | high | medium | low | minimal` (default: `medium`)

Success response:
```json
{
  "originalName": "sample.pdf",
  "originalSize": 123456,
  "compressedSize": 98765,
  "compressedBase64": "..."
}
```

### `POST /api/batch-compress`
Compress up to 50 PDFs.

Multipart fields:
- `files`: PDF files
- `level`: `ultra | high | medium | low | minimal`

Success response:
```json
{
  "files": [
    {
      "originalName": "sample.pdf",
      "originalSize": 123456,
      "compressedSize": 98765,
      "compressedBase64": "..."
    }
  ]
}
```

Per-file failures are returned as clean `error` strings in the `files` array.

### `POST /api/merge`
Merge 2-20 PDFs in upload order.

Multipart fields:
- `files`: PDF files

Success response:
- `application/pdf` attachment named `merged.pdf`

Failure behavior:
- Returns a clean JSON error message.
- For fillable/AcroForm inputs, the service will not fall back to Ghostscript.

### `POST /api/split`
Extract pages from a PDF.

Multipart fields:
- `file`: PDF file
- `mode`: `by_pages` or `range`
- `ranges`: required when `mode=range`, format like `1-3,5,7-9`

Behavior:
- `by_pages` currently re-emits the document with all pages preserved through qpdf page selection.
- `range` validates syntax and rejects out-of-bounds page requests with HTTP 400.

Success response:
- `application/pdf` attachment named `split.pdf`

Example validation errors:
```json
{ "error": "Invalid range segment \"abc\". Use values like \"1-3,5,7-9\"." }
```

```json
{ "error": "Page range 2-5 exceeds this document's 3 page(s)." }
```

## Error handling

The API intentionally does **not** expose raw `qpdf`, `ghostscript`, stack traces, or filesystem details to clients.

Typical client-visible errors:
- `Only PDF files are supported`
- `File too large. Maximum size is 100MB.`
- `Unable to compress this PDF right now. Please try another file or try again later.`
- `Unable to merge these PDFs right now. Please verify the files are valid PDFs and try again.`
- `Unable to merge one or more fillable PDFs. Please flatten the form fields first or try different source files.`
- `Unable to split this PDF right now. Please verify the file is a valid PDF and try again.`

## Security notes

Current hardening in this repo:
- `helmet` headers enabled
- `x-powered-by` disabled
- upload size capped at 100MB
- upload count capped at 50 files
- PDF-only upload filter
- temp files cleaned up after each request

Still recommended for production:
- add rate limiting / abuse controls at the edge or API layer
- add request logging / monitoring / alerts
- pin and periodically review base image + npm dependency versions
- consider malware scanning for uploads if threat model requires it
- protect the service behind a trusted frontend or auth layer if public abuse becomes a problem

## Deploy to Render

1. Go to <https://dashboard.render.com>
2. Create a new web service from `miguelaram2016/doc-squeeze-api`
3. Render will use `render.yaml` + `Dockerfile`
4. Deploy

## CORS

Allowed origins:
- `https://doc-squeeze.vercel.app`
- `http://localhost:3000`
