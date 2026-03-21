"""Tool nodes for TuNan Paint Bridge."""

import torch.nn.functional as F
from nodes import MAX_RESOLUTION

try:
    from .console_compat import safe_print
    from .tunan_naming import NODE_DISPLAY_NAMES, NODE_IDS, PRODUCT_NAME, TOOLS_CATEGORY
    from .tunan_runtime import (
        ensure_image_rgb,
        ensure_mask_batch,
        expand_or_contract_mask,
        feather_mask,
    )
except ImportError:
    from console_compat import safe_print
    from tunan_naming import NODE_DISPLAY_NAMES, NODE_IDS, PRODUCT_NAME, TOOLS_CATEGORY
    from tunan_runtime import (
        ensure_image_rgb,
        ensure_mask_batch,
        expand_or_contract_mask,
        feather_mask,
    )

print = safe_print

LABEL_IMAGE = "\u56fe\u50cf"
LABEL_MASK = "\u8499\u7248"
LABEL_EXPAND = "\u8fb9\u7f18\u6269\u7f29"
LABEL_FEATHER = "\u8fb9\u7f18\u67d4\u5316"
LABEL_TARGET_SIZE = "\u76ee\u6807\u8fb9\u957f"
LABEL_EDGE_MODE = "\u6309\u54ea\u6761\u8fb9"
LABEL_LONG_EDGE = "\u957f\u8fb9"
LABEL_SHORT_EDGE = "\u77ed\u8fb9"
LABEL_RESIZE_POLICY = "\u7f29\u653e\u9650\u5236"
LABEL_AUTO = "\u81ea\u7531\u7f29\u653e"
LABEL_ONLY_UP = "\u4ec5\u653e\u5927"
LABEL_ONLY_DOWN = "\u4ec5\u7f29\u5c0f"
LABEL_ALIGN = "\u5c3a\u5bf8\u5bf9\u9f50"
LABEL_INTERPOLATION = "\u7f29\u653e\u8d28\u91cf"
LABEL_NEAREST = "\u6700\u5feb"
LABEL_BILINEAR = "\u5e73\u6ed1"
LABEL_BICUBIC = "\u9ad8\u6e05"
LABEL_AREA = "\u4fdd\u9762\u79ef"
LABEL_WIDTH = "\u5bbd"
LABEL_HEIGHT = "\u9ad8"
LABEL_INVERT = "\u8499\u7248\u53cd\u8f6c"

INTERPOLATION_MODES = {
    LABEL_NEAREST: "nearest",
    LABEL_BILINEAR: "bilinear",
    LABEL_BICUBIC: "bicubic",
    LABEL_AREA: "area",
}


class TuNanSmartResizeNode:
    RELATIVE_PYTHON_MODULE = "custom_nodes.tunan-paint-bridge"
    RETURN_TYPES = ("IMAGE", "INT", "INT")
    RETURN_NAMES = (LABEL_IMAGE, LABEL_WIDTH, LABEL_HEIGHT)
    FUNCTION = "resize_image"
    CATEGORY = TOOLS_CATEGORY

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                LABEL_IMAGE: ("IMAGE",),
                LABEL_TARGET_SIZE: ("INT", {"default": 1024, "min": 64, "max": MAX_RESOLUTION, "step": 64}),
                LABEL_EDGE_MODE: ([LABEL_LONG_EDGE, LABEL_SHORT_EDGE], {"default": LABEL_LONG_EDGE}),
                LABEL_RESIZE_POLICY: ([LABEL_AUTO, LABEL_ONLY_UP, LABEL_ONLY_DOWN], {"default": LABEL_AUTO}),
                LABEL_ALIGN: ("INT", {"default": 64, "min": 8, "max": 128, "step": 8}),
                LABEL_INTERPOLATION: (list(INTERPOLATION_MODES.keys()), {"default": LABEL_BICUBIC}),
            }
        }

    def resize_image(self, **kwargs):
        image_rgb = ensure_image_rgb(kwargs[LABEL_IMAGE])
        target_size = kwargs[LABEL_TARGET_SIZE]
        edge_mode = kwargs[LABEL_EDGE_MODE]
        resize_policy = kwargs[LABEL_RESIZE_POLICY]
        align_multiple = kwargs[LABEL_ALIGN]
        interpolation_label = kwargs[LABEL_INTERPOLATION]

        _, height, width, _ = image_rgb.shape
        reference = max(width, height) if edge_mode == LABEL_LONG_EDGE else min(width, height)

        if resize_policy == LABEL_ONLY_UP:
            target_reference = max(reference, target_size)
        elif resize_policy == LABEL_ONLY_DOWN:
            target_reference = min(reference, target_size)
        else:
            target_reference = target_size

        scale = target_reference / max(reference, 1)
        new_width = self._align_size(int(round(width * scale)), align_multiple)
        new_height = self._align_size(int(round(height * scale)), align_multiple)

        mode = INTERPOLATION_MODES[interpolation_label]
        resized = self._resize(image_rgb, new_height, new_width, mode)
        return (resized, int(new_width), int(new_height))

    def _align_size(self, value, multiple):
        aligned = int(round(max(value, 1) / multiple) * multiple)
        aligned = max(multiple, aligned)
        return min(aligned, MAX_RESOLUTION)

    def _resize(self, image, height, width, mode):
        kwargs = {
            "size": (height, width),
            "mode": mode,
        }
        if mode in {"bilinear", "bicubic"}:
            kwargs["align_corners"] = False
            kwargs["antialias"] = True
        resized = F.interpolate(image.permute(0, 3, 1, 2), **kwargs)
        return resized.permute(0, 2, 3, 1).clamp(0.0, 1.0)


class TuNanMaskRefineNode:
    RELATIVE_PYTHON_MODULE = "custom_nodes.tunan-paint-bridge"
    RETURN_TYPES = ("MASK",)
    RETURN_NAMES = (LABEL_MASK,)
    FUNCTION = "refine_mask"
    CATEGORY = TOOLS_CATEGORY

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                LABEL_MASK: ("MASK",),
                LABEL_EXPAND: ("INT", {"default": 0, "min": -128, "max": 128, "step": 1}),
                LABEL_FEATHER: ("FLOAT", {"default": 0.0, "min": 0.0, "max": 64.0, "step": 0.5}),
                LABEL_INVERT: ("BOOLEAN", {"default": False}),
            }
        }

    def refine_mask(self, **kwargs):
        mask = ensure_mask_batch(kwargs[LABEL_MASK])
        expand_pixels = kwargs[LABEL_EXPAND]
        feather_radius = kwargs[LABEL_FEATHER]
        invert = kwargs[LABEL_INVERT]

        if expand_pixels != 0:
            mask = expand_or_contract_mask(mask, expand_pixels)
        if feather_radius > 0:
            mask = feather_mask(mask, feather_radius)
        if invert:
            mask = 1.0 - mask

        return (mask.clamp(0.0, 1.0),)


NODE_CLASS_MAPPINGS = {
    NODE_IDS["smart_resize"]: TuNanSmartResizeNode,
    NODE_IDS["mask_refine"]: TuNanMaskRefineNode,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    node_id: NODE_DISPLAY_NAMES[node_id]
    for node_id in NODE_CLASS_MAPPINGS
}

print(f"[{PRODUCT_NAME}] tool nodes loaded: {list(NODE_CLASS_MAPPINGS.keys())}")

