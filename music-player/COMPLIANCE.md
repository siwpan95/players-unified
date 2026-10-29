# 合规声明 / Compliance

本项目的「加密曲库导入」功能（`music_player/library/encrypted_import.py`）复用
[`ncmturnmp3`](https://gitee.com/siwpan/ncmturnmp3) 的解密能力，用于把网易云 / QQ 音乐 / 酷狗 等
**用户本人已购买或合法拥有的**加密音频（`.ncm` / `.qmc` / `.kgm` 等）解密为可播放的本地文件。

## 红线

- **仅限解密你本人拥有合法权利的文件。** 不得用于解密、传播你未授权拥有的他人版权内容。
- 解密产物仅落在本机 `cache/decrypted/`，默认不随仓库分发，也不上传。
- 导入前程序会弹窗要求确认「仅解密本人已购文件」；样本（`.ncm` 等）不进 Git（见 `.gitignore`）。

## 许可证

`music-player` 本身以 MIT 许可证发布。`ncmturnmp3` 为独立仓库，其解密核心以可编辑安装 /
子进程调用的方式接入，**不复制其源码**进入本仓库，以避免许可证纠缠。
