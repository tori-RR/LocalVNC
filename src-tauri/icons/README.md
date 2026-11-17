# 应用图标

矢量源文件为 [macintosh.svg](../../src/assets/macintosh.svg)。图形由路径和渐变组成，背景透明，没有嵌入位图或外部资源；应用标题栏直接引用这份 SVG。

本目录中的 PNG、ICO、ICNS，以及 `src/assets/macintosh.png`，均从 SVG 导出。它们用于操作系统图标和需要位图的场景；Windows 应用图标继续使用 ICO。

修改图标时先编辑 SVG，再同步导出各个尺寸。保留现有文件名、尺寸与透明通道，不在导出位图上单独修改图形。
