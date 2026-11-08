/**
 * `SEANCE_SANDBOX_KIRO_BIN`: the command inside the image (review item 1). `/tmp` and `/home/agent`
 * are `noexec` tmpfs mounts and `/run/seance/auth` is the credential mount, so a program there
 * could never start; the command is a bare name found on the image's PATH (`/usr/local/bin`) or an
 * absolute path in the read-only image.
 */

const BARE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ABSOLUTE = /^\/[A-Za-z0-9._/-]{1,200}$/;
/** Locations that are tmpfs or credential mounts in the container; nothing can execute from them. */
const NOT_EXECUTABLE = ["/home/agent", "/tmp", "/run"] as const;

/** True when `value` is a bare command name or an absolute image path outside the noexec mounts. */
export function isSandboxKiroBin(value: string): boolean {
  if (BARE.test(value)) return true;
  if (!ABSOLUTE.test(value)) return false;
  const segments = value.split("/").slice(1);
  if (segments.some((s) => s === "" || s === "." || s === "..")) return false;
  return !NOT_EXECUTABLE.some((dir) => value === dir || value.startsWith(`${dir}/`));
}
