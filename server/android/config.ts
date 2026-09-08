import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

/**
 * Everything the Android subsystem can be told, in one place.
 *
 * All of it has a working default, and every default is inert: with no env set
 * at all the subsystem loads, serves its registries, and reports "no nodes are
 * running the Android agent yet". It never touches the cluster on its own.
 */
export const androidConfig = {
  /** Built-in registry data (images, profiles, form factors, networks). */
  dataDir: process.env.ANDROID_DATA_DIR ?? path.join(here, 'data'),

  /**
   * Writable overlay: admin-imported images, user-saved hardware profiles, the
   * device registry, node heartbeats and the audit log. Kept outside the repo
   * so an app update never overwrites the lab's own catalogue.
   */
  stateDir: process.env.ANDROID_STATE_DIR ?? path.resolve(here, '..', '..', '.android-state'),

  /**
   * Shared secret every node agent signs its heartbeat with, and that the
   * controller uses to call back into an agent. Unset = agents are refused and
   * the subsystem stays registry-only.
   */
  agentToken: process.env.ANDROID_AGENT_TOKEN ?? '',

  /** Port the node agent listens on. Only ever reached from the controller. */
  agentPort: Number(process.env.ANDROID_AGENT_PORT ?? 9599),

  /** A node with no heartbeat for this long is treated as gone. */
  agentStaleMs: Number(process.env.ANDROID_AGENT_STALE_MS ?? 60_000),

  /** In-memory devices with no hardware behind them, for offline development. */
  mock: process.env.ANDROID_MOCK === '1',

  /** Proxmox bridge QEMU Android devices attach to. */
  bridge: process.env.ANDROID_BRIDGE ?? 'vmbr0',

  /** VMIDs for Android VMs are allocated from Proxmox's nextid like any other. */
  vmNamePrefix: process.env.ANDROID_VM_PREFIX ?? 'android-',

  /** How long a device may sit reserved before the reaper releases it. */
  reservationTtlMs: Number(process.env.ANDROID_RESERVATION_TTL_MS ?? 4 * 60 * 60 * 1000),

  /** How long to wait for Android to finish booting before calling it failed. */
  bootTimeoutMs: Number(process.env.ANDROID_BOOT_TIMEOUT_MS ?? 10 * 60 * 1000),

  /** Screen polling cadence for the fallback (screencap) remote view. */
  screenIntervalMs: Number(process.env.ANDROID_SCREEN_INTERVAL_MS ?? 400),

  /** Never let a disposable device outlive this, whatever anyone forgets. */
  disposableMaxAgeMs: Number(process.env.ANDROID_DISPOSABLE_MAX_AGE_MS ?? 24 * 60 * 60 * 1000)
}

export type AndroidConfig = typeof androidConfig
