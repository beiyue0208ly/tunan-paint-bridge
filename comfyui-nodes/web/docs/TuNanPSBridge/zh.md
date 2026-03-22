# 图南 PS 桥接器

> 使用前请先安装图南画桥 Photoshop 插件（`.ccx`）。  
> 插件下载：
> - 官网：[tunanart.cn](https://tunanart.cn)
> - GitHub Releases：[tunan-paint-bridge Releases](https://github.com/beiyue0208ly/tunan-paint-bridge/releases)

这是图南画桥里负责接收 Photoshop 数据的入口节点。

## 作用

- 接收 Photoshop 当前发送过来的图像
- 接收选区蒙版、降噪、种子、提示词、CFG、步数等参数
- 作为工作流起点，把绘画上下文送入 ComfyUI

## 适合放在哪里

- 放在工作流最前面
- 它的图像输出通常接后续采样、重绘、修图流程
- 它的参数输出可以直接接到采样器或提示词相关节点

## 使用提示

- 如果没有安装 Photoshop 插件，这个节点无法收到来自 PS 的画面
- 如果工作流里没有这个节点，Photoshop 侧也无法把图像送进来
- 当你想从 PS 发起局部重绘或整图重绘时，这个节点必须存在
