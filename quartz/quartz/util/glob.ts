import path from "path"
import { FilePath } from "./path"
import { globby } from "globby"

export function toPosixPath(fp: string): string {
  return fp.split(path.sep).join("/")
}

export async function glob(
  pattern: string,
  cwd: string,
  ignorePatterns: string[],
): Promise<FilePath[]> {
  const fps = (
    await globby(pattern, {
      cwd,
      ignore: ignorePatterns,
      // SignalForge vendor patch (s96 #10): set to `false` (upstream default
      // is `true`). Upstream relies on `.gitignore` to filter scan inputs —
      // which silently drops auto-generated build artifacts that ARE meant
      // to be ingested by Quartz but should NOT be committed (e.g.
      // `docs/dashboard.md`, regenerated on every `npm run docs:build`).
      // Quartz's own `ignorePatterns` config in `quartz.config.ts` already
      // enumerates the deliberate exclusions; honoring gitignore on top of
      // it was a foot-gun masking real content as 404.
      gitignore: false,
    })
  ).map(toPosixPath)
  return fps as FilePath[]
}
