// 加密曲库导入桥（对齐 Python library/encrypted_import.py）。
//
// 复用 ncmturnmp3（D:/projects/ncmturnmp3 的 audio_core.process_one），通过
// 调起 Python（/Python314）执行解密，不复制其源码。找不到 ncmturnmp3 时
// 给出清晰错误并优雅降级（对齐 Python 侧的 EncryptedImportError 语义）。

import { Service } from '../core/index.js';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

export class EncryptedImportService extends Service {
  constructor(ctx, config = {}) {
    super(ctx, 'encrypted-import');
    this.ctx = ctx;
    this.python = config.python || process.env.PYTHON_PATH || 'python';
    this.ncmDir = config.ncmDir || process.env.NCMTURNMP3_DIR || 'D:/projects/ncmturnmp3';
    this.cacheDir = config.cacheDir || path.resolve(process.cwd(), 'cache/decrypted');
  }

  /** 解密单个加密音频，返回可播放的 media 描述；失败抛错（带可操作提示）。 */
  importEncrypted(src, { outputFormat = 'mp3', bitrate = '320k' } = {}) {
    if (!existsSync(src)) throw new Error(`文件不存在：${src}`);
    if (!existsSync(path.join(this.ncmDir, 'audio_core.py'))) {
      throw new Error(
        `未找到 ncmturnmp3（加密音乐转换器）。请确认 ${this.ncmDir} 存在，或设置环境变量 NCMTURNMP3_DIR 指向其目录。`
      );
    }
    mkdirSync(this.cacheDir, { recursive: true });

    const script = [
      'import sys',
      'sys.path.insert(0, sys.argv[1])',
      'from audio_core import process_one',
      'ok, msg = process_one(sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5])',
      'print("OK" if ok else "FAIL")',
      'print(msg)',
    ].join('\n');

    const res = spawnSync(this.python, ['-c', script, this.ncmDir, src, this.cacheDir, outputFormat, bitrate], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    const out = (res.stdout || '').split(/\r?\n/).filter(Boolean);
    const status = out[0] || 'FAIL';
    const msg = out.slice(1).join('\n') || (res.stderr ? res.stderr.trim() : '');

    if (status !== 'OK') {
      throw new Error(`解密失败：${msg || `python 退出码 ${res.status}`}`);
    }

    const stem = path.basename(src).replace(/\.[^.]+$/, '');
    const outPath = path.join(this.cacheDir, `${stem}.${outputFormat}`);
    if (!existsSync(outPath)) throw new Error(`解密产物未生成：预期 ${outPath}（${msg}）`);

    return {
      path: outPath,
      uri: 'file:///' + outPath.replace(/\\/g, '/').replace(/ /g, '%20'),
      title: stem,
      item_type: 'decrypted_cache',
      source_path: src,
    };
  }
}

export default EncryptedImportService;
