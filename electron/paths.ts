import path from 'node:path'
import { app } from 'electron'

/**
 * Returns the correct path to platform binaries.
 * 
 * In DEV mode (npm run dev):
 *   → <projectRoot>/resources/bin/<platform>/
 * 
 * In PRODUCTION (packaged app):
 *   → <app>/Contents/Resources/bin/<platform>/  (extraResources)
 */
export function getBinDir(platform: 'mac' | 'win'): string {
  if (app.isPackaged) {
    // Production: extraResources copies to Contents/Resources/bin/
    return path.join(process.resourcesPath, 'bin', platform)
  } else {
    // Dev: files are in project root
    return path.join(process.env.APP_ROOT!, 'resources', 'bin', platform)
  }
}

/**
 * Returns a writable directory for runtime files (configs, temp scripts).
 * Always uses userData which is writable in both dev and production.
 */
export function getWritableDir(): string {
  return app.getPath('userData')
}
