import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export type BriefingWriteResult = { latestPath: string; datedPath: string };

// The one seam a future Supabase-backed writer would implement instead -- ranking and rendering
// never call fs directly, only this interface, so swapping persistence later means adding a new
// implementation here, not touching portfolio-ranking.ts or render-briefing.ts (task decision 3).
export type BriefingWriter = {
  write(date: string, markdown: string): Promise<BriefingWriteResult>;
};

export function createFileBriefingWriter(outputDir: string): BriefingWriter {
  return {
    async write(date, markdown) {
      await mkdir(outputDir, { recursive: true });
      const datedPath = path.join(outputDir, `${date}.md`);
      const latestPath = path.join(outputDir, "latest.md");
      await writeFile(datedPath, markdown, "utf8");
      await writeFile(latestPath, markdown, "utf8"); // n8n-compatible: a stable filename to raw-read regardless of date
      return { latestPath, datedPath };
    },
  };
}
