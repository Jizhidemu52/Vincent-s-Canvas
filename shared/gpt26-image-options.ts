/** APIMart GPT Image 2.6 GIF contract; static-image pixel minimums do not apply. */
export function validateGpt26GifParameters(parameters: { size?: unknown; frame_count?: unknown; frame_duration_ms?: unknown }) {
  const count = parameters.frame_count ?? 9;
  const duration = parameters.frame_duration_ms ?? 200;
  if (typeof count !== "number" || !Number.isInteger(count) || count < 2 || count > 16) throw new Error("GIF 帧数必须为 2–16 的整数");
  if (typeof duration !== "number" || !Number.isSafeInteger(duration) || duration < 20 || duration % 10 !== 0) throw new Error("GIF 每帧时长至少 20 毫秒，且须为 10 毫秒的整数倍");
  const size = parameters.size === undefined ? "auto" : parameters.size;
  const pixels = typeof size === "string" ? /^([1-9]\d*)x([1-9]\d*)$/.exec(size) : null;
  if (size !== "auto" && !pixels) throw new Error("GIF 尺寸须为 auto 或单帧像素尺寸，例如 512x512，不能使用宽高比");
  const width = pixels ? Number(pixels[1]) : 512, height = pixels ? Number(pixels[2]) : 512;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width % 16 !== 0 || height % 16 !== 0) throw new Error("GIF 单帧宽高须为正整数且均为 16 的倍数");
  const [columns, rows] = count <= 8 ? [4, 2] : count === 9 ? [3, 3] : count <= 12 ? [4, 3] : [4, 4];
  const fits = (x: number, y: number) => {
    const sheetWidth = width * x, sheetHeight = height * y;
    return Math.max(sheetWidth, sheetHeight) <= 3840 && sheetWidth * sheetHeight <= 8_294_400
      && Math.max(sheetWidth, sheetHeight) / Math.min(sheetWidth, sheetHeight) <= 3;
  };
  if (!fits(columns!, rows!) && !fits(rows!, columns!)) throw new Error("GIF 帧拼图超出限制：单边最多 3840、总像素最多 8294400、比例不超过 3:1；请缩小单帧尺寸或减少帧数");
  return { size: size as string, frame_count: count, frame_duration_ms: duration };
}
