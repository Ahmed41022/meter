import math, os

CX = CY = 256.0
JADE_HI, JADE_LO = "#139A6F", "#0A5D43"
HUB = "#0A5238"

def polar(r, deg, cx=CX, cy=CY):
    t = math.radians(deg)
    return cx + r * math.cos(t), cy + r * math.sin(t)

def arc(r, a0, a1, w, color, opacity=1.0):
    x0, y0 = polar(r, a0); x1, y1 = polar(r, a1)
    large = 1 if (a1 - a0) % 360 > 180 else 0
    return (f'<path d="M {x0:.2f} {y0:.2f} A {r} {r} 0 {large} 1 {x1:.2f} {y1:.2f}" '
            f'fill="none" stroke="{color}" stroke-opacity="{opacity}" '
            f'stroke-width="{w}" stroke-linecap="round"/>')

START, SWEEP, FRAC = 140.0, 260.0, 0.62
R, W = 166.0, 46.0
HEAD = START + SWEEP * FRAC

def needle():
    half = 22.0
    bx1, by1 = polar(half, HEAD + 90)
    bx2, by2 = polar(half, HEAD - 90)
    tx, ty = polar(126, HEAD)
    return (f'<path d="M {bx1:.2f} {by1:.2f} L {tx:.2f} {ty:.2f} L {bx2:.2f} {by2:.2f} Z" '
            f'fill="#FFFFFF" stroke="#FFFFFF" stroke-width="10" stroke-linejoin="round"/>')

def build(pad=0.0, bg=True, rx=114):
    scale = 1.0 - pad
    p = ['<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">',
         '<defs><linearGradient id="g" x1="0" y1="0" x2="0.35" y2="1">'
         f'<stop offset="0" stop-color="{JADE_HI}"/><stop offset="1" stop-color="{JADE_LO}"/>'
         '</linearGradient></defs>']
    if bg:
        p.append(f'<rect width="512" height="512" rx="{rx}" fill="url(#g)"/>')
    p.append(f'<g transform="translate({CX} {CY + 10}) scale({scale}) translate({-CX} {-CY})">')
    p.append(arc(R, START, START + SWEEP, W, "#FFFFFF", 0.30))
    p.append(arc(R, START, HEAD, W, "#FFFFFF", 1.0))
    p.append(needle())
    p.append(f'<circle cx="{CX}" cy="{CY}" r="24" fill="{HUB}"/>')
    p.append('</g></svg>')
    return "\n".join(p)

os.makedirs("icons", exist_ok=True)
open("icons/icon.svg", "w").write(build())
open("icons/icon-maskable.svg", "w").write(build(pad=0.20))
print("wrote icons")
