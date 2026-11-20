# melodi-server

Melodi's backend over HTTP, for the web app / PWA. It runs the same Rust code
as the desktop app (`crates/melodi-core`): InnerTube for search and browse,
yt-dlp to resolve songs, and an audio relay with a shared disk cache.

```
cargo run --release
```

## API

The desktop UI calls Tauri commands; the web UI sends the same commands here:

| Route | What |
| --- | --- |
| `POST /api/<command>` | `search`, `browse_home`, `up_next`, `browse_artist`, `browse_collection`, `lyrics`, `prepare_stream`, `prefetch_stream`, `backend_status`. JSON body = the `invoke` arguments (camelCase). Errors: `{"error": "..."}` |
| `POST /api/import_spotify`, `/api/import_tracks` | NDJSON: `{"progress":{"done","total"}}` lines, then `{"result":...}` |
| `GET/HEAD /a/<id>?e=&t=` | A song (range requests). The signed link comes from `prepare_stream` and is valid for 12 h |
| `GET /live/<id>?e=&t=` | A live broadcast as one endless AAC stream |
| `GET /api/health` | `ok` |

The user's language / region travel as `X-Melodi-Hl` / `X-Melodi-Gl` headers.

## Settings (environment variables)

| Variable | Default | |
| --- | --- | --- |
| `MELODI_ADDR` | `0.0.0.0:8080` | Listen address |
| `MELODI_DATA_DIR` | `./data` | yt-dlp (`bin/`) and the song cache (`audio/`) |
| `MELODI_CACHE_GB` | `20` | Song cache size |
| `MELODI_SECRET` | random | Signs song links. **Set it**, or links break on restart |
| `MELODI_PUBLIC_URL` | from the request | e.g. `https://api.getmelodi.xyz`, used in song links |
| `MELODI_ALLOWED_ORIGINS` | any | Comma-separated CORS origins, e.g. `https://app.getmelodi.xyz` |
| `MELODI_TRUST_PROXY` | none | `cloudflare` (use `CF-Connecting-IP`) or `forwarded` (`X-Forwarded-For`) for rate limits |
| `MELODI_WEB_DIR` | — | Also serve the built web app (`dist/`) from this server |
| `MELODI_YTDLP_ARGS` | — | Extra yt-dlp arguments, e.g. `--cookies /data/cookies.txt` if YouTube asks to "confirm you're not a bot" |
| `MELODI_YTDLP_WORKERS` | `0` (Docker image: `3`) | Long-running yt-dlp processes; saves ~1.5 s per new song. Needs `python3` and the Linux (zipapp) yt-dlp |
| `MELODI_YTDLP_CONCURRENCY` | `6` | yt-dlp processes at once |
| `MELODI_YTDLP` | — | Use this yt-dlp instead of downloading one |

yt-dlp is downloaded into `MELODI_DATA_DIR/bin` on first start and updated every
few hours. It needs Python 3 (and, for YouTube, a JavaScript runtime such as
Deno) on the server.

## Rate limits (per IP)

300 API calls/min, 60 song starts/min, 5 imports per 10 min.
