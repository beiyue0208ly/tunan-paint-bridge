"""Resource and cache-file management for TuNan Paint Bridge."""

from __future__ import annotations

import atexit
import os
import shutil
import signal
import sys
import time
from typing import Optional

import folder_paths
from PIL import Image, ImageDraw, ImageFont


class TunanResourceManager:
    """Manage bridge temp files, waiting images, and preview assets."""

    def __init__(self):
        self.plugin_dir = self._create_plugin_directory()
        self.current_image_path: Optional[str] = None
        self.sender_preview_path: Optional[str] = None
        self.waiting_image_path: Optional[str] = None
        self.sender_waiting_image_path: Optional[str] = None

        self._create_waiting_image()
        self._create_sender_waiting_image()

        atexit.register(self.cleanup_temp_files)
        signal.signal(signal.SIGTERM, self._signal_handler)
        signal.signal(signal.SIGINT, self._signal_handler)

    def _signal_handler(self, signum, frame):
        self.cleanup_temp_files()
        sys.exit(0)

    def _create_plugin_directory(self):
        try:
            base_temp = folder_paths.get_temp_directory()
            plugin_dir = os.path.join(base_temp, "tunan_paint_bridge")
            os.makedirs(plugin_dir, exist_ok=True)
            return plugin_dir
        except Exception:
            return folder_paths.get_temp_directory()

    def _load_fonts(self):
        for font_name in ("msyh.ttc", "arial.ttf"):
            try:
                return (
                    ImageFont.truetype(font_name, 32),
                    ImageFont.truetype(font_name, 22),
                    ImageFont.truetype(font_name, 18),
                )
            except Exception:
                continue

        default_font = ImageFont.load_default()
        return default_font, default_font, default_font

    def _draw_centered_text(self, draw, text, y, font, fill):
        text_bbox = draw.textbbox((0, 0), text, font=font)
        text_width = text_bbox[2] - text_bbox[0]
        text_x = (512 - text_width) // 2
        draw.text((text_x, y), text, fill=fill, font=font)

    def _create_base_waiting_image(self, border_color):
        img = Image.new("RGB", (512, 512), color=(45, 45, 55))
        draw = ImageDraw.Draw(img)

        for y in range(512):
            color_value = int(45 + (y / 512) * 15)
            color = (color_value, color_value, color_value + 3)
            draw.line([(0, y), (512, y)], fill=color)

        draw.rectangle([15, 15, 496, 496], outline=border_color, width=2)
        return img, draw

    def _create_waiting_image(self):
        self.waiting_image_path = os.path.join(self.plugin_dir, "waiting_ps.png")
        if os.path.exists(self.waiting_image_path):
            return

        try:
            img, draw = self._create_base_waiting_image((80, 120, 160))
            font_large, font_medium, font_small = self._load_fonts()

            self._draw_centered_text(draw, "等待 Photoshop 图像", 200, font_large, (220, 220, 230))
            self._draw_centered_text(draw, "图南画桥", 250, font_medium, (160, 160, 170))
            self._draw_centered_text(draw, "发送后会在这里显示预览", 290, font_small, (130, 130, 140))

            img.save(self.waiting_image_path, "PNG")
        except Exception:
            self._create_simple_fallback_image(self.waiting_image_path, "等待 Photoshop 图像")

    def _create_sender_waiting_image(self):
        self.sender_waiting_image_path = os.path.join(self.plugin_dir, "waiting_sender.png")
        if os.path.exists(self.sender_waiting_image_path):
            return

        try:
            img, draw = self._create_base_waiting_image((160, 120, 80))
            font_large, font_medium, font_small = self._load_fonts()

            self._draw_centered_text(draw, "等待生成图片", 200, font_large, (220, 220, 230))
            self._draw_centered_text(draw, "图南画桥", 250, font_medium, (180, 180, 200))
            self._draw_centered_text(draw, "生成结果会在这里显示预览", 290, font_small, (130, 130, 140))

            img.save(self.sender_waiting_image_path, "PNG")
        except Exception:
            self._create_simple_fallback_image(self.sender_waiting_image_path, "等待生成图片")

    def _create_simple_fallback_image(self, path, title):
        try:
            img = Image.new("RGB", (512, 512), color=(60, 60, 70))
            draw = ImageDraw.Draw(img)
            draw.text((170, 240), title, fill=(200, 200, 200))
            draw.text((210, 270), "图南画桥", fill=(150, 150, 150))
            img.save(path, "PNG")
        except Exception:
            pass

    def save_current_image(self, pil_image):
        try:
            previous_path = self.current_image_path
            timestamp = str(int(time.time() * 1000))
            filename = f"current_image_{timestamp}.png"
            filepath = os.path.join(self.plugin_dir, filename)

            pil_image.save(filepath, "PNG")
            self.current_image_path = filepath
            if previous_path and previous_path != filepath and os.path.exists(previous_path):
                try:
                    os.remove(previous_path)
                except Exception:
                    pass
            return filepath
        except Exception:
            return None

    def save_sender_preview(self, pil_image):
        try:
            previous_path = self.sender_preview_path
            timestamp = str(int(time.time() * 1000))
            filename = f"sender_preview_{timestamp}.png"
            filepath = os.path.join(self.plugin_dir, filename)

            pil_image.save(filepath, "PNG")
            self.sender_preview_path = filepath
            if previous_path and previous_path != filepath and os.path.exists(previous_path):
                try:
                    os.remove(previous_path)
                except Exception:
                    pass
            return filepath
        except Exception:
            return None

    def get_current_image_url(self):
        return "/tunan/ps/current_image"

    def cleanup_temp_files(self):
        try:
            if self.current_image_path and os.path.exists(self.current_image_path):
                os.remove(self.current_image_path)

            if self.plugin_dir and os.path.exists(self.plugin_dir):
                for filename in os.listdir(self.plugin_dir):
                    if filename.startswith(("current_image_", "sender_preview_", "sender_output_")):
                        file_path = os.path.join(self.plugin_dir, filename)
                        try:
                            os.remove(file_path)
                        except Exception:
                            pass
        except Exception:
            pass

    def cleanup_all_cache(self):
        try:
            if self.plugin_dir and os.path.exists(self.plugin_dir):
                shutil.rmtree(self.plugin_dir)
                self.plugin_dir = self._create_plugin_directory()
                self._create_waiting_image()
                self._create_sender_waiting_image()
        except Exception:
            pass

