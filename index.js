const express = require('express');
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const Busboy = require('busboy');

const fileTypeMap = {
  image: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'ico'],
  video: ['mp4', 'webm', 'avi', 'mov', 'mkv', 'flv', 'wmv', 'quicktime'],
  audio: ['mp3', 'wav', 'flac', 'aac', 'm4a', 'ogg', 'wma', 'opus'],
  text: ['txt', 'md', 'json', 'xml', 'yaml', 'yml', 'toml', 'csv', 'log'],
  code: ['js', 'ts', 'jsx', 'tsx', 'py', 'java', 'cpp', 'c', 'go', 'rs', 'rb', 'php', 'html', 'css'],
  archive: ['zip', '7z', 'rar', 'tar', 'gz', 'bz2', 'xz'],
  document: ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp'],
};

function sanitizePath(p) {
  return path.normalize(p).replace(/^(\.\.(\/|\\|$))+/, '');
}

function makeResolver(baseDir) {
  const normalizedBase = path.resolve(baseDir);
  return function resolveWithBaseDir(relPath) {
    const sanitized = sanitizePath(relPath);
    const fullPath = path.resolve(normalizedBase, sanitized);
    if (!fullPath.startsWith(normalizedBase)) {
      return { ok: false, error: 'EPATHINJECTION' };
    }
    return { ok: true, path: fullPath };
  };
}

async function getFileType(fullPath) {
  try {
    const stat = await fs.lstat(fullPath);
    if (stat.isSymbolicLink()) return 'symlink';
    if (stat.isDirectory()) return 'dir';
    const ext = path.extname(fullPath).slice(1).toLowerCase();
    for (const [type, exts] of Object.entries(fileTypeMap)) {
      if (exts.includes(ext)) return type;
    }
    return 'other';
  } catch {
    return 'other';
  }
}

async function checkPermissions(fullPath) {
  try {
    await fs.access(fullPath, fsSync.constants.R_OK);
    const canWrite = await fs.access(fullPath, fsSync.constants.W_OK).then(() => true).catch(() => false);
    return canWrite ? ['read', 'write'] : ['read'];
  } catch {
    return 'EACCES';
  }
}

function escapeJsString(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/</g, '\\x3c').replace(/>/g, '\\x3e');
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// githack (never caches, unlike jsDelivr/unpkg) serving the design system's
// main branch directly -- same CDN convention the design repo itself uses
// for its own cross-repo SDK references (see AnEntrypoint/design commit
// 77803fa, "switch own cross-repo SDK references from jsDelivr to githack").
const DS_GITHACK = 'https://raw.githack.com/AnEntrypoint/design/main/dist';

function resolveDesignDist() {
  const candidates = [
    path.join(__dirname, '..', 'anentrypoint-design', 'dist'),
    path.join(__dirname, 'node_modules', 'anentrypoint-design', 'dist'),
  ];
  for (const c of candidates) {
    if (fsSync.existsSync(path.join(c, '247420.js')) && fsSync.existsSync(path.join(c, '247420.css'))) {
      return c;
    }
  }
  return null;
}

