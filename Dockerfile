FROM node:18-alpine

RUN apk add --no-cache ffmpeg fontconfig ttf-dejavu curl

# yt-dlp: Alpine's apk package lags behind - YouTube/TikTok change their
# extraction schemes often enough that an old yt-dlp starts failing until
# it's updated. Pulling the standalone binary straight from the NIGHTLY
# channel (not stable) keeps this as current as possible, since site
# breakages often get fixed in nightly days before they reach a stable
# release. Alpine uses musl libc (not glibc), so we need the
# musllinux-specific standalone binary - the generic "yt-dlp" release asset
# is a Python script that needs python3 installed, which this image doesn't
# have.
# Using ADD (not RUN curl) here is deliberate: Docker checks the remote
# file's ETag/Last-Modified on every build and only invalidates this layer's
# cache when the nightly binary has actually changed. A plain "RUN curl"
# gets cached forever after the first build and silently goes stale, which
# is why TikTok/YouTube extraction can keep failing on bugs that yt-dlp's
# maintainers already fixed upstream days ago.
ADD https://github.com/yt-dlp/yt-dlp-nightly-builds/releases/latest/download/yt-dlp_musllinux /usr/local/bin/yt-dlp
RUN chmod a+rx /usr/local/bin/yt-dlp && yt-dlp --version

WORKDIR /usr/src/app

COPY package*.json ./
RUN npm install --production

COPY . .

RUN chmod +x setup-frontend.sh && sh setup-frontend.sh
RUN mkdir -p logs uploads

EXPOSE 5000

CMD ["sh", "-c", "node migrate-runner.js && node server.js"]
