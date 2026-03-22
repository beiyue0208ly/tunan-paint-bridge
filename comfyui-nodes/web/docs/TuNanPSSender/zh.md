# 图南 PS 发送器

> 这个节点负责把 ComfyUI 结果送回 Photoshop。  
> 使用前请先安装图南画桥 Photoshop 插件（`.ccx`）。  
> 下载入口：
> - 官网：[tunanart.cn](https://tunanart.cn)
> - GitHub Releases：[tunan-paint-bridge Releases](https://github.com/beiyue0208ly/tunan-paint-bridge/releases)

## 作用

- 把生成结果回传给 Photoshop
- 支持整图模式和选区还原模式
- 支持边缘收缩和边缘柔化，减少回贴时的接缝感

## 常见用法

- 把最终图像输出接到这个节点
- 在 Photoshop 里确认回贴后，结果会按当前模式贴回原文档

## 使用提示

- 一条工作流里通常只需要一个发送器
- 如果没有发送器，ComfyUI 能正常出图，但 Photoshop 不会收到回传结果
