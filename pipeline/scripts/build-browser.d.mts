import type { Message, Metafile, OutputFile } from "esbuild";

export const DEFAULT_OUTFILE: string;

export interface BrowserBundle {
  outfile: string;
  bytes: number;
  gzipBytes: number;
  zodDir: string;
  warnings: Message[];
  metafile: Metafile;
  outputFiles: OutputFile[] | undefined;
  js: Buffer;
}

export function zodCopies(metafile: Metafile): string[];

export function buildBrowserBundle(options?: {
  outfile?: string;
  minify?: boolean;
  write?: boolean;
}): Promise<BrowserBundle>;
