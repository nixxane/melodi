//! melodi-server: Melodi's backend over HTTP, for the web app / PWA.
//!
//! The desktop app calls its Rust backend through Tauri IPC; this server
//! offers the same commands as `POST /api/<command>` with the same JSON
//! arguments, so the UI only swaps its transport. Songs are relayed through
//! `/a/<id>` (and `/live/<id>`) with a signed, expiring token, and cached on
//! disk for everyone.
//!
//! Configuration is by environment variable; see crates/melodi-server/README.md.

mod config;
mod limit;
mod token;

use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;
use std::time::Duration;

use axum::body::{Body, Bytes};
use axum::extract::{ConnectInfo, Path, Query, State};
use axum::http::{header, HeaderMap, HeaderValue, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use futures_util::StreamExt;
use melodi_core::audio::{self, AudioStore};
use melodi_core::innertube::InnerTube;
use melodi_core::lyrics::LyricsClient;
use melodi_core::spotify::{self, SourceList, Spotify, Track};
use melodi_core::ytdlp::{self, StreamCache};
use serde::Deserialize;
use serde_json::{json, Value};
use tower_http::compression::CompressionLayer;
use tower_http::cors::{AllowOrigin, CorsLayer};

use config::Config;
use limit::{Bucket, Limiter};

struct App {
    cfg: Config,
    yt: Arc<InnerTube>,
    lyrics: LyricsClient,
    spotify: Spotify,
    audio: AudioStore,
    limiter: Limiter,
}

type Shared = State<Arc<App>>;

#[tokio::main]
async fn main() {
    let cfg = Config::from_env();
    let yt = Arc::new(InnerTube::new().expect("failed to build InnerTube client"));
    let streams = Arc::new(StreamCache::default());
    let audio = AudioStore::new(
        cfg.data_dir.join("audio"),
        cfg.data_dir.clone(),
        yt.clone(),
        streams,
        cfg.cache_bytes,
    )
    .expect("couldn't open the audio cache");

    let app = Arc::new(App {
        lyrics: LyricsClient::new().expect("failed to build lyrics client"),
        spotify: Spotify::new().expect("failed to build Spotify client"),
        limiter: Limiter::default(),
        yt,
        audio,
        cfg,
    });

    // Fetch yt-dlp on first start, then keep it fresh: YouTube regularly
    // breaks old versions.
    let data_dir = app.cfg.data_dir.clone();
    tokio::spawn(async move {
        match ytdlp::ensure(&data_dir).await {
            Ok(p) => eprintln!("[melodi] yt-dlp: {}", p.display()),
            Err(e) => eprintln!("[melodi] yt-dlp unavailable: {e}"),
        }
        loop {
            ytdlp::maybe_update(&data_dir, false).await;
            tokio::time::sleep(Duration::from_secs(6 * 3600)).await;
        }
    });

    let addr = app.cfg.addr;
    let router = router(app);
    let listener = tokio::net::TcpListener::bind(addr).await.expect("couldn't bind");
    eprintln!("[melodi] listening on http://{addr}");
    axum::serve(listener, router.into_make_service_with_connect_info::<SocketAddr>())
        .with_graceful_shutdown(shutdown())
        .await
        .expect("server error");
}

fn router(app: Arc<App>) -> Router {
    let cors = CorsLayer::new()
        .allow_methods([Method::GET, Method::HEAD, Method::POST, Method::OPTIONS])
        .allow_headers([
            header::CONTENT_TYPE,
            header::RANGE,
            header::HeaderName::from_static("x-melodi-hl"),
            header::HeaderName::from_static("x-melodi-gl"),
        ])
        .expose_headers([header::CONTENT_RANGE, header::CONTENT_LENGTH, header::ACCEPT_RANGES])
        .max_age(Duration::from_secs(3600))
        .allow_origin(match &app.cfg.allowed_origins {
            None => AllowOrigin::any(),
            Some(list) => AllowOrigin::list(list.iter().filter_map(|o| HeaderValue::from_str(o).ok())),
        });

    // JSON answers compress well; audio and the streamed import progress must not be buffered.
    let api = Router::new()
        .route("/api/{cmd}", post(command))
        .route("/api/health", get(|| async { "ok" }))
        .layer(CompressionLayer::new());
    let streaming = Router::new()
        .route("/api/import_spotify", post(import_spotify))
        .route("/api/import_tracks", post(import_tracks))
        .route("/a/{id}", get(song).head(song))
        .route("/live/{id}", get(live).head(live));

    let mut r = api.merge(streaming);
    if let Some(dir) = &app.cfg.web_dir {
        // Optional: serve the built web app too (single-origin / self-hosted setups).
        let index = dir.join("index.html");
        r = r.fallback_service(tower_http::services::ServeDir::new(dir).fallback(tower_http::services::ServeFile::new(index)));
    }
    r.layer(cors).with_state(app)
}

async fn shutdown() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let term = async {
        if let Ok(mut s) = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            s.recv().await;
        }
    };
    #[cfg(not(unix))]
    let term = std::future::pending::<()>();
    tokio::select! { _ = ctrl_c => {}, _ = term => {} }
}

