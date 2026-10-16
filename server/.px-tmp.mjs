import sharp from "sharp";
const { data, info } = await sharp(process.argv[2]).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
let red = 0; for (let i = 0; i < data.length; i += 4) if (data[i] > 200 && data[i + 1] < 60 && data[i + 2] < 60) red++;
const o = (5 * info.width + 5) * 4;
console.log("rot:", red, "Ecke alpha:", data[o + 3]);
