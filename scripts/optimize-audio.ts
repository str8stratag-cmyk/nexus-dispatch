import { optimizeAudio } from "../server/audio-optimizer";

async function main() {
  const [inputPath, outputPath] = process.argv.slice(2);

  if (!inputPath || !outputPath) {
    console.error("Usage: tsx scripts/optimize-audio.ts <input.wav> <output.wav>");
    process.exit(1);
  }

  try {
    await optimizeAudio({ inputPath, outputPath });
    console.log(`Optimized audio saved to ${outputPath}`);
  } catch (err: any) {
    console.error("Audio optimization failed:", err.message);
    process.exit(1);
  }
}

main();