// ---- errors ------------------------------------------------------------------

struct ApiError(StatusCode, String);

impl ApiError {
    fn bad(msg: impl Into<String>) -> Self {
        Self(StatusCode::BAD_REQUEST, msg.into())
    }
    fn busy() -> Self {
        Self(StatusCode::TOO_MANY_REQUESTS, "Slow down a little \u{2014} too many requests".into())
    }
}

impl<E: std::fmt::Display> From<E> for ApiError {
    fn from(e: E) -> Self {
        Self(StatusCode::BAD_GATEWAY, e.to_string())
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.0, Json(json!({ "error": self.1 }))).into_response()
    }
}

type ApiResult = Result<Json<Value>, ApiError>;

fn ok<T: serde::Serialize>(v: T) -> ApiResult {
    Ok(Json(serde_json::to_value(v).map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?))
}

// ---- API ---------------------------------------------------------------------

/// Arguments, named like the desktop app's `invoke` calls (camelCase).
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct Args {
    query: String,
    video_id: String,
    playlist_id: Option<String>,
    browse_id: String,
    title: String,
    artist: String,
    duration_ms: Option<u64>,
    force_refresh: Option<bool>,
}

fn parse<T: Default + serde::de::DeserializeOwned>(body: &Bytes) -> Result<T, ApiError> {
    if body.iter().all(u8::is_ascii_whitespace) {
        return Ok(T::default());
    }
    serde_json::from_slice(body).map_err(|e| ApiError::bad(format!("bad arguments: {e}")))
}

/// Client for the caller's language / region (sent as headers, since the
/// shared client serves everyone).
fn yt_for(app: &App, headers: &HeaderMap) -> Option<InnerTube> {
    let h = |name| headers.get(name).and_then(|v| v.to_str().ok());
    let (hl, gl) = (h("x-melodi-hl")?, h("x-melodi-gl")?);
    app.yt.with_locale(hl, gl).ok()
}

