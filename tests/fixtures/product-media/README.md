# Local acceptance media

Synthetic FFmpeg test patterns, not bakery photos or production assets. Three photos (JPEG,
PNG, WebP) and one playable one-second H.264 baseline MP4, all 160 × 120. Generated with
FFmpeg 8.0.1 from `testsrc2=size=160x120:rate=1` (photos) / `rate=24` (video).

Photos use `-frames:v 1 -threads 1`; video uses `-t 1 -c:v libx264 -profile:v baseline
-pix_fmt yuv420p -movflags +faststart -threads 1`. The unit test alters only a copy of the
MP4 sample-entry tag to test HEVC rejection; the committed video remains real H.264.
