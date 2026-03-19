# DocSqueeze API

PDF Compression API service using qpdf and ghostscript.

## Deploy to Render

1. Go to [dashboard.render.com](https://dashboard.render.com)
2. Click **New +** → **Render Deploy**
3. Connect `miguelaram2016/doc-squeeze-api` GitHub repo
4. Render will auto-detect the `render.yaml` and Dockerfile
5. Click **Deploy**

## API Endpoints

- `GET /` - Health check
- `POST /api/compress` - Compress PDF file

## Request Format

```
POST /api/compress
Content-Type: multipart/form-data

file: <PDF file>
level: low | medium | high (default: medium)
```

## Response

Returns the compressed PDF file.

## CORS

CORS is enabled for:
- `https://doc-squeeze.vercel.app` (Vercel frontend)
- `http://localhost:3000` (development)
