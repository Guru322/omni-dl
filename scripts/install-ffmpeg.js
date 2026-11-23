const { execFileSync } = require('node:child_process');
const { existsSync } = require('node:fs');
const ffmpegPath = require('ffmpeg-static');

// Rebuild an existing npm package if a previous install skipped its binary download.
if (ffmpegPath && !existsSync(ffmpegPath)) {
  execFileSync(process.execPath, [process.env.npm_execpath, 'rebuild', 'ffmpeg-static'], {
    stdio: 'inherit',
  });
}
