# Skein intro video

`skein-intro.mp4`: 24 s, 1080x1080, H.264, about 30 fps, no audio (made for X, which autoplays muted).

Rebuild (needs Microsoft Edge, Node and Python; nothing to install):

    node render.mjs frames 2.8,10.8,23   # stills for checking, written to frames/
    node render.mjs record               # real time capture with MediaRecorder (fragmented MP4)
    python defrag.py skein-intro.mp4 skein-intro.mp4.tmp && mv skein-intro.mp4.tmp skein-intro.mp4
    node verify.mjs skein-intro.mp4      # plays it back and saves frames to check/

`skein-intro.html` draws every frame as a pure function of time on a canvas; edit the scenes there.
`defrag.py` rewrites MediaRecorder's fragmented MP4 as a plain one (one moov, one mdat), which upload
sites accept more reliably. All wallet data in the video is illustrative; no real address is shown.

## Promo (1920x1080, 60 fps, 34 s)

`skein-promo.mp4` is not committed (40 MB); rebuild it with the local site running on :8787:

    node shots.mjs                 # real screens from the local site into shots/
    node promo.mjs frames 6.5,20   # stills for checking
    node promo.mjs encode          # every frame encoded with WebCodecs H.264, then mux.py writes the MP4

`promo.html` holds the scenes; `serve.mjs` serves the repo on localhost so WebCodecs is available.
