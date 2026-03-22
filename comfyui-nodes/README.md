# 图南画桥 ComfyUI 节点

> 重要说明  
> 这个仓库只提供 ComfyUI 侧节点。  
> 想要真正连接 Photoshop 使用，还需要额外安装“图南画桥” Photoshop 插件（`.ccx`）。

## Photoshop 插件下载

- 官网下载：[tunanart.cn](https://tunanart.cn)
- GitHub Releases 下载：[tunan-paint-bridge Releases](https://github.com/beiyue0208ly/tunan-paint-bridge/releases)

如果官网下载页暂时还没更新，优先去 GitHub Releases 下载与你当前节点版本对应的 `.ccx`。

## 这个节点仓库包含什么

- `TuNanPSBridge`：接收 Photoshop 发送过来的图像和参数
- `TuNanPSSender`：把 ComfyUI 结果回传给 Photoshop
- `TuNanSmartResize`：按工作流需求做尺寸整理
- `TuNanMaskRefine`：对选区 / 蒙版做轻量整理

## 安装方式

### 方式 1：ComfyUI Manager

推荐优先使用 ComfyUI Manager 安装本节点。

安装完成后，请继续安装 Photoshop 插件：

- 官网：[https://tunanart.cn](https://tunanart.cn)
- Releases：[https://github.com/beiyue0208ly/tunan-paint-bridge/releases](https://github.com/beiyue0208ly/tunan-paint-bridge/releases)

### 方式 2：手动安装

1. 下载本仓库 zip
2. 解压到 `ComfyUI/custom_nodes/`
3. 安装 [requirements.txt](./requirements.txt) 中的依赖
4. 重启 ComfyUI
5. 另外安装匹配版本的 Photoshop 插件 `.ccx`

## 版本对应

- `图南画桥节点 1.0.x` 对应 `Photoshop 插件 1.0.x`
- 对外发版时会同时提供：
- `.ccx`
- 节点 zip
- 总安装包 bundle zip

## Registry / Manager 显示

- 节点显示名由 `pyproject.toml` 里的 `DisplayName` 决定
- 当前显示名为：`图南画桥`
- 官网和 Releases 会作为节点说明里的固定下载入口

## 作者与版权

- 制作人 / 作者：北月（Beiyue）
- 制作团队：图南绘画工作室
- License：MIT
