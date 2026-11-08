/**
 * Every Podman spelling that may differ between Podman versions (agent-sandbox design D14). Spike S12
 * (task 0.4, run on EC2) checks them against the installed Podman; a different spelling is an edit
 * of this file only. `podman-args.ts`, the launcher and the tests import these constants.
 */

/** `--mount` option for a read-only bind mount. */
export const MOUNT_RO = "ro";
/** `--mount` option for a read-write bind mount. */
export const MOUNT_RW = "rw";
export const MOUNT_NOSUID = "nosuid";
export const MOUNT_NODEV = "nodev";
/** Keeps host mount events out of the container and container mounts out of the host. */
export const MOUNT_PROPAGATION = "bind-propagation=rprivate";
/** SELinux `:z`: a label shared by every container that mounts the path (design D21). */
export const MOUNT_RELABEL_SHARED = "relabel=shared";
/** SELinux `:Z`: a label private to one container; only for paths exactly one container mounts. */
export const MOUNT_RELABEL_PRIVATE = "relabel=private";

/** Rootless pasta without the gateway-to-host-loopback mapping, IPv4 only (Requirement 7.1). */
export const NETWORK = "pasta:--no-map-gw,--ipv4-only";
/** Container uid and gid, and the user-namespace mapping that gives host files the runner's owner. */
export const CONTAINER_UID = 10001;
export const USER = `${CONTAINER_UID}:${CONTAINER_UID}`;
export const USERNS = `keep-id:uid=${CONTAINER_UID},gid=${CONTAINER_UID}`;

/** tmpfs mounts (Requirement 4.3): `/tmp` is also `noexec`. */
export const TMPFS_TMP = "/tmp:rw,nosuid,nodev,noexec,size=256m";
export const TMPFS_HOME = "/home/agent:rw,nosuid,nodev,size=256m";
export const CONTAINER_HOME = "/home/agent";
export const CONTAINER_TMP = "/tmp";

/** Where the Auth_Dir is mounted; the image entrypoint stages it into `$HOME` (Requirement 5.6). */
export const AUTH_MOUNT_POINT = "/run/seance/auth";
export const HOSTNAME = "seance-agent";
export const STOP_TIMEOUT_S = 2;

/** Labels (glossary: Sandbox_Labels). */
export const LABEL_SANDBOX = "io.seance.sandbox";
export const LABEL_WORKSPACES = "io.seance.workspaces";
export const LABEL_AGENT = "io.seance.agent";

/** The probe command inside the image and its exit codes (design "Image"). */
export const PROBE_COMMAND = "seance-probe";
export const PROBE_EXIT = {
  ok: 0,
  loopback: 10,
  metadata: 11,
  noNetcat: 12,
  egress: 13,
} as const;
