"""Runtime helpers for TuNan Paint Bridge."""

import importlib

import numpy as np
import torch
import torch.nn.functional as F
from scipy import ndimage


def _load_runtime():
    if __package__:
        return importlib.import_module(f"{__package__}.tunan_backend")
    return importlib.import_module("tunan_backend")


runtime_backend = _load_runtime()


def get_ps_bridge():
    return runtime_backend.ps_bridge


def get_ps_connection():
    return runtime_backend.ps_connection


def get_resource_manager():
    return runtime_backend.resource_manager


def ensure_mask_batch(mask):
    if mask is None:
        return None
    if mask.dim() == 2:
        mask = mask.unsqueeze(0)
    return mask.float().clamp(0.0, 1.0)


def ensure_image_rgb(image):
    return image[..., :3]


def resize_mask(mask, height, width, batch_size):
    mask = ensure_mask_batch(mask)
    if mask is None:
        return None

    resized = F.interpolate(
        mask.unsqueeze(1),
        size=(height, width),
        mode="bilinear",
        align_corners=False,
    ).squeeze(1)

    if resized.shape[0] == batch_size:
        return resized.clamp(0.0, 1.0)
    if resized.shape[0] == 1:
        return resized.repeat(batch_size, 1, 1).clamp(0.0, 1.0)
    return resized[:batch_size].clamp(0.0, 1.0)


def merge_image_and_mask(image, mask):
    image_rgb = ensure_image_rgb(image)
    alpha = resize_mask(mask, image_rgb.shape[1], image_rgb.shape[2], image_rgb.shape[0])
    if alpha is None:
        return image_rgb
    return torch.cat([image_rgb, alpha.unsqueeze(-1)], dim=-1)


def mask_to_bbox(mask, threshold=0.001):
    mask = ensure_mask_batch(mask)
    mask_np = mask[0].detach().cpu().numpy()
    coords = np.argwhere(mask_np > threshold)
    if coords.size == 0:
        return (0, 0, int(mask_np.shape[1]), int(mask_np.shape[0])), False

    y0, x0 = coords.min(axis=0)
    y1, x1 = coords.max(axis=0) + 1
    return (int(x0), int(y0), int(x1 - x0), int(y1 - y0)), True


def expand_or_contract_mask(mask, pixels):
    mask = ensure_mask_batch(mask)
    if mask is None or pixels == 0:
        return mask

    binary = mask.detach().cpu().numpy() > 0.001
    iterations = abs(int(pixels))
    if iterations == 0:
        return mask

    processed = []
    for item in binary:
        if pixels > 0:
            updated = ndimage.binary_dilation(item, iterations=iterations)
        else:
            updated = ndimage.binary_erosion(item, iterations=iterations)
        processed.append(updated.astype(np.float32))

    return torch.from_numpy(np.stack(processed, axis=0)).to(mask.device, dtype=mask.dtype)


def feather_mask(mask, radius):
    mask = ensure_mask_batch(mask)
    if mask is None or radius <= 0:
        return mask

    sigma = max(float(radius) / 3.0, 0.1)
    mask_np = mask.detach().cpu().numpy()
    blurred = np.stack(
        [ndimage.gaussian_filter(item, sigma=sigma) for item in mask_np],
        axis=0,
    )
    return torch.from_numpy(blurred).to(mask.device, dtype=mask.dtype).clamp(0.0, 1.0)



