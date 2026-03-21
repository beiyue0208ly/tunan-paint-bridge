# 图南画桥安装说明

图南画桥包含两部分：

1. Photoshop 插件 `.ccx`
2. ComfyUI 节点

两边都装好后，Photoshop 和 ComfyUI 才能正常通信。

## 一、先装 ComfyUI 节点

### 方式 1：ComfyUI Manager

推荐优先用 ComfyUI Manager 安装图南画桥节点。

安装完成后，请再去下载匹配版本的 Photoshop 插件 `.ccx`。

### 方式 2：手动安装

1. 下载节点压缩包
2. 解压到 `ComfyUI/custom_nodes/`
3. 安装 `requirements.txt` 里的依赖
4. 重启 ComfyUI

## 二、再装 Photoshop 插件

Photoshop 插件以 `.ccx` 形式发布。

### 官方方式

1. 双击 `.ccx`
2. 按提示完成安装
3. 重启 Photoshop

### 注意

- 当前要求 Photoshop `25.0.0+`
- 建议使用正版 Photoshop
- 如果官网下载页还没上线，请直接从 GitHub Releases 下载 `.ccx`

## 三、下载入口

官网：

- [tunanart.cn](https://tunanart.cn)

如果官网还没放下载页，就看当前仓库的 Releases 页面。

## 四、最简单的理解

如果你拿到的是总安装包 `bundle.zip`，解压后你会看到：

1. Photoshop 插件 `.ccx`
2. ComfyUI 节点 zip
3. 安装说明

按顺序装完这两部分就可以开始使用图南画桥。

## 五、联系方式

- Issues：GitHub Issues
- Email：76030821@qq.com
- QQ：76030821
