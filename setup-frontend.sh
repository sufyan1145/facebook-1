#!/bin/sh
# ==============================================================================
# Drive2Facebook Automation — frontend setup
#
# All project files are delivered flat (no nested folders) so they're easy to
# download individually. Express's static file server, however, expects the
# HTML/CSS/JS frontend to live in a "public/" directory. Run this script once,
# from the project root, to move the "public.*" files into public/ and strip
# the prefix. Safe to re-run (skips files that are already in place).
# ==============================================================================
set -e

mkdir -p public

for f in public.*.html public.*.js public.*.css public.*.png public.*.jpg public.*.jpeg public.*.svg public.*.ico; do
  [ -e "$f" ] || continue
  newname="${f#public.}"
  mv -f "$f" "public/$newname"
  echo "moved $f -> public/$newname"
done

echo "Frontend is ready in ./public"
