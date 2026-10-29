# player

模拟 Windows Media Player（WMP）的可视化效果程序。

## 简介
使用 Tkinter 绘制多种音频可视化效果（条形图、尖峰、波浪、粒子、漩涡、迷幻等），通过底部菜单切换效果类型，模拟 WMP 的频谱跳动动画。

## 语言 / 类型
- 语言：Python（仅标准库 tkinter，无第三方依赖）
- 类型：桌面 GUI 小工具（可视化效果模拟器）

## 目录要点
- `player.py`：单文件程序，包含全部逻辑（可视化效果类 `WMPVisualizer`）。

## 运行方式与依赖
```
python player.py
```
- 依赖：Python 标准库（tkinter、random、math、time、collections）。

## 测试状态
- `py_compile` 语法检查：通过（1 个 .py）。
- 运行：GUI 窗口程序，未实际启动（避免卡住）。
