"""TuNan Paint Bridge ComfyUI package."""

import os
import sys
from pathlib import Path

try:
    from .console_compat import safe_print
    from .tunan_bridge_nodes import (
        NODE_CLASS_MAPPINGS as BRIDGE_NODE_CLASS_MAPPINGS,
        NODE_DISPLAY_NAME_MAPPINGS as BRIDGE_NODE_DISPLAY_NAME_MAPPINGS,
    )
    from .tunan_naming import AUTHOR_NAME, NODE_DISPLAY_NAMES, PRODUCT_NAME
    from .tunan_tool_nodes import (
        NODE_CLASS_MAPPINGS as TOOL_NODE_CLASS_MAPPINGS,
        NODE_DISPLAY_NAME_MAPPINGS as TOOL_NODE_DISPLAY_NAME_MAPPINGS,
    )
except ImportError:
    from console_compat import safe_print
    from tunan_bridge_nodes import (
        NODE_CLASS_MAPPINGS as BRIDGE_NODE_CLASS_MAPPINGS,
        NODE_DISPLAY_NAME_MAPPINGS as BRIDGE_NODE_DISPLAY_NAME_MAPPINGS,
    )
    from tunan_naming import AUTHOR_NAME, NODE_DISPLAY_NAMES, PRODUCT_NAME
    from tunan_tool_nodes import (
        NODE_CLASS_MAPPINGS as TOOL_NODE_CLASS_MAPPINGS,
        NODE_DISPLAY_NAME_MAPPINGS as TOOL_NODE_DISPLAY_NAME_MAPPINGS,
    )

print = safe_print

__version__ = "1.0.12"
__author__ = AUTHOR_NAME
__description__ = "Photoshop and ComfyUI local bridge nodes"
__contact__ = "Email: 76030821@qq.com | QQ: 76030821"

if sys.version_info < (3, 8):
    raise RuntimeError(f"{PRODUCT_NAME} requires Python 3.8+")

PLUGIN_ROOT = Path(__file__).parent
WEB_DIRECTORY = "web"

NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}

NODE_CLASS_MAPPINGS.update(BRIDGE_NODE_CLASS_MAPPINGS)
NODE_CLASS_MAPPINGS.update(TOOL_NODE_CLASS_MAPPINGS)
NODE_DISPLAY_NAME_MAPPINGS.update(BRIDGE_NODE_DISPLAY_NAME_MAPPINGS)
NODE_DISPLAY_NAME_MAPPINGS.update(TOOL_NODE_DISPLAY_NAME_MAPPINGS)


def check_dependencies():
    missing = []
    for module_name, package_name in (
        ("torch", "torch"),
        ("numpy", "numpy"),
        ("PIL", "Pillow"),
        ("aiohttp", "aiohttp"),
        ("scipy", "scipy"),
    ):
        try:
            __import__(module_name)
        except ImportError:
            missing.append(package_name)

    if missing:
        print(f"[{PRODUCT_NAME}] missing dependencies: {', '.join(missing)}")
        return False
    return True


PLUGIN_INFO = {
    "name": PRODUCT_NAME,
    "version": __version__,
    "author": __author__,
    "description": __description__,
    "contact": __contact__,
    "nodes": list(NODE_CLASS_MAPPINGS.keys()),
    "node_display_names": NODE_DISPLAY_NAMES,
    "root_path": PLUGIN_ROOT,
    "web_directory": WEB_DIRECTORY,
    "features": [
        "PS桥接接收",
        "PS结果发送",
        "选区还原",
        "智能缩放",
        "蒙版微调",
    ],
}


def get_plugin_info():
    return PLUGIN_INFO.copy()


if __name__ != "__main__":
    check_dependencies()

print(f"[{PRODUCT_NAME}] v{__version__} loaded")
print(f"[{PRODUCT_NAME}] registered nodes: {list(NODE_CLASS_MAPPINGS.keys())}")

DEBUG = os.environ.get("TUNAN_DEBUG", "").lower() in ("1", "true", "yes")

if DEBUG:
    print(f"[{PRODUCT_NAME}] debug mode enabled")
    print(f"[{PRODUCT_NAME}] path: {PLUGIN_ROOT}")
    for node_id, display_name in NODE_DISPLAY_NAME_MAPPINGS.items():
        print(f" - {node_id}: {display_name}")

__all__ = [
    "NODE_CLASS_MAPPINGS",
    "NODE_DISPLAY_NAME_MAPPINGS",
    "WEB_DIRECTORY",
    "__version__",
    "__author__",
    "__description__",
]
