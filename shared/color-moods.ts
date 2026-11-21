export const colorMoodPalettes = {
  "自然柔和": ["鼠尾草绿、燕麦色、米白", "雾蓝、沙色、暖灰", "豆沙粉、浅驼、象牙白", "橄榄灰、亚麻色、奶油白", "灰紫、浅褐、珍珠白", "苔绿、稻草黄、浅米"],
  "清爽明亮": ["天蓝、柠檬黄、纯白", "薄荷绿、蜜桃色、云白", "湖蓝、杏黄、浅灰", "苹果绿、粉蓝、奶白", "珊瑚粉、水蓝、亮白", "丁香紫、青柠绿、雪白"],
  "沉稳经典": ["藏青、驼色、象牙白", "炭灰、酒红、暖白", "墨绿、巧克力棕、沙色", "深靛蓝、砖红、米白", "咖啡棕、海军蓝、燕麦色", "石墨灰、深紫、银灰"],
  "强烈对比": ["钴蓝、橙色、黑色", "正红、青绿、暖白", "紫罗兰、柠檬黄、炭黑", "玫红、孔雀蓝、米白", "宝蓝、荧光绿、深灰", "朱红、湖蓝、墨黑"],
} as const;

const englishPalettes: Record<keyof typeof colorMoodPalettes, readonly [string, string, string, string, string, string]> = {
  "自然柔和": ["sage green, oat, ivory", "mist blue, sand, warm grey", "dusty rose, light camel, ivory", "olive grey, linen, cream", "dusty lilac, taupe, pearl white", "moss green, straw yellow, pale beige"],
  "清爽明亮": ["sky blue, lemon yellow, pure white", "mint green, peach, cloud white", "lake blue, apricot, light grey", "apple green, powder blue, milk white", "coral pink, aqua, bright white", "lilac, lime green, snow white"],
  "沉稳经典": ["navy, camel, ivory", "charcoal grey, burgundy, warm white", "forest green, chocolate brown, sand", "dark indigo, brick red, off-white", "coffee brown, navy blue, oat", "graphite grey, deep purple, silver grey"],
  "强烈对比": ["cobalt blue, orange, black", "true red, teal, warm white", "violet, lemon yellow, charcoal black", "magenta, peacock blue, off-white", "royal blue, neon green, dark grey", "vermilion, lake blue, ink black"],
};

export function colorMoodPalette(mood: unknown, variant: unknown) {
  if (typeof mood !== "string" || !Object.hasOwn(colorMoodPalettes, mood)) return;
  const choices = colorMoodPalettes[mood as keyof typeof colorMoodPalettes];
  if (typeof variant !== "string" || !/^[0-5]$/.test(variant)) return;
  return { colors: choices[Number(variant)]!, englishColors: englishPalettes[mood as keyof typeof colorMoodPalettes][Number(variant)]!, next: String((Number(variant) + 1) % choices.length) };
}

export function findColorMoodPalette(mood: unknown, colors: unknown) {
  if (typeof mood !== "string" || !Object.hasOwn(colorMoodPalettes, mood) || typeof colors !== "string") return;
  const index = colorMoodPalettes[mood as keyof typeof colorMoodPalettes].findIndex(value => value === colors);
  return colorMoodPalette(mood, String(index));
}
