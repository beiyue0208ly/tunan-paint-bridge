from pathlib import Path


WEBSITE_URL = "https://tunanart.cn"


def main():
    repo_hint = Path(__file__).resolve().parent.name
    print("[图南画桥] ComfyUI nodes installed.")
    print("[图南画桥] Photoshop companion plugin (.ccx) is distributed separately.")
    print(f"[图南画桥] Official website: {WEBSITE_URL}")
    print(
        "[图南画桥] If the website download page is not ready yet, "
        "open this repository's Releases page and download the matching .ccx package."
    )
    print(f"[图南画桥] Installed package folder: {repo_hint}")


if __name__ == "__main__":
    main()
