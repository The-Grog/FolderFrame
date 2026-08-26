import os
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

photos_dir = Path(__file__).resolve().parent / "photos"
photos_dir.mkdir(parents=True, exist_ok=True)

def create_image(filename, color, text):
    img = Image.new("RGB", (1920, 1080), color=color)
    draw = ImageDraw.Draw(img)

    # Try to load standard Linux truetype fonts
    font = None
    font_paths = [
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
        "/usr/share/fonts/truetype/freefont/FreeSansBold.ttf"
    ]
    for path in font_paths:
        if os.path.exists(path):
            try:
                font = ImageFont.truetype(path, 60)
                break
            except Exception:
                pass
    if font is None:
        font = ImageFont.load_default()

    text_content = text

    # Simple bounding box calculation
    try:
        bbox = draw.textbbox((0, 0), text_content, font=font)
        w = bbox[2] - bbox[0]
        h = bbox[3] - bbox[1]
    except AttributeError:
        try:
            w, h = draw.textsize(text_content, font=font)
        except AttributeError:
            w, h = 600, 80

    x = (1920 - w) / 2
    y = (1080 - h) / 2

    # Draw standard text
    draw.text((x + 3, y + 3), text_content, fill=(0, 0, 0), font=font)
    draw.text((x, y), text_content, fill=(255, 255, 255), font=font)

    img.save(photos_dir / filename)
    print(f"Created {filename}")

create_image("photo1.jpg", (50, 100, 200), "Photo 1 (JPEG) - Deep Blue Sea")
create_image("photo2.png", (40, 160, 100), "Photo 2 (PNG) - Forest Green")
create_image("photo3.webp", (200, 50, 50), "Photo 3 (WebP) - Crimson Sunset")
