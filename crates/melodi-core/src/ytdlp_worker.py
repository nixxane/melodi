"""Melodi's long-running yt-dlp worker.

Started by melodi-core (ytdlp_worker.rs) as
    python3 ytdlp_worker.py <path to the yt-dlp zipapp> '<json list of CLI args>'

It keeps yt-dlp loaded between songs, which saves Python's start-up and
yt-dlp's set-up on every song. One request per line on stdin:
    {"id": "<video id>"}
one answer per line on stdout:
    {"url": "..."}  or  {"error": "<yt-dlp's error message>"}
"""
import json
import os
import sys

# The protocol owns the real stdout; anything else that prints goes to stderr.
proto = os.fdopen(os.dup(1), "w", buffering=1, encoding="utf-8")
os.dup2(2, 1)

sys.path.insert(0, sys.argv[1])
import yt_dlp  # noqa: E402
from yt_dlp.utils import DownloadError  # noqa: E402

BASE_ARGS = json.loads(sys.argv[2])


class Quiet:
    def debug(self, msg):
        pass

    info = warning = debug

    def error(self, msg):
        pass


def make(skip_hls):
    args = list(BASE_ARGS)
    if skip_hls:
        # Songs only use the plain audio file; fetching the HLS playlist
        # costs most of a second. Live streams are HLS-only and fall back.
        args += ["--extractor-args", "youtube:skip=hls"]
    opts = yt_dlp.parse_options(args).ydl_opts
    # The CLI's defaults swallow extraction errors (ignoreerrors="only_download"),
    # which would hand back None instead of yt-dlp's message.
    opts.update(quiet=True, no_warnings=True, noprogress=True, logger=Quiet(), ignoreerrors=False)
    return yt_dlp.YoutubeDL(opts)


fast = make(True)
full = None


def save_cookies(ydl):
    # YouTube refreshes the session as it goes; keep the cookie file current
    # (the CLI does this when it exits).
    try:
        if ydl.params.get("cookiefile"):
            ydl.cookiejar.save()
    except Exception:
        pass


def resolve(video_id):
    global full
    url = f"https://music.youtube.com/watch?v={video_id}"
    try:
        info = fast.extract_info(url, download=False)
        save_cookies(fast)
    except DownloadError as e:
        msg = str(e)
        if "format is not available" not in msg and "No video formats" not in msg:
            raise
        if full is None:
            full = make(False)
        info = full.extract_info(url, download=False)
        save_cookies(full)
    if not info:
        raise DownloadError("ERROR: yt-dlp returned nothing for this song")
    if info.get("url"):
        return info["url"]
    for f in info.get("requested_formats") or []:
        if f.get("url"):
            return f["url"]
    raise DownloadError("ERROR: no stream URL in yt-dlp's answer")


for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        req = json.loads(line)
        answer = {"url": resolve(req["id"])}
    except Exception as e:  # report every failure; never die on one song
        answer = {"error": str(e) or type(e).__name__}
    proto.write(json.dumps(answer) + "\n")
