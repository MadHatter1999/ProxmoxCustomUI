export interface ClusterResource {
  id: string
  type: 'node' | 'qemu' | 'lxc' | 'storage' | 'sdn' | 'pool'
  node?: string
  name?: string
  status?: string
  vmid?: number
  template?: number
  cpu?: number
  maxcpu?: number
  mem?: number
  maxmem?: number
  disk?: number
  maxdisk?: number
  uptime?: number
  storage?: string
  content?: string
  shared?: number
  // Present (and truthy, e.g. "snapshot"/"rollback"/"backup") only while the
  // guest is locked by an in-flight or interrupted task. Proxmox omits it
  // otherwise. cluster/resources is polled every few seconds, so this stays live.
  lock?: string
}

export interface IsoVolume {
  volid: string
  size: number
  content: string
}

export interface TaskStatusInfo {
  upid: string
  status: 'running' | 'stopped'
  exitstatus?: string
  type: string
  node: string
}

export interface TaskLogLine {
  n: number
  t: string
}

export interface TrackedTask {
  upid: string
  node: string
  label: string
}
