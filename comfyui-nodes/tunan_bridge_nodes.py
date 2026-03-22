"""Main nodes for TuNan Paint Bridge."""

try:
    from .console_compat import safe_print
    from .tunan_naming import MAIN_CATEGORY, NODE_DISPLAY_NAMES, NODE_IDS, PRODUCT_NAME
    from .tunan_runtime import runtime_backend
except ImportError:
    from console_compat import safe_print
    from tunan_naming import MAIN_CATEGORY, NODE_DISPLAY_NAMES, NODE_IDS, PRODUCT_NAME
    from tunan_runtime import runtime_backend

print = safe_print


class TuNanPSBridgeNode(runtime_backend.TunanPSBridge):
    RELATIVE_PYTHON_MODULE = "custom_nodes.tunan-paint-bridge"
    RETURN_TYPES = ("IMAGE", "MASK", "FLOAT", "INT", "STRING", "STRING", "FLOAT", "INT")
    RETURN_NAMES = (
        "\u56fe\u50cf",
        "\u771f\u5b9e\u9009\u533a\u8499\u7248",
        "\u964d\u566a\u5f3a\u5ea6",
        "\u79cd\u5b50",
        "\u6b63\u9762\u63d0\u793a\u8bcd",
        "\u8d1f\u9762\u63d0\u793a\u8bcd",
        "CFG",
        "\u6b65\u6570",
    )
    FUNCTION = "bridge_ps_data"
    OUTPUT_NODE = True
    CATEGORY = MAIN_CATEGORY

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {},
            "hidden": {
                "current_image_url": ("STRING", {"default": ""}),
                "connection_status": ("STRING", {"default": ""}),
            },
        }

    def bridge_ps_data(self, current_image_url="", connection_status=""):
        return super().bridge_ps_data(
            "\u56fe\u50cf\u548c\u53c2\u6570",
            "RGB",
            current_image_url,
            connection_status,
        )


class TuNanPSSenderNode(runtime_backend.TunanPSSender):
    RELATIVE_PYTHON_MODULE = "custom_nodes.tunan-paint-bridge"
    RETURN_TYPES = ()
    FUNCTION = "process_and_send"
    CATEGORY = MAIN_CATEGORY
    OUTPUT_NODE = True

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "\u56fe\u50cf": ("IMAGE",),
                "\u56de\u8d34\u6a21\u5f0f": (["\u9009\u533a\u8fd8\u539f\u6a21\u5f0f", "\u6574\u56fe\u6a21\u5f0f"], {"default": "\u9009\u533a\u8fd8\u539f\u6a21\u5f0f"}),
                "\u8fb9\u7f18\u6536\u7f29": ("INT", {"default": 0, "min": 0, "max": 128, "step": 1}),
                "\u8fb9\u7f18\u67d4\u5316": ("INT", {"default": 0, "min": 0, "max": 128, "step": 1}),
            },
            "optional": {
                "\u56fe\u50cf\u540d\u79f0": ("STRING", {"default": PRODUCT_NAME, "multiline": False}),
            },
        }

    def process_and_send(self, **kwargs):
        image = kwargs["\u56fe\u50cf"]
        return_mode = kwargs.get("\u56de\u8d34\u6a21\u5f0f", "\u9009\u533a\u8fd8\u539f\u6a21\u5f0f")
        edge_shrink = kwargs.get("\u8fb9\u7f18\u6536\u7f29", 0)
        edge_feather = kwargs.get("\u8fb9\u7f18\u67d4\u5316", 0)
        image_name = kwargs.get("\u56fe\u50cf\u540d\u79f0", PRODUCT_NAME)
        return super().process_and_send(
            image,
            "PNG",
            return_mode,
            edge_shrink,
            edge_feather,
            image_name,
            90,
            6,
        )


NODE_CLASS_MAPPINGS = {
    NODE_IDS["bridge"]: TuNanPSBridgeNode,
    NODE_IDS["sender"]: TuNanPSSenderNode,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    node_id: NODE_DISPLAY_NAMES[node_id]
    for node_id in NODE_CLASS_MAPPINGS
}

print(f"[{PRODUCT_NAME}] main nodes loaded: {list(NODE_CLASS_MAPPINGS.keys())}")


