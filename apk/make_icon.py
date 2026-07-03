"""
Genera el icono de la APK de EMTropello: un autobús (vista lateral) sobre fondo
naranja EMT, dibujado con Pillow. Salida: apk/res/mipmap-*/ic_launcher.png.
"""
import os
from PIL import Image, ImageDraw

S = 512


def draw(s=S):
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    k = s / 512.0

    def R(*v):
        return [x * k for x in v]

    orange = (247, 148, 29, 255)    # taronja EMT
    cream = (243, 244, 248, 255)
    glass = (34, 40, 62, 255)
    dark = (24, 24, 30, 255)
    tyre = (32, 33, 38, 255)
    hub = (150, 156, 164, 255)
    head = (255, 214, 120, 255)

    # fons quadrat arrodonit
    d.rounded_rectangle(R(0, 0, 512, 512), radius=104 * k, fill=orange)

    # carrosseria del bus
    d.rounded_rectangle(R(70, 150, 442, 366), radius=44 * k, fill=cream,
                        outline=dark, width=int(6 * k))
    # franja fosca inferior
    d.rounded_rectangle(R(70, 322, 442, 366), radius=20 * k, fill=(210, 214, 222, 255))

    # finestres (tira)
    for x0 in (100, 178, 256, 334):
        d.rounded_rectangle(R(x0, 178, x0 + 60, 250), radius=12 * k, fill=glass)
    # parabrisa davanter
    d.rounded_rectangle(R(372, 178, 416, 262), radius=12 * k, fill=glass)

    # porta
    d.rounded_rectangle(R(120, 262, 176, 322), radius=8 * k, fill=(200, 206, 214, 255),
                        outline=dark, width=int(3 * k))

    # far davanter
    d.ellipse(R(420, 288, 440, 308), fill=head)

    # rodes
    for cx in (168, 356):
        d.ellipse(R(cx - 44, 340, cx + 44, 428), fill=tyre)
        d.ellipse(R(cx - 16, 368, cx + 16, 400), fill=hub)

    return img


def main():
    base = draw(512)
    here = os.path.dirname(os.path.abspath(__file__))
    base.save(os.path.join(here, "icon_preview.png"))
    dens = {"mdpi": 48, "hdpi": 72, "xhdpi": 96, "xxhdpi": 144, "xxxhdpi": 192}
    for name, px in dens.items():
        outdir = os.path.join(here, "res", f"mipmap-{name}")
        os.makedirs(outdir, exist_ok=True)
        ic = base.resize((px, px), Image.LANCZOS)
        ic.save(os.path.join(outdir, "ic_launcher.png"))
        ic.save(os.path.join(outdir, "ic_launcher_round.png"))
    print("iconos generados. preview:", os.path.join(here, "icon_preview.png"))


if __name__ == "__main__":
    main()
