import argparse
import json
from pathlib import Path

from PIL import Image, ImageDraw


def texture_path(source: Path, item: dict) -> Path | None:
    name = item["name"]
    direct = source / "items" / f"{name}.png"
    if direct.exists():
        return direct
    texture = item.get("texture")
    if isinstance(texture, list):
        texture = texture[0] if texture else ""
    texture = str(texture or "").replace("minecraft:", "")
    texture = texture.replace("items/", "items/").replace("item/", "items/").replace("block/", "blocks/")
    mapped = source / f"{texture}.png"
    if mapped.exists():
        return mapped
    block = source / "blocks" / f"{name}.png"
    return block if block.exists() else None


def first_frame(path: Path | None, size: int) -> Image.Image:
    if not path:
        image = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        draw = ImageDraw.Draw(image)
        draw.rectangle((4, 4, size - 5, size - 5), fill=(35, 0, 45, 255))
        draw.rectangle((4, 4, size // 2, size // 2), fill=(220, 0, 220, 255))
        draw.rectangle((size // 2, size // 2, size - 5, size - 5), fill=(220, 0, 220, 255))
        return image
    image = Image.open(path).convert("RGBA")
    frame = min(image.width, image.height)
    image = image.crop((0, 0, frame, frame))
    return image.resize((size, size), Image.Resampling.NEAREST)


def main() -> None:
    parser = argparse.ArgumentParser(description="Build the compact AFK Desk Minecraft item texture atlas.")
    parser.add_argument("source", type=Path, help="minecraft-assets data/<version> directory")
    parser.add_argument("output", type=Path, help="AFK Desk assets directory")
    args = parser.parse_args()
    items = json.loads((args.source / "items_textures.json").read_text(encoding="utf-8"))
    items = sorted((item for item in items if item.get("name")), key=lambda item: item["name"])
    cell, columns = 32, 32
    rows = (len(items) + columns - 1) // columns
    atlas = Image.new("RGBA", (columns * cell, rows * cell), (0, 0, 0, 0))
    indexes = {}
    for index, item in enumerate(items):
        indexes[item["name"]] = index
        atlas.alpha_composite(first_frame(texture_path(args.source, item), cell), ((index % columns) * cell, (index // columns) * cell))
    args.output.mkdir(parents=True, exist_ok=True)
    atlas.save(args.output / "minecraft-items.png", optimize=True)
    payload = {"version": args.source.name, "cell": cell, "columns": columns, "rows": rows, "items": indexes}
    (args.output / "minecraft-items.js").write_text(
        "window.__minecraftItemAtlas = " + json.dumps(payload, separators=(",", ":")) + ";\n",
        encoding="utf-8",
    )


if __name__ == "__main__":
    main()
