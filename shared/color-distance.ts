export type Lab = readonly [number, number, number];

/** sRGB (D65) to Lab; all matching colors use the same white point. */
export function hexToLab(hex: string): Lab {
    const text = hex.trim().replace(/^#/, "");
    const normalized = /^[a-f\d]{3}$/i.test(text) ? text.split("").map((value) => value + value).join("") : text;
    if (!/^[a-f\d]{6}$/i.test(normalized)) throw new Error("请输入有效的 HEX 颜色，例如 #8C4E63");
    const [r, g, b] = [0, 2, 4].map((offset) => {
        const value = parseInt(normalized.slice(offset, offset + 2), 16) / 255;
        return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    });
    const transform = (value: number) => value > 216 / 24389 ? Math.cbrt(value) : ((24389 / 27) * value + 16) / 116;
    const x = transform((0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047);
    const y = transform(0.2126729 * r + 0.7151522 * g + 0.072175 * b);
    const z = transform((0.0193339 * r + 0.119192 * g + 0.9503041 * b) / 1.08883);
    return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}

/** CIEDE2000, kL=kC=kH=1; verified with Sharma/Wu/Dalal reference pairs. */
export function deltaE2000(first: Lab, second: Lab): number {
    const [l1, a1, b1] = first;
    const [l2, a2, b2] = second;
    const radians = Math.PI / 180;
    const meanC = (Math.hypot(a1, b1) + Math.hypot(a2, b2)) / 2;
    const c7 = meanC ** 7;
    const g = 0.5 * (1 - Math.sqrt(c7 / (c7 + 25 ** 7)));
    const ap1 = (1 + g) * a1;
    const ap2 = (1 + g) * a2;
    const cp1 = Math.hypot(ap1, b1);
    const cp2 = Math.hypot(ap2, b2);
    const hue = (a: number, b: number) => a === 0 && b === 0 ? 0 : (Math.atan2(b, a) / radians + 360) % 360;
    const hp1 = hue(ap1, b1);
    const hp2 = hue(ap2, b2);
    const dl = l2 - l1;
    const dc = cp2 - cp1;
    let dh = hp2 - hp1;
    if (cp1 * cp2 === 0) dh = 0;
    else if (dh > 180) dh -= 360;
    else if (dh < -180) dh += 360;
    const dH = 2 * Math.sqrt(cp1 * cp2) * Math.sin(dh * radians / 2);
    const meanL = (l1 + l2) / 2;
    const meanCp = (cp1 + cp2) / 2;
    let meanH = hp1 + hp2;
    if (cp1 * cp2 !== 0) {
        if (Math.abs(hp1 - hp2) <= 180) meanH /= 2;
        else meanH = (meanH + (meanH < 360 ? 360 : -360)) / 2;
    }
    const t = 1 - 0.17 * Math.cos((meanH - 30) * radians) + 0.24 * Math.cos(2 * meanH * radians) + 0.32 * Math.cos((3 * meanH + 6) * radians) - 0.20 * Math.cos((4 * meanH - 63) * radians);
    const lightness = meanL - 50;
    const sl = 1 + 0.015 * lightness ** 2 / Math.sqrt(20 + lightness ** 2);
    const sc = 1 + 0.045 * meanCp;
    const sh = 1 + 0.015 * meanCp * t;
    const cp7 = meanCp ** 7;
    const rt = -2 * Math.sqrt(cp7 / (cp7 + 25 ** 7)) * Math.sin(60 * Math.exp(-(((meanH - 275) / 25) ** 2)) * radians);
    const lightnessTerm = dl / sl;
    const chromaTerm = dc / sc;
    const hueTerm = dH / sh;
    return Math.sqrt(Math.max(0, lightnessTerm ** 2 + chromaTerm ** 2 + hueTerm ** 2 + rt * chromaTerm * hueTerm));
}
