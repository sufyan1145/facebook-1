const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
const { getValidGoogleClient } = require('./services.tokenService');
const env = require('./config.env');
const logger = require('./utils.logger');

const VIDEO_MIME_TYPES = [
  'video/mp4',
  'video/quicktime', // .mov
  'video/x-msvideo', // .avi
  'video/x-matroska', // .mkv
  'video/webm',
];

async function listFolders(userId, { search } = {}) {
  const auth = await getValidGoogleClient(userId);
  const drive = google.drive({ version: 'v3', auth });

  try {
    const about = await drive.about.get({ fields: 'user, storageQuota' });
    logger.info(`[DEBUG] Token belongs to: ${JSON.stringify(about.data.user)}`);
    logger.info(`[DEBUG] Storage quota: ${JSON.stringify(about.data.storageQuota)}`);
  } catch (aboutErr) {
    logger.info(`[DEBUG] about.get failed: ${aboutErr.message}`);
  }

  let q = "mimeType = 'application/vnd.google-apps.folder' and trashed = false";
  if (search) {
    q += ` and name contains '${search.replace(/'/g, "\\'")}'`;
  }

  logger.info(`[DEBUG] Drive query: ${q}`);

  const res = await drive.files.list({
    q,
    fields: 'files(id, name, owners, modifiedTime)',
    pageSize: 100,
  });

  logger.info(`[DEBUG] Drive API status: ${res.status}, files returned: ${res.data.files ? res.data.files.length : 'undefined'}`);
  logger.info(`[DEBUG] Drive API raw data: ${JSON.stringify(res.data)}`);

  const folders = [];
  for (const folder of res.data.files) {
    const videos = await countVideosInFolder(drive, folder.id);
    folders.push({
      folder_id: folder.id,
      folder_name: folder.name,
      video_count: videos.count,
      storage_bytes: videos.totalSize,
      owner_email: folder.owners && folder.owners[0] ? folder.owners[0].emailAddress : null,
      last_modified: folder.modifiedTime,
    });
  }
  return folders;
}

async function countVideosInFolder(drive, folderId) {
  const mimeQuery = VIDEO_MIME_TYPES.map((m) => `mimeType='${m}'`).join(' or ');
  const res = await drive.files.list({
    q: `'${folderId}' in parents and trashed = false and (${mimeQuery})`,
    fields: 'files(id, size)',
    pageSize: 1000,
  });
  const files = res.data.files || [];
  const totalSize = files.reduce((sum, f) => sum + Number(f.size || 0), 0);
  return { count: files.length, totalSize };
}

async function listUnpublishedVideos(userId, folderId, alreadyUploadedIds = []) {
  const auth = await getValidGoogleClient(userId);
  const drive = google.drive({ version: 'v3', auth });

  const mimeQuery = VIDEO_MIME_TYPES.map((m) => `mimeType='${m}'`).join(' or ');
  const res = await drive.files.list({
    q: `'${folderId}' in parents and trashed = false and (${mimeQuery})`,
    fields: 'files(id, name, size, mimeType, createdTime)',
    orderBy: 'createdTime',
    pageSize: 1000,
  });

  const files = res.data.files || [];
  return files.filter((f) => !alreadyUploadedIds.includes(f.id));
}

async function downloadFile(userId, fileId, fileName) {
  const auth = await getValidGoogleClient(userId);
  const drive = google.drive({ version: 'v3', auth });

  if (!fs.existsSync(env.upload.tempDir)) {
    fs.mkdirSync(env.upload.tempDir, { recursive: true });
  }

  const destPath = path.join(env.upload.tempDir, `${fileId}_${fileName}`);
  const dest = fs.createWriteStream(destPath);

  const res = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'stream' });

  return new Promise((resolve, reject) => {
    res.data
      .on('end', () => {
        logger.info(`Downloaded ${fileName} to ${destPath}`);
        resolve(destPath);
      })
      .on('error', (err) => {
        logger.error(`Download failed for ${fileName}: ${err.message}`);
        reject(err);
      })
      .pipe(dest);
  });
}

function deleteTempFile(filePath) {
  if (filePath && fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
    logger.info(`Deleted temp file: ${filePath}`);
  }
}

module.exports = { listFolders, listUnpublishedVideos, downloadFile, deleteTempFile, VIDEO_MIME_TYPES };