async fn command(
    State(app): Shared,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Path(cmd): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> ApiResult {
    let ip = client_ip(&app, &headers, peer);
    let bucket = match cmd.as_str() {
        "prepare_stream" | "prefetch_stream" => Bucket::Stream,
        _ => Bucket::Api,
    };
    if !app.limiter.allow(ip, bucket) {
        return Err(ApiError::busy());
    }
    let a: Args = parse(&body)?;
    let local = yt_for(&app, &headers);
    let yt: &InnerTube = local.as_ref().unwrap_or(&app.yt);

    match cmd.as_str() {
        "search" => ok(yt.search(a.query.trim()).await?),
        "browse_home" => ok(yt.home().await?),
        "up_next" => ok(yt.up_next(&a.video_id, a.playlist_id.as_deref()).await?),
        "browse_artist" => ok(yt.artist(&a.browse_id).await?),
        "browse_collection" => ok(yt.collection(&a.browse_id).await?),
        "lyrics" => ok(app.lyrics.find(yt, &a.video_id, &a.title, &a.artist, a.duration_ms).await?),
        "prepare_stream" => {
            let base = public_base(&app, &headers);
            let secret = &app.cfg.secret;
            let id = a.video_id.as_str();
            let p = app
                .audio
                .prepare(id, a.force_refresh.unwrap_or(false), |live| {
                    let kind = if live { "live" } else { "a" };
                    let (exp, sig) = token::sign(secret, id);
                    format!("{base}/{kind}/{id}?e={exp}&t={sig}")
                })
                .await
                .map_err(|e| ApiError(StatusCode::BAD_GATEWAY, e.to_string()))?;
            ok(p)
        }
        "prefetch_stream" => {
            let store = app.audio.clone();
            tokio::spawn(async move { store.prefetch(&a.video_id).await });
            ok(Value::Null)
        }
        "backend_status" => ok(ytdlp::status(&app.cfg.data_dir).await),
        // The language travels with every request instead.
        "set_locale" => ok(Value::Null),
        _ => Err(ApiError(StatusCode::NOT_FOUND, format!("`{cmd}` isn't available on the web"))),
    }
}

/// Where the browser reaches this server, for absolute song URLs.
fn public_base(app: &App, headers: &HeaderMap) -> String {
    if let Some(b) = &app.cfg.public_url {
        return b.clone();
    }
    let h = |n: &str| headers.get(n).and_then(|v| v.to_str().ok());
    let host = h("x-forwarded-host").or_else(|| h("host")).unwrap_or("localhost");
    let proto = h("x-forwarded-proto").unwrap_or("http");
    format!("{proto}://{host}")
}

fn client_ip(app: &App, headers: &HeaderMap, peer: SocketAddr) -> IpAddr {
    let h = |n: &str| headers.get(n).and_then(|v| v.to_str().ok());
    let forwarded = match app.cfg.trust_proxy {
        config::TrustProxy::None => None,
        config::TrustProxy::Cloudflare => h("cf-connecting-ip"),
        config::TrustProxy::Forwarded => h("x-forwarded-for").and_then(|v| v.split(',').next()),
    };
    forwarded.and_then(|v| v.trim().parse().ok()).unwrap_or(peer.ip())
}

// ---- imports (streamed progress) ---------------------------------------------

#[derive(Deserialize, Default)]
#[serde(default)]
struct SpotifyArgs {
    url: String,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct TracksArgs {
    name: String,
    tracks: Vec<Track>,
}

async fn import_spotify(
    State(app): Shared,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response, ApiError> {
    if !app.limiter.allow(client_ip(&app, &headers, peer), Bucket::Import) {
        return Err(ApiError::busy());
    }
    let a: SpotifyArgs = parse(&body)?;
    let (kind, id) = spotify::parse_link(&a.url)
        .ok_or_else(|| ApiError::bad("That doesn't look like a Spotify playlist, album or song link"))?;
    let list = spotify::fetch(&app.spotify.http, kind, &id).await?;
    if list.tracks.is_empty() {
        return Err(ApiError::bad("That Spotify playlist is empty"));
    }
    Ok(stream_import(app, list))
}

async fn import_tracks(
    State(app): Shared,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response, ApiError> {
    if !app.limiter.allow(client_ip(&app, &headers, peer), Bucket::Import) {
        return Err(ApiError::busy());
    }
    let a: TracksArgs = parse(&body)?;
    if a.tracks.is_empty() {
        return Err(ApiError::bad("No songs found in that file"));
    }
    let tracks = a.tracks.into_iter().take(5000).collect();
    Ok(stream_import(app, SourceList { name: a.name, tracks, truncated: false }))
}

/// Match a list, answering with NDJSON: `{"progress":{..}}` lines while it
/// works, then one `{"result":..}` line.
fn stream_import(app: Arc<App>, list: SourceList) -> Response {
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<Value>();
    let progress_tx = tx.clone();
    tokio::spawn(async move {
        let on_progress: spotify::OnProgress = Arc::new(move |p| {
            let _ = progress_tx.send(json!({ "progress": p }));
        });
        let done = spotify::match_all(&app.yt, list, on_progress).await;
        let _ = tx.send(json!({ "result": done }));
    });
    let lines = tokio_stream_from(rx).map(|v| Ok::<_, std::io::Error>(Bytes::from(format!("{v}\n"))));
    Response::builder()
        .header(header::CONTENT_TYPE, "application/x-ndjson")
        .header(header::CACHE_CONTROL, "no-store")
        .body(Body::from_stream(lines))
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

fn tokio_stream_from<T: Send + 'static>(
    mut rx: tokio::sync::mpsc::UnboundedReceiver<T>,
) -> impl futures_util::Stream<Item = T> + Send {
    futures_util::stream::poll_fn(move |cx| rx.poll_recv(cx))
}

// ---- audio -------------------------------------------------------------------

#[derive(Deserialize, Default)]
#[serde(default)]
struct Signed {
    e: u64,
    t: String,
}

async fn song(state: Shared, id: Path<String>, q: Query<Signed>, method: Method, headers: HeaderMap) -> Response {
    play(state, id, q, method, headers, false).await
}

async fn live(state: Shared, id: Path<String>, q: Query<Signed>, method: Method, headers: HeaderMap) -> Response {
    play(state, id, q, method, headers, true).await
}

async fn play(
    State(app): Shared,
    Path(id): Path<String>,
    q: Query<Signed>,
    method: Method,
    headers: HeaderMap,
    live: bool,
) -> Response {
    let Query(q) = q;
    if !token::verify(&app.cfg.secret, &id, q.e, &q.t) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let range = headers.get(header::RANGE).and_then(|v| v.to_str().ok()).and_then(audio::parse_range);
    let r = app.audio.serve(&id, live, range, method == Method::HEAD).await;

    let mut b = Response::builder().status(r.status);
    for (k, v) in r.headers {
        b = b.header(k, v);
    }
    let body = match r.body {
        Some(s) => Body::from_stream(s),
        None => Body::empty(),
    };
    b.body(body).unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}
