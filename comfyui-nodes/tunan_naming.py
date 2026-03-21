"""Naming constants for TuNan Paint Bridge."""

PRODUCT_NAME = "\u56fe\u5357\u753b\u6865"
AUTHOR_NAME = "\u56fe\u5357\u7ed8\u753b\u5de5\u4f5c\u5ba4"
MAIN_CATEGORY = PRODUCT_NAME
TOOLS_CATEGORY = f"{PRODUCT_NAME}/\u5de5\u5177"

NODE_IDS = {
    "bridge": "TuNanPSBridge",
    "sender": "TuNanPSSender",
    "smart_resize": "TuNanSmartResize",
    "mask_refine": "TuNanMaskRefine",
}

NODE_DISPLAY_NAMES = {
    NODE_IDS["bridge"]: "\u56fe\u5357PS\u6865\u63a5\u5668",
    NODE_IDS["sender"]: "\u56fe\u5357PS\u53d1\u9001\u5668",
    NODE_IDS["smart_resize"]: "\u56fe\u5357\u667a\u80fd\u7f29\u653e",
    NODE_IDS["mask_refine"]: "\u56fe\u5357\u8499\u7248\u5fae\u8c03",
}
