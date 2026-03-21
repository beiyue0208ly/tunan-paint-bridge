# 图南画桥 ComfyUI 节点

这是图南画桥的 ComfyUI 节点部分。

它负责：

- 接收 Photoshop 侧发来的图像和参数
- 管理桥接状态、工作流同步和结果回传
- 在 ComfyUI 里提供图南画桥相关节点和前端脚本

## 安装方式

### 方式 1：ComfyUI Manager

推荐优先用 ComfyUI Manager 安装这个节点仓库。

安装完成后，请另外下载匹配版本的 Photoshop 插件 `.ccx`。

### 方式 2：手动安装

1. 下载本仓库 zip
2. 解压到 `ComfyUI/custom_nodes/`
3. 安装 [requirements.txt](./requirements.txt) 里的依赖
4. 重启 ComfyUI

## Photoshop 插件下载

Photoshop 侧插件会单独以 `.ccx` 形式发布。

下载入口建议优先看：

- [tunanart.cn](https://tunanart.cn)
- 当前仓库的 Releases 页面

如果网站下载页还没上线，就先从 GitHub Releases 下载匹配版本的 `.ccx`。

## 版本兼容约定

- `图南画桥节点 1.0.x` 对应 `Photoshop 插件 1.0.x`
- 发布时会同时提供：
- `.ccx`
- 节点 zip
- 总安装包 bundle zip

## 仓库元数据

为了接入 ComfyUI Manager / Registry，这个目录已经补了：

- [pyproject.toml](./pyproject.toml)
- [requirements.txt](./requirements.txt)
- [install.py](./install.py)

在正式提交到 Registry 前，还需要把 `pyproject.toml` 里的 GitHub 仓库地址和 `PublisherId` 改成你的真实信息。

## 作者与版权

- 制作人 / 作者：北月（Beiyue）
- 制作团队：图南绘画工作室
- License：MIT