module.exports = function fsbrowse(opts) {
  const baseDir = (opts && opts.baseDir) || process.env.BASE_DIR || '/files';
  const name = (opts && opts.name) || 'fsbrowse';
  const themeKeys = (opts && opts.themeKeys) || 'gmgui-theme,theme';
  const resolveWithBaseDir = makeResolver(baseDir);
  const router = express.Router();
  const publicDir = path.join(__dirname, 'public');

  const dsLocal = resolveDesignDist();
  if (dsLocal) {
    router.use('/_ds', express.static(dsLocal));
    console.log('[fsbrowse] design system: local', dsLocal);
  } else {
    console.log('[fsbrowse] design system: githack fallback');
  }

  router.use((req, res, next) => {
    if (req.path === '/' || req.path === '/index.html') {
      const basePath = req.baseUrl;
      const dsBase = dsLocal ? `${basePath}/_ds` : DS_GITHACK;
      let html = fsSync.readFileSync(path.join(publicDir, 'index.html'), 'utf-8');
      const inject = `<script>window.THEME_KEYS='${escapeJsString(themeKeys)}';window.BASEPATH='${escapeJsString(basePath)}';window.DS_BASE='${escapeJsString(dsBase)}';window.APP_NAME='${escapeJsString(name)}';</script>`;
      html = html.replace('<!--INJECT-->', inject);
      html = html.replace(/__DS_BASE__/g, escapeHtml(dsBase));
      html = html.replace(/__BASEPATH__/g, escapeHtml(basePath));
      html = html.replace(/<title>fsbrowse<\/title>/, `<title>${escapeHtml(name)}</title>`);
      res.type('text/html').send(html);
    } else {
      next();
    }
  });

  router.use(express.static(publicDir));

  router.get('/api/list/:path(*)', async (req, res) => {
    try {
      const relPath = req.params.path || './';
      const resolved = resolveWithBaseDir(relPath);
      if (!resolved.ok) return res.status(400).json({ ok: false, error: resolved.error });

      const fullPath = resolved.path;
      if (!fsSync.existsSync(fullPath)) {
        return res.status(404).json({ ok: false, error: 'ENOENT' });
      }

      const stat = await fs.stat(fullPath);
      if (!stat.isDirectory()) {
        const fileType = await getFileType(fullPath);
        const perms = await checkPermissions(fullPath);
        return res.json({
          ok: true,
          value: {
            name: path.basename(fullPath),
            path: relPath,
            parentPath: path.dirname(relPath),
            type: fileType,
            permissions: perms,
            size: stat.size,
            time: { create: stat.birthtime, access: stat.atime, modified: stat.mtime },
          },
        });
      }

      const entries = await fs.readdir(fullPath, { withFileTypes: true });
      const children = [];

      for (const entry of entries) {
        const childFullPath = path.join(fullPath, entry.name);
        const childRelPath = path.join(relPath, entry.name);
        const fileType = await getFileType(childFullPath);
        const perms = await checkPermissions(childFullPath);

        try {
          const childStat = await fs.stat(childFullPath);
          children.push({
            name: entry.name,
            type: fileType,
            path: childRelPath,
            parentPath: relPath,
            permissions: perms,
            size: childStat.size,
            time: { create: childStat.birthtime, access: childStat.atime, modified: childStat.mtime },
          });
        } catch {
          children.push({
            name: entry.name,
            type: fileType,
            path: childRelPath,
            parentPath: relPath,
            permissions: 'EACCES',
            size: 0,
          });
        }
      }

      children.sort((a, b) => {
        if (a.type === 'dir' && b.type !== 'dir') return -1;
        if (a.type !== 'dir' && b.type === 'dir') return 1;
        return a.name.localeCompare(b.name);
      });

      res.json({
        ok: true,
        value: {
          name: path.basename(fullPath),
          path: relPath,
          parentPath: path.dirname(relPath),
          children,
          type: 'dir',
          time: { create: stat.birthtime, access: stat.atime, modified: stat.mtime },
        },
      });
    } catch (err) {
      console.error('Error in /api/list:', err);
      res.status(500).json({ ok: false, error: 'UNKNOWN' });
    }
  });

  router.post('/api/upload', async (req, res) => {
    try {
      const bb = Busboy({ headers: req.headers });
      const uploadPath = req.query.path || './';
      const resolved = resolveWithBaseDir(uploadPath);
      if (!resolved.ok) return res.status(400).json({ ok: false, error: resolved.error });

      const fullUploadDir = resolved.path;
      if (!fsSync.existsSync(fullUploadDir)) {
        return res.status(404).json({ ok: false, error: 'ENOENT' });
      }

      bb.on('file', async (fieldname, file, info) => {
        const fileName = path.basename(info.filename || 'unnamed');
        if (!fileName || fileName === '.' || fileName === '..') { file.resume(); return; }
        const filePath = path.join(fullUploadDir, fileName);

        try {
          const writeStream = fsSync.createWriteStream(filePath);
          file.pipe(writeStream);
          await new Promise((resolve, reject) => {
            writeStream.on('finish', resolve);
            writeStream.on('error', reject);
            file.on('error', reject);
          });
        } catch (err) {
          console.error('Error writing file:', err);
          file.resume();
        }
      });

      bb.on('close', () => {
        res.json({ ok: true });
      });

      bb.on('error', (err) => {
        console.error('Busboy error:', err);
        res.status(500).json({ ok: false, error: 'UPLOAD_FAILED' });
      });

      req.pipe(bb);
    } catch (err) {
      console.error('Error in /api/upload:', err);
      res.status(500).json({ ok: false, error: 'UNKNOWN' });
    }
  });

  router.get('/api/download/:path(*)', async (req, res) => {
    try {
      const relPath = req.params.path;
      const resolved = resolveWithBaseDir(relPath);
      if (!resolved.ok) return res.status(400).json({ ok: false, error: resolved.error });

      const fullPath = resolved.path;
      if (!fsSync.existsSync(fullPath)) {
        return res.status(404).json({ ok: false, error: 'ENOENT' });
      }

      const stat = await fs.stat(fullPath);
      if (stat.isDirectory()) {
        return res.status(400).json({ ok: false, error: 'IS_DIRECTORY' });
      }

      res.download(fullPath, path.basename(fullPath));
    } catch (err) {
      console.error('Error in /api/download:', err);
      res.status(500).json({ ok: false, error: 'UNKNOWN' });
    }
  });

  router.get('/api/view/:path(*)', async (req, res) => {
    try {
      const relPath = req.params.path;
      const resolved = resolveWithBaseDir(relPath);
      if (!resolved.ok) return res.status(400).json({ ok: false, error: resolved.error });

      const fullPath = resolved.path;
      if (!fsSync.existsSync(fullPath)) {
        return res.status(404).json({ ok: false, error: 'ENOENT' });
      }

      const stat = await fs.stat(fullPath);
      if (stat.isDirectory()) {
        return res.status(400).json({ ok: false, error: 'IS_DIRECTORY' });
      }

      if (stat.size > 5 * 1024 * 1024) {
        return res.status(413).json({ ok: false, error: 'FILE_TOO_LARGE' });
      }

      const buf = await fs.readFile(fullPath);
      const hasNullOrInvalid = buf.some((b, i) => b === 0 || (b >= 0x80 && b <= 0xBF && (i === 0 || buf[i-1] < 0x80)));
      const content = hasNullOrInvalid ? `[Binary file - ${stat.size} bytes]` : buf.toString('utf-8');

      res.json({ ok: true, value: content, size: stat.size });
    } catch (err) {
      console.error('Error in /api/view:', err);
      res.status(500).json({ ok: false, error: 'UNKNOWN' });
    }
  });

  router.delete('/api/file/:path(*)', async (req, res) => {
    try {
      const relPath = req.params.path;
      const resolved = resolveWithBaseDir(relPath);
      if (!resolved.ok) return res.status(400).json({ ok: false, error: resolved.error });

      const fullPath = resolved.path;
      if (!fsSync.existsSync(fullPath)) {
        return res.status(404).json({ ok: false, error: 'ENOENT' });
      }

      await fs.rm(fullPath, { recursive: true, force: true });
      res.json({ ok: true, value: relPath });
    } catch (err) {
      console.error('Error in DELETE /api/file:', err);
      res.status(500).json({ ok: false, error: 'UNKNOWN' });
    }
  });

  router.post('/api/rename', async (req, res) => {
    try {
      let oldPath = '';
      let newName = '';

      const bb = Busboy({ headers: req.headers });

      bb.on('field', (fieldname, val) => {
        if (fieldname === 'path') oldPath = val;
        if (fieldname === 'name') newName = val;
      });

      bb.on('close', async () => {
        if (!oldPath || !newName) {
          return res.status(400).json({ ok: false, error: 'MISSING_FIELDS' });
        }

        const resolved = resolveWithBaseDir(oldPath);
        if (!resolved.ok) return res.status(400).json({ ok: false, error: resolved.error });

        const fullPath = resolved.path;
        if (!fsSync.existsSync(fullPath)) {
          return res.status(404).json({ ok: false, error: 'ENOENT' });
        }

        const safeName = path.basename(newName);
        if (!safeName || safeName === '.' || safeName === '..') {
          return res.status(400).json({ ok: false, error: 'INVALID_NAME' });
        }
        const newPath = path.join(path.dirname(fullPath), safeName);
        if (fsSync.existsSync(newPath)) {
          return res.status(400).json({ ok: false, error: 'EEXIST' });
        }

        try {
          await fs.rename(fullPath, newPath);
          const newRelPath = path.join(path.dirname(oldPath), safeName);
          res.json({ ok: true, value: newRelPath });
        } catch (err) {
          console.error('Error renaming:', err);
          res.status(500).json({ ok: false, error: 'RENAME_FAILED' });
        }
      });

      req.pipe(bb);
    } catch (err) {
      console.error('Error in POST /api/rename:', err);
      res.status(500).json({ ok: false, error: 'UNKNOWN' });
    }
  });

  router.post('/api/move', async (req, res) => {
    try {
      let source = '';
      let destination = '';

      const bb = Busboy({ headers: req.headers });

      bb.on('field', (fieldname, val) => {
        if (fieldname === 'source') source = val;
        if (fieldname === 'destination') destination = val;
      });

      bb.on('close', async () => {
        if (!source || !destination) {
          return res.status(400).json({ ok: false, error: 'MISSING_FIELDS' });
        }

        const srcResolved = resolveWithBaseDir(source);
        const destResolved = resolveWithBaseDir(destination);
        if (!srcResolved.ok || !destResolved.ok) {
          return res.status(400).json({ ok: false, error: 'INVALID_PATH' });
        }

        const srcPath = srcResolved.path;
        const destDir = destResolved.path;

        if (!fsSync.existsSync(srcPath)) {
          return res.status(404).json({ ok: false, error: 'SOURCE_NOT_FOUND' });
        }
        if (!fsSync.existsSync(destDir)) {
          return res.status(404).json({ ok: false, error: 'DEST_DIR_NOT_FOUND' });
        }

        try {
          const fileName = path.basename(srcPath);
          const finalPath = path.join(destDir, fileName);
          if (fsSync.existsSync(finalPath)) {
            return res.status(400).json({ ok: false, error: 'DEST_ALREADY_EXISTS' });
          }

          await fs.rename(srcPath, finalPath);
          const newRelPath = path.relative(baseDir, finalPath);
          res.json({ ok: true, value: newRelPath });
        } catch (err) {
          console.error('Error moving:', err);
          res.status(500).json({ ok: false, error: 'MOVE_FAILED' });
        }
      });

      req.pipe(bb);
    } catch (err) {
      console.error('Error in POST /api/move:', err);
      res.status(500).json({ ok: false, error: 'UNKNOWN' });
    }
  });

  router.post('/api/mkdir', async (req, res) => {
    try {
      let dirPath = '';

      const bb = Busboy({ headers: req.headers });

      bb.on('field', (fieldname, val) => {
        if (fieldname === 'path') dirPath = val;
      });

      bb.on('close', async () => {
        if (!dirPath) {
          return res.status(400).json({ ok: false, error: 'MISSING_FIELDS' });
        }

        const resolved = resolveWithBaseDir(dirPath);
        if (!resolved.ok) return res.status(400).json({ ok: false, error: resolved.error });

        const fullPath = resolved.path;
        if (fsSync.existsSync(fullPath)) {
          return res.status(400).json({ ok: false, error: 'EEXIST' });
        }

        try {
          await fs.mkdir(fullPath, { recursive: true });
          res.json({ ok: true, value: fullPath });
        } catch (err) {
          console.error('Error creating directory:', err);
          res.status(500).json({ ok: false, error: 'MKDIR_FAILED' });
        }
      });

      req.pipe(bb);
    } catch (err) {
      console.error('Error in POST /api/mkdir:', err);
      res.status(500).json({ ok: false, error: 'UNKNOWN' });
    }
  });

  return router;
};
