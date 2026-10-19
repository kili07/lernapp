#!/usr/bin/env python3
"""App-Icons für die Lernapp erzeugen: Karteikarten-Stapel, weiß auf #1B1B1B.

Zwei Karten übereinander, die hintere leicht gedreht, auf der vorderen ein
Häkchen — „gelernt“. Groß zeichnen (SS-fach) und verkleinern, sonst werden
die Kanten stufig. Farbe und Motivgröße stehen oben und lassen sich in einer
Zeile ändern.

Aufruf:  python3 icons/make-icons.py
"""
import math
from pathlib import Path
from PIL import Image, ImageDraw

BG = (0x1B, 0x1B, 0x1B, 255)
FG = (0xFF, 0xFF, 0xFF, 255)
SS = 4                      # Überabtastung

# Motivbreite relativ zur Kantenlänge (siehe Bauanleitung 5.14)
ANY_W = 0.45
MASKABLE_W = 0.32

HERE = Path(__file__).resolve().parent


def rounded_rect_poly(cx, cy, w, h, r, angle_deg, steps=10):
    """Abgerundetes Rechteck als Polygon, um den Mittelpunkt gedreht."""
    pts = []
    corners = [(w / 2 - r, -h / 2 + r, -90), (w / 2 - r, h / 2 - r, 0), (-w / 2 + r, h / 2 - r, 90), (-w / 2 + r, -h / 2 + r, 180)]
    for (x, y, start) in corners:
        for i in range(steps + 1):
            a = math.radians(start + 90 * i / steps)
            pts.append((x + r * math.cos(a), y + r * math.sin(a)))
    t = math.radians(angle_deg)
    return [(cx + x * math.cos(t) - y * math.sin(t), cy + x * math.sin(t) + y * math.cos(t)) for x, y in pts]


def motif(img, cx, cy, w):
    d = ImageDraw.Draw(img)
    h = w * 0.68
    r = w * 0.09
    stroke = w * 0.075
    # Hintere Karte: nur Umriss, gedreht und versetzt
    back = rounded_rect_poly(cx + w * 0.07, cy - h * 0.16, w * 0.9, h * 0.9, r, -9)
    d.polygon(back, fill=FG)
    inner = rounded_rect_poly(cx + w * 0.07, cy - h * 0.16, w * 0.9 - 2 * stroke, h * 0.9 - 2 * stroke, max(1, r - stroke), -9)
    d.polygon(inner, fill=BG)
    # Vordere Karte: gefüllt, mit Rand zum Hintergrund, damit sie sich abhebt
    front_out = rounded_rect_poly(cx - w * 0.04, cy + h * 0.12, w * 0.9 + stroke * 1.6, h * 0.9 + stroke * 1.6, r + stroke * 0.8, 0)
    d.polygon(front_out, fill=BG)
    front = rounded_rect_poly(cx - w * 0.04, cy + h * 0.12, w * 0.9, h * 0.9, r, 0)
    d.polygon(front, fill=FG)
    # Häkchen in Hintergrundfarbe auf der vorderen Karte
    fx, fy = cx - w * 0.04, cy + h * 0.12
    s = w * 0.2
    d.line([(fx - s * 0.95, fy + s * 0.02), (fx - s * 0.25, fy + s * 0.68), (fx + s * 1.05, fy - s * 0.62)],
           fill=BG, width=int(stroke * 1.15), joint='curve')
    for (x, y) in [(fx - s * 0.95, fy + s * 0.02), (fx + s * 1.05, fy - s * 0.62)]:
        rr = stroke * 0.575
        d.ellipse([x - rr, y - rr, x + rr, y + rr], fill=BG)


def make(size, motif_w, name):
    big = size * SS
    img = Image.new('RGBA', (big, big), BG)
    motif(img, big / 2, big / 2, big * motif_w)
    img = img.resize((size, size), Image.LANCZOS)
    img.convert('RGB').save(HERE / name, optimize=True)
    print('geschrieben:', name)


if __name__ == '__main__':
    make(192, ANY_W, 'icon-192.png')
    make(512, ANY_W, 'icon-512.png')
    make(512, MASKABLE_W, 'icon-maskable-512.png')
