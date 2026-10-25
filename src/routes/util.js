const multer = require('multer');
const { paths } = require('../config');

/** Wrap an async route handler so rejections reach the error middleware. */
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const upload = multer({ dest: paths.tmp, limits: { fileSize: 4 * 1024 * 1024 * 1024 } });
// Keeps the relative paths browsers send for folder uploads (e.g. world/region/r.0.0.mca).
const folderUpload = multer({ dest: paths.tmp, preservePath: true, limits: { fileSize: 4 * 1024 * 1024 * 1024 } });

module.exports = { ah, upload, folderUpload };
